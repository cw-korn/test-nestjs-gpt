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
      console.log(`Querying collection: ${collection}`, { operation, query });
      
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

      if (collection === 'exam_ai_school_applicant_summaries') {
        const response = await readItems(collection as never, queryParams);
        const items = await this.directus.request(response);

        const schoolIds = [...new Set(items.map(item => item.school_id))];
        const schoolsResponse = await readItems('exam_ai_schools' as never, {
          filter: { id: { _in: schoolIds } }
        });
        const schools = await this.directus.request(schoolsResponse);

        const result = items.map(item => ({
          ...item,
          school_info: schools.find(school => school.id === item.school_id)
        }));

        if (operation === 'compare' && query?.compare) {
          return {
            type: 'comparison',
            fields: query.compare.fields,
            data: result
          };
        }

        if (operation === 'aggregate' && query?.groupBy) {
          // Implement aggregation logic here
          return {
            type: 'aggregation',
            groupBy: query.groupBy,
            data: result
          };
        }

        return result;
      }

      const response = await readItems(collection as never, queryParams);
      return this.directus.request(response);

    } catch (error) {
      console.error('Database query error:', error);
      throw new Error(`Failed to query database: ${error.message}`);
    }
  }

  async generateResponse(prompt: string): Promise<string> {
    try {
      const thread = await this.openai.beta.threads.create();
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
                  description: 'The database collection to query'
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
                        // exam_ai_schools filters
                        school_id: { type: 'string', description: 'School identifier' },
                        name: { type: 'string', description: 'School name' },
                        details: { type: 'string', description: 'School details' },
                        district: { type: 'string', description: 'School district' },
                        province: { type: 'string', description: 'School province' },
        
                        // exam_ai_school_details filters
                        type: { type: 'string', description: 'Type of program or examination' },
                        exam_date: { type: 'string', description: 'Date of examination' },
                        result_date: { type: 'string', description: 'Result announcement date' },
                        report_date: { type: 'string', description: 'Reporting date' },
                        open_application_date: { type: 'string', description: 'Application opening date' },
                        close_application_date: { type: 'string', description: 'Application closing date' },
                        orientation_date: { type: 'string', description: 'Orientation date' },
                        exam_location: { type: 'string', description: 'Exam location' },
                        display_order: { type: 'number', description: 'Display order' },
        
                        // exam_ai_school_applicant_summaries filters
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
                    },
                    groupBy: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Fields to group by'
                    },
                    compare: {
                      type: 'object',
                      properties: {
                        fields: { 
                          type: 'array', 
                          items: { type: 'string' },
                          description: 'Fields to compare'
                        },
                        between: { 
                          type: 'array', 
                          items: { type: 'string' },
                          description: 'Values to compare between'
                        }
                      }
                    }
                  }
                }
              },
              required: ['collection']
            }
          }
        }]
      });

      let response = await this.openai.beta.threads.runs.retrieve(thread.id, run.id);
      
      while (response.status === 'in_progress' || response.status === 'requires_action') {
        if (response.status === 'requires_action') {
          const toolCalls = response.required_action?.submit_tool_outputs.tool_calls;
          const toolOutputs = [];

          for (const toolCall of toolCalls || []) {
            if (toolCall.function.name === 'queryDatabase') {
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
      }

      const messages = await this.openai.beta.threads.messages.list(thread.id);
      const assistantMessage = messages.data.find(message => message.role === 'assistant');

      if (!assistantMessage?.content.length) {
        throw new Error('No response received from assistant');
      }

      const content = assistantMessage.content[0];
      if ('text' in content) {
        return content.text.value;
      }

      throw new Error('Unexpected response format from assistant');

    } catch (error) {
      console.error('Error in generateResponse:', error);
      throw new InternalServerErrorException(error.message || 'Error processing your request');
    }
  }
}