import { Controller, Post, Body, HttpCode } from '@nestjs/common';
import { ChatService } from './chat.service';

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post()
  @HttpCode(200)
  async generateResponse(@Body() body: { prompt: string }): Promise<{ response: string }> {
    const response = await this.chatService.generateResponse(body.prompt);
    return { response };
  }
}