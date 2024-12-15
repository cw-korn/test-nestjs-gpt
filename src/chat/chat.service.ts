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
  schools: any;

  constructor(private configService: ConfigService) {
    try {
      const apiKey = this.configService.get<string>('OPENAI_API_KEY');
      const directusUrl = this.configService.get<string>('DIRECTUS_URL');
      const directusToken = this.configService.get<string>('DIRECTUS_TOKEN');
      this.assistantId = this.configService.get<string>('ASSISTANT_ID');

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

  private constructSqlQuery(collection: string, query?: Record<string, any>): string {
    let sqlQuery = `SELECT * FROM ${collection}`;

    if (query?.filter) {
      sqlQuery += '\nWHERE ' + JSON.stringify(query.filter, null, 2);
    }
    if (query?.sort) {
      const sortClauses = query.sort.map((s: string) => {
        if (s.startsWith('-')) {
          return `${s.substring(1)} DESC`;
        }
        return `${s} ASC`;
      });
      sqlQuery += '\nORDER BY ' + sortClauses.join(', ');
    }
    if (query?.limit) {
      sqlQuery += '\nLIMIT ' + query.limit;
    }

    return sqlQuery;
  }

  private async queryDatabase(
    collection: keyof DirectusSchema,
    query?: Record<string, any>
  ): Promise<any> {
    try {
      console.log('\n=== Database Query Request ===');
      console.log('Collection:', collection);
      console.log('Query parameters:', JSON.stringify(query, null, 2));
      console.log('\n=== Equivalent SQL Query ===');
      console.log(this.constructSqlQuery(collection, query));
  
      // Transform the query to use proper Directus filter syntax
      const transformedQuery: Record<string, any> = {
        limit: 10
      };
  
      if (query) {
        // Handle any direct key-value pairs as equality filters
        const filter = {};
        
        // Handle any direct key-value pairs with special handling for relationships
        Object.entries(query).forEach(([key, value]) => {
          if (!['filter', 'sort', 'limit', 'fields'].includes(key)) {
            if (key === 'school_id' && collection !== 'exam_ai_schools') {
              // For related collections, we need the numeric id from the schools table
              const schoolId = typeof value === 'string' && value.includes('-') 
                ? this.getSchoolNumericId(value)  // This would be a UUID
                : value;  // This would be already numeric
              filter[key] = { _eq: schoolId };
            } else {
              // Use _contains for strings, _eq for other types
              filter[key] = typeof value === 'string'
                ? { _contains: value }
                : { _eq: value };
            }
          }
        });
  
        // Merge with any existing filter in the query
        if (Object.keys(filter).length > 0 || query.filter) {
          // Handle school_id in filter object for related collections
          if (query.filter?.school_id && collection !== 'exam_ai_schools') {
            const value = query.filter.school_id._eq || query.filter.school_id;
            const schoolId = typeof value === 'string' && value.includes('-')
              ? this.getSchoolNumericId(value)
              : value;
            query.filter.school_id = { _eq: schoolId };
          }
          
          transformedQuery.filter = {
            ...filter,
            ...query.filter
          };
        }
  
        // Pass through other valid query parameters
        if (query.sort) transformedQuery.sort = query.sort;
        if (query.limit) transformedQuery.limit = query.limit;
        if (query.fields) transformedQuery.fields = query.fields;
      }
  
      console.log('Transformed query:', JSON.stringify(transformedQuery, null, 2));
  
      let items;
  
      if (collection === 'exam_ai_school_applicant_summaries') {
        const response = await readItems(collection as never, transformedQuery);
        items = await this.directus.request(response);
  
        if (items.length > 0) {
          const schoolIds = [...new Set(items.map(item => item.school_id))];
          const schoolsResponse = await readItems('exam_ai_schools' as never, {
            filter: {
              id: { _in: schoolIds }
            }
          });
          const schools = await this.directus.request(schoolsResponse);
  
          items = items.map(item => ({
            ...item,
            school_info: schools.find(school => school.id === item.school_id)
          }));
        }
      } else {
        const response = await readItems(collection as never, transformedQuery);
        items = await this.directus.request(response);
      }
  
      console.log('\n=== Query Results ===');
      console.log('Number of results:', Array.isArray(items) ? items.length : 1);
      console.log('First result sample:', JSON.stringify(items[0], null, 2));
      return items;
  
    } catch (error) {
      console.error('Database query error:', error);
      throw new Error(`Failed to query database: ${error.message}`);
    }
  }
  
  // Helper method to get the numeric ID for a school
  private getSchoolNumericId(uuid: string): number {
    // If we already have the mapping from the previous schools query
    const schoolDetails = this.schools?.find(school => school.school_id === uuid);
    if (schoolDetails) {
      return schoolDetails.id;
    }
    
    // If not found, return a numeric value that won't match anything
    // This is safer than throwing an error as the query will just return no results
    return -1;
  }

  async generateResponse(prompt: string): Promise<string> {
    try {
      console.log('\n=== New Request ===');
      console.log('Received prompt:', prompt);

      const thread = await this.openai.beta.threads.create();
      console.log('\n=== Thread Created ===');
      console.log('Thread ID:', thread.id);

      await this.openai.beta.threads.messages.create(thread.id, {
        role: 'user',
        content: prompt,
      });

      const run = await this.openai.beta.threads.runs.create(thread.id, {
        assistant_id: this.assistantId,
        tools: [
          {
            type: 'function',
            function: {
              name: 'queryDatabase',
              description: 'Query the school database collections. Details and summaries collections reference the numeric id from exam_ai_schools.',
              parameters: {
                type: 'object',
                properties: {
                  collection: {
                    type: 'string',
                    description: 'The collection to query. Start with exam_ai_schools to get the school info before querying other collections.',
                    enum: ['exam_ai_schools', 'exam_ai_school_details', 'exam_ai_school_applicant_summaries']
                  },
                  query: {
                    type: 'object',
                    description: 'Query parameters. For school details and summaries, use the numeric id from exam_ai_schools collection.',
                    required: ['filter'],
                    properties: {
                      filter: {
                        type: 'object',
                        description: 'Filter conditions. For exam_ai_school_details and exam_ai_school_applicant_summaries, use the numeric id from exam_ai_schools.',
                        properties: {
                          name: {
                            type: 'string',
                            description: 'School name (only for exam_ai_schools collection)'
                          },
                          school_id: {
                            type: 'number',
                            description: 'Numeric id from exam_ai_schools.id field for exam_ai_school_details and exam_ai_school_applicant_summaries.'
                          },
                          year: {
                            type: 'number',
                            description: 'Academic year (for exam_ai_school_applicant_summaries)'
                          }
                        }
                      },
                      sort: {
                        type: 'array',
                        items: { type: 'string' }
                      },
                      limit: {
                        type: 'number',
                        default: 10
                      }
                    }
                  }
                },
                required: ['collection', 'query']
              }
            }
          }
        ]
      });

      console.log('\n=== Run Started ===');
      console.log('Run ID:', run.id);

      let response = await this.openai.beta.threads.runs.retrieve(thread.id, run.id);

      while (response.status === 'in_progress' || response.status === 'requires_action') {
        if (response.status === 'requires_action') {
          console.log('\n=== Tool Calls from Assistant ===');
          const toolCalls = response.required_action?.submit_tool_outputs.tool_calls;
          console.log(JSON.stringify(toolCalls, null, 2));

          const toolOutputs = [];

          for (const toolCall of toolCalls || []) {
            if (toolCall.function.name === 'queryDatabase') {
              const args = JSON.parse(toolCall.function.arguments);
              console.log('\n=== Processing Tool Call ===');
              console.log('Function:', toolCall.function.name);
              console.log('Arguments:', JSON.stringify(args, null, 2));

              const result = await this.queryDatabase(args.collection, args.query);

              toolOutputs.push({
                tool_call_id: toolCall.id,
                output: JSON.stringify(result)
              });
            }
          }

          console.log('\n=== Submitting Tool Outputs ===');
          console.log('Number of outputs:', toolOutputs.length);
          console.log('Tool outputs being submitted:', JSON.stringify(toolOutputs, null, 2));

          await this.openai.beta.threads.runs.submitToolOutputs(thread.id, run.id, {
            tool_outputs: toolOutputs
          });
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
        response = await this.openai.beta.threads.runs.retrieve(thread.id, run.id);
        console.log('\n=== Run Status Update ===');
        console.log('Status:', response.status);
      }

      const messages = await this.openai.beta.threads.messages.list(thread.id);
      const assistantMessage = messages.data.find(message => message.role === 'assistant');

      if (!assistantMessage || !assistantMessage.content.length) {
        throw new Error('No response received from assistant');
      }

      const content = assistantMessage.content[0];

      if ('text' in content) {
        console.log('\n=== Final Response ===');
        console.log('Assistant response:', content.text.value);
        return content.text.value;
      }

      throw new Error('Unexpected response format from assistant');

    } catch (error) {
      console.error('\n=== Error ===');
      console.error('Error in generateResponse:', error);
      throw new InternalServerErrorException(
        error.message || 'Error processing your request'
      );
    }
  }
}