// src/chat/chat.service.ts
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
      
      // Initialize Directus client using existing Schema
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
    query?: Record<string, any>
  ): Promise<any> {
    try {
      console.log(`Querying collection: ${collection}`, query);
      
      const response = await readItems(collection as never, {
        ...query,
        limit: 10
      });
      
      const items = await this.directus.request(response);
      console.log('Query result:', items);
      return items;
      
    } catch (error) {
      console.error('Database query error:', error);
      throw new Error(`Failed to query database: ${error.message}`);
    }
  }

  async generateResponse(prompt: string): Promise<string> {
    try {
      console.log('Received prompt:', prompt);

      // Create a thread
      const thread = await this.openai.beta.threads.create();
      console.log('Created thread:', thread.id);

      // Add the message to thread
      await this.openai.beta.threads.messages.create(thread.id, {
        role: 'user',
        content: prompt,
        metadata: { language: "Thai" }
      });

      // Run the assistant with database function
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
                          type: 'string',
                          description: 'Field name to sort by'
                        }
                      },
                      limit: {
                        type: 'number',
                        description: 'Maximum number of items to return'
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

      console.log('Started run:', run.id);

      // Handle the run and potential function calls
      let response = await this.openai.beta.threads.runs.retrieve(thread.id, run.id);
      
      while (response.status === 'in_progress' || response.status === 'requires_action') {
        if (response.status === 'requires_action') {
          console.log('Function call required');
          const toolCalls = response.required_action?.submit_tool_outputs.tool_calls;
          const toolOutputs = [];

          for (const toolCall of toolCalls || []) {
            if (toolCall.function.name === 'queryDatabase') {
              const args = JSON.parse(toolCall.function.arguments);
              console.log('Function args:', args);
              const result = await this.queryDatabase(args.collection, args.query);
              
              toolOutputs.push({
                tool_call_id: toolCall.id,
                output: JSON.stringify(result)
              });
            }
          }

          // Submit results back to assistant
          await this.openai.beta.threads.runs.submitToolOutputs(thread.id, run.id, {
            tool_outputs: toolOutputs
          });
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
        response = await this.openai.beta.threads.runs.retrieve(thread.id, run.id);
      }

      console.log('Run completed with status:', response.status);

      // Get the final response
      const messages = await this.openai.beta.threads.messages.list(thread.id);
      const assistantMessage = messages.data.find(message => message.role === 'assistant');

      if (!assistantMessage || !assistantMessage.content.length) {
        throw new Error('No response received from assistant');
      }

      const content = assistantMessage.content[0];
      
      if ('text' in content) {
        return content.text.value;
      }

      throw new Error('Unexpected response format from assistant');

    } catch (error) {
      console.error('Error in generateResponse:', error);
      throw new InternalServerErrorException(
        error.message || 'Error processing your request'
      );
    }
  }
}