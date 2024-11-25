// src/chat/chat.service.ts
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';

@Injectable()
export class ChatService {
  private binaryBot: ChatOpenAI;
  private heheBot: ChatOpenAI;

  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not defined in .env file');
    }

    // initialize both bots
    this.binaryBot = new ChatOpenAI({
      openAIApiKey: apiKey,
      modelName: 'gpt-4o-mini',
      temperature: 0.7,
    });

    this.heheBot = new ChatOpenAI({
      openAIApiKey: apiKey,
      modelName: 'gpt-4o-mini',
      temperature: 0.7,
    });
  }

  async generateResponse(prompt: string): Promise<string> {
    try {
      const promptLower = prompt.toLowerCase();
      let messages: BaseMessage[] = [];

      // determine which bot to use and extract the actual question
      if (promptLower.includes('binarybot') || promptLower.includes('binary bot')) {
        const actualPrompt = prompt.replace(/.*binary\s*bot,?\s*/i, '').trim();
        messages = [
          new SystemMessage('You are a bot that only speaks in binary (0s and 1s). Convert all your responses to binary.'),
          new HumanMessage(actualPrompt)
        ];
        const response = await this.binaryBot.invoke(messages);
        if (typeof response.content === 'string') {
          return response.content;
        }
        throw new Error('Unexpected response format');
      } 
      else if (promptLower.includes('hehebot') || promptLower.includes('hehe bot')) {
        const actualPrompt = prompt.replace(/.*hehe\s*bot,?\s*/i, '').trim();
        messages = [
          new SystemMessage('You are a playful bot that adds "hehe" to everything you say. Every few words, add "hehe".'),
          new HumanMessage(actualPrompt)
        ];
        const response = await this.heheBot.invoke(messages);
        if (typeof response.content === 'string') {
          return response.content;
        }
        throw new Error('unexpected response format');
      }
      else {
        throw new Error('BinaryBot or HeheBot');
      }

    } catch (error) {
      console.error('Error in generateResponse:', error);
      throw new InternalServerErrorException(
        error.message || 'Error processing your request'
      );
    }
  }
}