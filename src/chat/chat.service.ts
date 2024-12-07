import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { createDirectus, rest, readItems, authentication, staticToken } from '@directus/sdk';
import type { RestClient } from '@directus/sdk';
import { DirectusSchema } from '../types/directus';

@Injectable()
export class ChatService {
  private openai: OpenAI;
  private directus: RestClient<DirectusSchema>;
  private readonly assistantId: string;

  constructor(private configService: ConfigService) {
    try {
      const apiKey = this.configService.get<string>('OPENAI_API_KEY');
      const directusUrl = this.configService.get<string>('DIRECTUS_URL');
      const directusToken = this.configService.get<string>('DIRECTUS_TOKEN');
      this.assistantId = this.configService.get<string>('ASSISTANT2_ID');

      if (!apiKey || !directusUrl || !directusToken || !this.assistantId) {
        throw new Error('Missing required environment variables');
      }

      this.openai = new OpenAI({ apiKey });
      this.directus = createDirectus<DirectusSchema>(directusUrl)
        .with(authentication())
        .with(staticToken(directusToken))
        .with(rest());

    } catch (error) {
      console.error('Initialization Error:', error);
      throw error;
    }
  }

  private async queryDatabase(
    collection: keyof DirectusSchema,
    operation: string = 'select',
    query?: {
      filter?: Record<string, any>;
      sort?: string[];
      fields?: string[];
      groupBy?: string[];
      compare?: {
        fields: string[];
        between: string[];
      };
    }
  ): Promise<any> {
    try {
      console.log('\n=== Query Database Called ===');
      console.log('Collection:', collection);
      console.log('Operation:', operation);
      console.log('Query Object:', JSON.stringify(query, null, 2));
      
      const queryParams: any = { limit: 10 };
      
      if (query?.filter) {
        queryParams.filter = query.filter;
      }
      if (query?.sort) {
        queryParams.sort = query.sort;
      }
      if (query?.fields) {
        queryParams.fields = query.fields;
      }

      console.log('Final Query Parameters:', JSON.stringify(queryParams, null, 2));

      // Handle queries that need school_details data
      const detailFields = ['exam_date', 'result_date', 'report_date', 'open_application_date', 'close_application_date', 'orientation_date', 'exam_location'];
      if (query?.fields?.some(field => detailFields.includes(field))) {
        console.log('\n=== Handling School Details Query ===');
        
        const schoolResponse = await readItems('exam_ai_schools' as never, {
          fields: ['id', 'name']
        });
        const schools = await this.directus.request(schoolResponse);
        console.log('Schools Data:', JSON.stringify(schools, null, 2));

        const detailsResponse = await readItems('exam_ai_school_details' as never, {
          fields: ['school_id', ...query.fields.filter(f => f !== 'name')]
        });
        const details = await this.directus.request(detailsResponse);
        console.log('Details Data:', JSON.stringify(details, null, 2));

        const result = schools.map(school => {
          const schoolDetails = details.find(d => d.school_id === school.id);
          const result: Record<string, any> = { name: school.name };
          query.fields.forEach(field => {
            if (field !== 'name') {
              result[field] = schoolDetails?.[field] || null;
            }
          });
          return result;
        });

        console.log('Combined Result:', JSON.stringify(result, null, 2));
        return result;
      }

      // Handle applicant summaries with school info
      if (collection === 'exam_ai_school_applicant_summaries') {
        console.log('\n=== Handling Applicant Summaries Query ===');
        
        const response = await readItems(collection as never, queryParams);
        const items = await this.directus.request(response);
        console.log('Initial Applicant Data:', JSON.stringify(items, null, 2));

        const schoolIds = [...new Set(items.map(item => item.school_id))];
        console.log('School IDs to fetch:', schoolIds);

        const schoolsResponse = await readItems('exam_ai_schools' as never, {
          filter: { id: { _in: schoolIds } }
        });
        const schools = await this.directus.request(schoolsResponse);
        console.log('Schools Data:', JSON.stringify(schools, null, 2));

        const result = items.map(item => ({
          ...item,
          school_info: schools.find(school => school.id === item.school_id)
        }));

        if (operation === 'compare' && query?.compare) {
          console.log('\n=== Processing Comparison Operation ===');
          return {
            type: 'comparison',
            fields: query.compare.fields,
            data: result
          };
        }

        if (operation === 'aggregate' && query?.groupBy) {
          console.log('\n=== Processing Aggregation Operation ===');
          return {
            type: 'aggregation',
            groupBy: query.groupBy,
            data: result
          };
        }

        console.log('Final Result:', JSON.stringify(result, null, 2));
        return result;
      }

      // Default single collection query
      console.log('\n=== Executing Simple Query ===');
      const response = await readItems(collection as never, queryParams);
      const result = await this.directus.request(response);
      console.log('Query Result:', JSON.stringify(result, null, 2));
      return result;

    } catch (error) {
      console.error('\n=== Database Query Error ===');
      console.error('Error details:', error);
      throw new Error(`Failed to query database: ${error.message}`);
    }
  }

  private formatResponse(data: any): string {
    console.log('\n=== Formatting Response ===');
    console.log('Raw data:', JSON.stringify(data, null, 2));
    
    try {
      if (typeof data === 'string') {
        const parsed = JSON.parse(data);
        const formatted = JSON.stringify(parsed, null, 2);
        console.log('Formatted response:', formatted);
        return formatted;
      }
      const formatted = JSON.stringify(data, null, 2);
      console.log('Formatted response:', formatted);
      return formatted;
    } catch (error) {
      console.error('Formatting error:', error);
      return data;
    }
  }

  async generateResponse(prompt: string): Promise<string> {
    try {
      console.log('\n=== Generate Response Started ===');
      console.log('Received prompt:', prompt);

      const thread = await this.openai.beta.threads.create();
      console.log('Created thread:', thread.id);

      await this.openai.beta.threads.messages.create(thread.id, {
        role: 'user',
        content: prompt,
      });

      const run = await this.openai.beta.threads.runs.create(thread.id, {
        assistant_id: this.assistantId,
        tools: [{
          type: 'function',
          function: {
            name: 'queryDatabase',
            description: 'Query the school database with advanced features',
            parameters: {
              type: 'object',
              properties: {
                collection: {
                  type: 'string',
                  enum: ['exam_ai_schools', 'exam_ai_school_details', 'exam_ai_school_applicant_summaries'],
                  description: 'Choose collection based on data needed: schools for basic info, school_details for exam/dates, applicant_summaries for statistics'
                },
                operation: {
                  type: 'string',
                  enum: ['select', 'compare', 'aggregate'],
                  description: 'Type of operation to perform',
                  default: 'select'
                },
                query: {
                  type: 'object',
                  properties: {
                    filter: {
                      type: 'object',
                      description: 'Filter conditions',
                      properties: {
                        school_id: { type: 'string', description: 'School identifier' },
                        name: { type: 'string', description: 'School name' },
                        details: { type: 'string', description: 'School details' },
                        district: { type: 'string', description: 'School district' },
                        province: { type: 'string', description: 'School province' },
                        type: { type: 'string', description: 'Type of class' },
                        exam_date: { type: 'string', description: 'Date of examination' },
                        result_date: { type: 'string', description: 'Result announcement date' },
                        report_date: { type: 'string', description: 'Reporting date' },
                        open_application_date: { type: 'string', description: 'Application opening date' },
                        close_application_date: { type: 'string', description: 'Application closing date' },
                        orientation_date: { type: 'string', description: 'Orientation date' },
                        exam_location: { type: 'string', description: 'Exam location' },
                        display_order: { type: 'number', description: 'Display order' },
                        program: { type: 'string', description: 'Program name' },
                        year: { type: 'number', description: 'Academic year' },
                        in_district_quota: { type: 'number', description: 'In-district quota' },
                        out_district_quota: { type: 'number', description: 'Out-of-district quota' },
                        special_district_quota: { type: 'number', description: 'Special district quota' },
                        in_district_applicants: { type: 'number', description: 'In-district applicant count' },
                        out_district_applicants: { type: 'number', description: 'Out-of-district applicant count' },
                        special_applicants: { type: 'number', description: 'Special applicant count' },
                        in_district_pass_rate: { type: 'number', description: 'In-district pass rate' },
                        out_district_pass_rate: { type: 'number', description: 'Out-of-district pass rate' },
                        special_condition_pass_rate: { type: 'number', description: 'Special condition pass rate' }
                      }
                    },
                    sort: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Sorting instructions'
                    },
                    fields: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Fields to return'
                    }
                  }
                }
              },
              required: ['collection']
            }
          }
        }]
      });

      console.log('Started run:', run.id);
      let response = await this.openai.beta.threads.runs.retrieve(thread.id, run.id);
      
      while (response.status === 'in_progress' || response.status === 'requires_action') {
        if (response.status === 'requires_action') {
          console.log('\n=== Processing Function Calls ===');
          const toolCalls = response.required_action?.submit_tool_outputs.tool_calls;
          const toolOutputs = [];

          for (const toolCall of toolCalls || []) {
            if (toolCall.function.name === 'queryDatabase') {
              console.log('Function call arguments:', toolCall.function.arguments);
              const args = JSON.parse(toolCall.function.arguments);
              const result = await this.queryDatabase(
                args.collection,
                args.operation,
                args.query
              );
              toolOutputs.push({
                tool_call_id: toolCall.id,
                output: JSON.stringify(result)
              });
            }
          }

          await this.openai.beta.threads.runs.submitToolOutputs(thread.id, run.id, {
            tool_outputs: toolOutputs
          });
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
        response = await this.openai.beta.threads.runs.retrieve(thread.id, run.id);
        console.log('Run status:', response.status);
      }

      console.log('\n=== Getting Final Response ===');
      const messages = await this.openai.beta.threads.messages.list(thread.id);
      const assistantMessage = messages.data.find(message => message.role === 'assistant');

      if (!assistantMessage?.content.length) {
        throw new Error('No response received from assistant');
      }

      const content = assistantMessage.content[0];
      if ('text' in content) {
        return this.formatResponse(content.text.value);
      }

      throw new Error('Unexpected response format from assistant');

    } catch (error) {
      console.error('\n=== Error in Generate Response ===');
      console.error('Error details:', error);
      throw new InternalServerErrorException(error.message || 'Error processing your request');
    }
  }
}