import { AIProvider, OpenAiArgs } from '../AIProvider'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

/**
 * Anthropic Adapter
 */
export class AnthropicAdapter implements AIProvider {
  private anthropic: Anthropic
  baseURL: string

  constructor(args?: OpenAiArgs) {
    this.anthropic = new Anthropic(args)
    this.baseURL = this.anthropic.baseURL
  }

  async createMessage(
    options: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Promise<{ response: OpenAI.Chat.Completions.ChatCompletion; images: Blob[] }> {
    const completion = await this.anthropic.messages.create(
      options as unknown as Anthropic.Messages.MessageCreateParamsNonStreaming,
    )
    const response = this.mapAnthropicMessageToOpenAICompletion(completion)
    return { response, images: [] }
  }
  private mapAnthropicMessageToOpenAICompletion(
    completion: Anthropic.Messages.Message,
  ): OpenAI.Chat.Completions.ChatCompletion {
    //レスポンスメッセージの詰替え
    const choices: OpenAI.Chat.Completions.ChatCompletion.Choice[] = [
      { message: completion } as unknown as OpenAI.Chat.Completions.ChatCompletion.Choice,
    ]
    const usage: OpenAI.Completions.CompletionUsage = {
      //トータルトークン無いし属性名も違うの詰め替える
      prompt_tokens: completion.usage.input_tokens,
      completion_tokens: completion.usage.output_tokens,
      total_tokens: completion.usage.input_tokens + completion.usage.output_tokens,
    }
    return {
      choices,
      usage,
      model: completion.model,
      id: completion.id,
      role: completion.role,
    } as unknown as OpenAI.Chat.Completions.ChatCompletion
  }

  async imagesGenerate(_imageGeneratePrams: OpenAI.Images.ImageGenerateParams): Promise<OpenAI.Images.ImagesResponse> {
    // まじ Claude はイメージを作るAPIはない?
    throw new Error('Anthropic does not support image generation.')
  }
}
