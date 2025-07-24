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
  async imagesGenerate(imageGeneratePrams: OpenAI.Images.ImageGenerateParams): Promise<OpenAI.Images.ImagesResponse> {
    // OpenAI.Images.ImagesResponse型のみ返す。ストリームの場合はエラーを投げる
    const result = await this.openai.images.generate(imageGeneratePrams)
    // ストリーム型の場合はエラー
    if ('on' in result) {
      // ストリームは未対応のためエラーを投げる
      throw new Error('Stream response is not supported in imagesGenerate')
    }
    // resultがストリーム型ではないのでImagesResponse型だけであることをTypeScriptに明示する
    return result as OpenAI.Images.ImagesResponse
  }
}
