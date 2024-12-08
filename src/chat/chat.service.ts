import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { createDirectus, rest, readItems, authentication, staticToken } from '@directus/sdk';
import type { RestClient } from '@directus/sdk';
import { DirectusSchema } from '../types/directus';

/**
* Service for handling chat interactions and database queries
*/
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

     console.log('Initializing services...');
     this.openai = new OpenAI({ apiKey });
     this.directus = createDirectus<DirectusSchema>(directusUrl)
       .with(authentication())
       .with(staticToken(directusToken))
       .with(rest());
   } catch (error) {
     console.error('Initialization failed:', error);
     throw error;
   }
 }

 private async queryDatabase(
   collection: keyof DirectusSchema,
   query?: Record<string, any>
 ): Promise<any> {
   try {
     console.log('\n=== Database Query ===');
     console.log('Collection:', collection);
     console.log('Query Parameters:', {
       fields: query?.fields || 'all fields',
       filter: query?.filter || 'no filters'
     });

     const response = await readItems(collection as never, query);
     const result = await this.directus.request(response);
     
     console.log('Query Results:', JSON.stringify(result, null, 2));
     return result;

   } catch (error) {
     console.error('Query failed:', error);
     throw new Error(`Database query failed: ${error.message}`);
   }
 }

 async generateResponse(prompt: string): Promise<string> {
   try {
     console.log('\n=== New Request ===');
     console.log('Prompt:', prompt);

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
           description: 'Query the school admission database collections',
           parameters: {
             type: 'object',
             properties: {
               collection: {
                 type: 'string',
                 enum: ['exam_ai_schools', 'exam_ai_school_details', 'exam_ai_school_applicant_summaries'],
                 description: 'Collection to query - schools for basic info, school_details for dates/locations, applicant_summaries for statistics'
               },
               query: {
                 type: 'object',
                 properties: {
                   fields: {
                     type: 'array',
                     items: {
                       type: 'string',
                       enum: [
                         "name", "district", "province", "details",
                         "type", "exam_date", "result_date", "report_date",
                         "open_application_date", "close_application_date", 
                         "orientation_date", "exam_location",
                         "program", "year",
                         "in_district_quota", "out_district_quota",
                         "in_district_applicants", "out_district_applicants",
                         "in_district_pass_rate", "out_district_pass_rate"
                       ]
                     }
                   },
                   filter: {
                     type: 'object',
                     properties: {
                       name: { type: 'string', description: 'School name' },
                       district: { type: 'string', description: 'School district' },
                       province: { type: 'string', description: 'School province' },
                       type: { type: 'string', description: 'Type of program (NORMAL, SPECIAL, etc)' },
                       exam_date: { type: 'string', description: 'Date of examination' },
                       result_date: { type: 'string', description: 'Date when results are announced' },
                       report_date: { type: 'string', description: 'Date for successful candidates to report' },
                       open_application_date: { type: 'string', description: 'Date when applications start' },
                       close_application_date: { type: 'string', description: 'Date when applications end' },
                       orientation_date: { type: 'string', description: 'Date for student orientation' },
                       exam_location: { type: 'string', description: 'Location where exam will be held' },
                       program: { type: 'string', description: 'Program name (EP, MSEP, etc)' },
                       year: { type: 'number', description: 'Academic year' }
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
         console.log('\n=== Function Call ===');
         const toolCalls = response.required_action?.submit_tool_outputs.tool_calls;
         const toolOutputs = [];

         for (const toolCall of toolCalls || []) {
           if (toolCall.function.name === 'queryDatabase') {
             console.log('\n=== Query Object from AI ===');
             console.log(toolCall.function.arguments);
             
             const args = JSON.parse(toolCall.function.arguments);
             const result = await this.queryDatabase(args.collection, args.query);
             
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
       console.log('Status:', response.status);
     }

     const messages = await this.openai.beta.threads.messages.list(thread.id);
     const assistantMessage = messages.data.find(message => message.role === 'assistant');

     if (!assistantMessage?.content.length) {
       throw new Error('No response received');
     }

     const content = assistantMessage.content[0];
     if ('text' in content) {
       return content.text.value;
     }
     throw new Error('Unexpected response format');

   } catch (error) {
     console.error('Request failed:', error);
     throw new InternalServerErrorException(error.message || 'Request failed');
   }
 }
}
