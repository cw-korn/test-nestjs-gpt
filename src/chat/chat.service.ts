import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

@Injectable()
export class ChatService {
  private openai: OpenAI;
  private readonly binaryBotId: string;
  private readonly heheBotId: string;

  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    this.binaryBotId = this.configService.get<string>('BINARY_BOT_ID');
    this.heheBotId = this.configService.get<string>('HEHE_BOT_ID');
    
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not defined in .env file');
    }

    this.openai = new OpenAI({
      apiKey: apiKey,
    });
  }

  async generateResponse(prompt: string): Promise<string> {
    try {
      const promptLower = prompt.toLowerCase();
      let assistantId: string;

      if (promptLower.includes('binarybot') || promptLower.includes('binary bot')) {
        assistantId = this.binaryBotId;
        prompt = prompt.replace(/.*binary\s*bot,?\s*/i, '').trim();
      } 
      else if (promptLower.includes('hehebot') || promptLower.includes('hehe bot')) {
        assistantId = this.heheBotId;
        prompt = prompt.replace(/.*hehe\s*bot,?\s*/i, '').trim();
      }
      else {
        throw new Error('Please specify which bot you want to talk to (BinaryBot or HeheBot)');
      }

      console.log('Creating thread...');
      const thread = await this.openai.beta.threads.create();
      console.log('Thread created:', thread.id);

      console.log('Adding message to thread...');
      await this.openai.beta.threads.messages.create(thread.id, {
        role: 'user',
        content: prompt,
      });
      console.log('Message added to thread');

      console.log('Starting run with assistant...');
      const run = await this.openai.beta.threads.runs.create(thread.id, {
        assistant_id: assistantId,
      });
      console.log('Run created:', run.id);

      let response = await this.openai.beta.threads.runs.retrieve(thread.id, run.id);
      console.log('Initial run status:', response.status);
      
      let attempts = 0;
      const maxAttempts = 30; // 30 seconds timeout
      
      while (response.status === 'in_progress' || response.status === 'queued') {
        console.log(`Attempt ${attempts + 1}: Status is ${response.status}`);
        
        if (attempts >= maxAttempts) {
          throw new Error('Request timed out after 30 seconds');
        }
        
        await new Promise(resolve => setTimeout(resolve, 1000));
        response = await this.openai.beta.threads.runs.retrieve(thread.id, run.id);
        attempts++;
      }

      console.log('Final run status:', response.status);

      if (response.status === 'completed') {
        console.log('Getting messages...');
        const messages = await this.openai.beta.threads.messages.list(thread.id);
        console.log('Messages received:', messages.data.length);
        
        const assistantMessage = messages.data.find(message => message.role === 'assistant');

        if (!assistantMessage || !assistantMessage.content.length) {
          throw new Error('No response received from assistant');
        }

        const content = assistantMessage.content[0];
        
        if ('text' in content) {
          console.log('Response content:', content.text.value);
          return content.text.value;
        }
      } else {
        throw new Error(`Run failed with status: ${response.status}`);
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