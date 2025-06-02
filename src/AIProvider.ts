import { Log } from 'debug-level'
import OpenAI from 'openai'

Log.options({ json: true, colors: true })
const log = new Log('AIAdapter')

export interface AIProvider {
  baseURL: string
  createMessage(
    options: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Promise<{ response: OpenAI.Chat.Completions.ChatCompletion; images: Blob[] }>
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
          if (content.type === 'text') {
            const contentPartText = content as OpenAI.Chat.Completions.ChatCompletionContentPartText
            message += contentPartText.text
          } else if (content.type === 'image_url') {
            const contentPartImage = content as OpenAI.Chat.Completions.ChatCompletionContentPartImage
            // image_url なら無視
            log.debug('Not support man image_url', contentPartImage.type, shortenString(contentPartImage.image_url.url))
          } else if (content.type === 'file') {
            const contentPartFile = content as OpenAI.Chat.Completions.ChatCompletionContentPart.File
            // ファイルは無視
            log.debug(
              'Not support file',
              contentPartFile.type,
              contentPartFile.file.filename,
              shortenString(contentPartFile.file.file_data),
            )
          } else if (content.type === 'input_audio') {
            const contentPartAudio = content as OpenAI.Chat.Completions.ChatCompletionContentPartInputAudio
            // input_audio なら無視
            log.debug(
              'Not support input_audio',
              contentPartAudio.type,
              shortenString(contentPartAudio.input_audio.data),
            )
          } else {
            log.warn('Unknown content type:', content.type, content)
          }
        })
      }
    }
    log.trace('getUserMessage():', message)
    return message
  }

  // OpenAIのFunctionsをToolsに書き換える
  protected convertFunctionsToTools(
    functions: OpenAI.Chat.Completions.ChatCompletionCreateParams.Function[] | undefined,
    tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
  ) {
    if (functions && functions.length > 0) {
      if (!tools) {
        tools = []
      }
      functions.forEach(functionCall => {
        tools?.push({
          type: 'function',
          function: {
            name: functionCall.name,
            description: functionCall.description,
            parameters: functionCall.parameters,
          },
        })
      })
    }
    return tools
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
