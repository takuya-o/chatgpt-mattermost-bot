import { AIProvider, OpenAiArgs } from '../AIProvider'
import Log from 'debug-level'
import OpenAI from 'openai'

Log.options({ json: true, colors: true })
const log = new Log('OpenAI')

/**
 * OpenAI Adapter
 */
export class OpenAIAdapter implements AIProvider {
  private openai: OpenAI
  baseURL: string

  constructor(openaiArgs?: OpenAiArgs) {
    this.openai = new OpenAI(openaiArgs)
    this.baseURL = this.openai.baseURL
  }

  async createMessage(
    options: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Promise<{ response: OpenAI.Chat.Completions.ChatCompletion; images: Blob[] }> {
    // OpenAI.APIErrorをキャッチしてエラーをログに出力する
    try {
      const response = await this.openai.chat.completions.create(options)
      return { response, images: [] }
    } catch (error) {
      if (error instanceof OpenAI.APIError) {
        log.error(`OpenAI API Error: ${error.status} ${error.name}`, error)
      }
      throw error
    }
  }
  async imagesGenerate(imageGeneratePrams: OpenAI.Images.ImageGenerateParams) {
    return this.openai.images.generate(imageGeneratePrams)
  }
}
