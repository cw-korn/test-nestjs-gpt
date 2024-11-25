// src/chat/chat.service.ts
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { BaseMessage, HumanMessage } from '@langchain/core/messages';

@Injectable()
export class ChatService {
  private model: ChatOpenAI;

  constructor(private configService: ConfigService) {
    try {
      const apiKey = this.configService.get<string>('OPENAI_API_KEY');
      
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY is not defined in .env file');
      }

      this.model = new ChatOpenAI({
        openAIApiKey: apiKey,
        modelName: 'gpt-4o-mini',
        temperature: 0.7,
      });
    } catch (error) {
      console.error('Constructor Error:', error);
      throw error;
    }
  }

  async generateResponse(prompt: string): Promise<string> {
    try {
      console.log('Sending prompt to OpenAI:', prompt);
      
      const messages: BaseMessage[] = [
        new HumanMessage(prompt)
      ];
      
      const response = await this.model.invoke(messages);
      console.log('OpenAI Response received:', response);
      
      if (typeof response.content === 'string') {
        return response.content;
      }
      
      throw new Error('Unexpected response format');
    } catch (error) {
      console.error('Error in generateResponse:', error);
      throw new InternalServerErrorException(
        error.message || 'Error processing your request'
      );
    }
  }
} 