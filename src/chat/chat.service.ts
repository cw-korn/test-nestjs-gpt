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
      
      let items;
      
      if (collection === 'exam_ai_school_applicant_summaries') {
        // Get applicant data
        const response = await readItems(collection as never, {
          ...query,
          limit: 10
        });
        items = await this.directus.request(response);

        // Get school names
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

        console.log('\n=== Join Query for Schools ===');
        console.log(`SELECT * FROM exam_ai_schools WHERE id IN (${schoolIds.join(', ')})`);
      } else {
        const response = await readItems(collection as never, {
          ...query,
          limit: 10
        });
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
              description: 'Query the school database collections',
              parameters: {
                type: 'object',
                properties: {
                  collection: {
                    type: 'string',
                    description: 'The collection to query (exam_ai_schools, exam_ai_school_details, or exam_ai_school_applicant_summaries)',
                    enum: ['exam_ai_schools', 'exam_ai_school_details', 'exam_ai_school_applicant_summaries']
                  },
                  query: {
                    type: 'object',
                    description: 'Query parameters (filter, sort, etc.)',
                    properties: {
                      filter: {
                        type: 'object',
                        description: 'Filter conditions'
                      },
                      sort: {
                        type: 'array',
                        description: 'Sorting instructions',
                        items: {
                          type: 'string'
                        }
                      },
                      limit: {
                        type: 'number',
                        description: 'Maximum number of items to return'
                      },
                      fields: {
                        type: 'array',
                        description: 'Fields to return',
                        items: {
                          type: 'string'
                        }
                      }
                    }
                  }
                },
                required: ['collection']
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