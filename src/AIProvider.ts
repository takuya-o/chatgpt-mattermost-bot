import { Cohere, CohereClient } from 'cohere-ai'
import Anthropic from '@anthropic-ai/sdk'
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
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    // OpenAI.APIErrorをキャッチしてエラーをログに出力する
    try {
      return this.openai.chat.completions.create(options)
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
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const completion = await this.anthropic.messages.create(
      options as unknown as Anthropic.Messages.MessageCreateParamsNonStreaming,
    )
    return this.mapAnthropicMessageToOpenAICompletion(completion)
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

/**
 * Cohrere Adapter
 */
export class CohereAdapter extends AIAdapter implements AIProvider {
  private cohere: CohereClient
  baseURL: string

  constructor(args?: OpenAiArgs) {
    super()
    this.cohere = new CohereClient({ token: args?.apiKey })
    this.baseURL = 'https://api.cohere.ai/'
  }

  async createMessage(
    options: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const chat = await this.cohere.chat(this.mapOpenAIOptionsToCohereOptions(options))
    log.debug('Cohere chat() response: ', chat)
    return this.mapOpenAICompletion(chat, options.model)
  }

  private mapOpenAICompletion(
    chat: Cohere.NonStreamedChatResponse,
    model: string,
  ): OpenAI.Chat.Completions.ChatCompletion {
    //レスポンスメッセージの詰替え
    const choices: OpenAI.Chat.Completions.ChatCompletion.Choice[] = [
      {
        finish_reason: 'stop',
        index: 0,
        logprobs: null, //ログ確率情報
        message: {
          role: 'assistant',
          content: chat.text,
        },
      },
    ]
    // 実際のレスポンスにはあるけどNonStreamedChatResponseには無かったが入った
    const inputTokens = chat.meta?.billedUnits?.inputTokens ?? -1
    const outputTokens = chat.meta?.billedUnits?.outputTokens ?? -1

    return {
      id: '',
      created: 0,
      object: 'chat.completion', //OputAI固定値
      choices,
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
      model,
    }
  }

  private mapOpenAIOptionsToCohereOptions(
    options: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Cohere.ChatRequest {
    const chatRequest: Cohere.ChatRequest = {
      model: options.model,
      message: this.getUserMessage(this.getLastMessage(options.messages)), //最後のメッセージがユーザのメッセージ
      temperature: options.temperature ?? undefined,
      maxTokens: options.max_tokens ?? undefined,
      p: options.top_p ?? undefined,
      tools: this.getTools(options.tools),
      chatHistory: this.getChatHistory(options.messages), //TODO: getUserMessage()されてから呼ばれている?
    }
    return chatRequest
  }

  private getTools(tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined): Cohere.Tool[] | undefined {
    if (!tools || tools.length < 0) {
      return undefined
    }
    const cohereTools: Cohere.Tool[] = []
    tools.forEach(tool => {
      let parameterDefinitions: Record<string, Cohere.ToolParameterDefinitionsValue> | undefined
      if (tool.function.parameters) {
        parameterDefinitions = {}
        for (const paramKey in tool.function.parameters) {
          const param = tool.function.parameters[paramKey] as {
            name: string
            type: string
            description: string
            required: boolean
          } // TODO: JSON Schema
          parameterDefinitions[param.name] = {
            type: param.type,
            description: param.description,
            required: param.required,
          }
        }
      }
      cohereTools.push({
        description: tool.function.description ?? '',
        name: tool.function.name,
        parameterDefinitions,
      })
    })
    log.debug('Cohere tools', cohereTools)
    return cohereTools
  }

  private getChatHistory(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]) {
    if (messages.length < 1) {
      return undefined
    }
    const chatHistory: Cohere.ChatMessage[] = []
    messages.forEach(message => {
      if (message.role === 'user') {
        chatHistory.push({
          role: 'USER',
          message: this.getUserMessage(message),
        })
      } else if (message.role === 'system') {
        chatHistory.push({
          role: 'SYSTEM',
          message: message.content,
        })
      } else if (message.role === 'assistant') {
        chatHistory.push({
          role: 'CHATBOT',
          message: message.content ?? '',
        })
      } else {
        // "function" | "tool"
        log.debug(`getChatHistory(): ${message.role} not yet support.`, message)
      }
    })
    log.debug('Cohere chat history', chatHistory)
    return chatHistory
  }

  async imagesGenerate(_imageGeneratePrams: OpenAI.Images.ImageGenerateParams): Promise<OpenAI.Images.ImagesResponse> {
    // イメージを作るAPIはない?
    throw new Error('Cohere does not support image generation.')
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
