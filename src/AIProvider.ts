import { Log } from 'debug-level'
import OpenAI from 'openai'

Log.options({ json: true, colors: true })
const log = new Log('AIAdapter')

export interface AIProvider {
  baseURL: string
  createMessage(
    options: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion>
  imagesGenerate(imageGeneratePrams: OpenAI.Images.ImageGenerateParams): Promise<OpenAI.Images.ImagesResponse>
}

export type OpenAiArgs = {
  apiKey?: string
  baseURL?: string
  defaultQuery?: Record<string, string>
  defaultHeaders?: Record<string, string>
}

/**
 * Utility Class
 **/
export class AIAdapter {
  // OpenAIのUserロールからメッセージを取り出す
  protected getLastMessage(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam | undefined {
    return messages.pop() //最後を取り出す
  }

  protected getUserMessage(openAImessage: OpenAI.Chat.Completions.ChatCompletionMessageParam | undefined): string {
    if (!openAImessage) {
      return ''
    }
    let message = ''
    if (openAImessage.content) {
      if (typeof openAImessage.content === 'string') {
        message = openAImessage.content
      } else {
        openAImessage.content.forEach(content => {
          const contentPartText = content as OpenAI.Chat.Completions.ChatCompletionContentPartText
          if (contentPartText.type === 'text') {
            message += contentPartText.text
          } else {
            const conteentPartImage = content as OpenAI.Chat.Completions.ChatCompletionContentPartImage
            // image_url なら無視
            log.debug(
              'Not support man image_url',
              conteentPartImage.type,
              shortenString(conteentPartImage.image_url.url),
            )
          }
        })
      }
    }
    log.trace('getUserMessage():', message)
    return message
  }
}

// 1024文字以上の文字列を短くする
export function shortenString(text: string | undefined): string | undefined {
  if (!text) {
    return text
  }
  if (text.length < 1024) {
    return text
  }
  return text.substring(0, 1023) + '...'
}
