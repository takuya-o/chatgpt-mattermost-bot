import { AIAdapter, AIProvider, OpenAiArgs } from '../AIProvider'
import { Cohere, CohereClient } from 'cohere-ai'
import Log from 'debug-level'
import OpenAI from 'openai'

Log.options({ json: true, colors: true })
const log = new Log('Cohere')

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
  ): Promise<{ response: OpenAI.Chat.Completions.ChatCompletion; images: Blob[] }> {
    // https://docs.cohere.com/reference/chat
    // まだ messageやhistoryは、stringのみ  Toolsはあるけど。
    const chat = await this.cohere.chat(this.createCohereRequest(options))
    log.debug('Cohere chat() response: ', chat)
    const response = this.createOpenAIChatCompletion(chat, options.model)
    return { response, images: [] }
  }

  private createOpenAIChatCompletion(
    chat: Cohere.NonStreamedChatResponse,
    model: string,
  ): OpenAI.Chat.Completions.ChatCompletion {
    //レスポンスメッセージの詰替え
    const choices: OpenAI.Chat.Completions.ChatCompletion.Choice[] = [
      {
        finish_reason: 'stop',
        index: 0,
        logprobs: null, //ログ確率情報
        message: this.createResponseMessages(chat), //tools_callsもここで作る
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

  private createResponseMessages(chat: Cohere.NonStreamedChatResponse): OpenAI.Chat.Completions.ChatCompletionMessage {
    if (chat.toolCalls && chat.toolCalls.length > 0) {
      // toolsが有った場合には展開
      return this.createToolCallMessage(chat.toolCalls)
    } else {
      return {
        role: 'assistant',
        content: chat.text,
        refusal: null, // アシスタントからの拒否メッセージ
      }
    }
  }
  private createToolCallMessage(toolCalls: Cohere.ToolCall[]): OpenAI.Chat.Completions.ChatCompletionMessage {
    // https://docs.cohere.com/docs/tool-use#the-four-steps-of-single-step-tool-use-theory
    // An example output:
    // cohere.ToolCall {
    //  name: query_daily_sales_report
    //	parameters: {'day': '2023-09-29'}
    //	generation_id: 4807c924-9003-4d6b-8069-eda03962c465
    //}
    const openAItoolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = toolCalls.map(toolCall => ({
      // Cohre形式をOpenAI形式に変換
      id: '', //TODO: toolCall.generation_idを追加予定
      type: 'function',
      function: {
        name: this.decodeName(toolCall.name),
        arguments: JSON.stringify(toolCall.parameters),
      },
    }))
    const message: OpenAI.Chat.Completions.ChatCompletionMessage = {
      role: 'assistant',
      content: null,
      tool_calls: openAItoolCalls,
      refusal: null, // アシスタントからの拒否メッセージ
    }
    return message
  }

  private createCohereRequest(
    options: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Cohere.ChatRequest {
    let tools = this.createCohereTools(options.tools, options.functions)
    tools = undefined //ツールを入れるとレスポンスから空っぽになるので止める。 //TODO 止めなくて良くなる対策
    const chatRequest: Cohere.ChatRequest = {
      model: options.model,
      message: this.getUserMessage(this.getLastMessage(options.messages)), //最後のメッセージがユーザのメッセージ
      temperature: options.temperature ?? undefined,
      maxTokens: options.max_tokens ?? undefined,
      p: options.top_p ?? undefined,
      tools,
      chatHistory: this.getChatHistory(options.messages), //TODO: getUserMessage()されてから呼ばれている?
    }
    log.trace('mapOpenAIOptionsToCohereOptions(): chatRequest', chatRequest)
    return chatRequest
  }

  private createCohereTools(
    tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
    functions: OpenAI.Chat.Completions.ChatCompletionCreateParams.Function[] | undefined,
  ): Cohere.Tool[] | undefined {
    tools = this.convertFunctionsToTools(functions, tools)
    if (!tools || tools.length === 0) {
      return undefined
    }
    // https://docs.cohere.com/docs/tool-use#step-1
    // tools = [
    //   {
    //       "name": "query_daily_sales_report",
    //       "description": "Connects to a database to retrieve overall sales volumes and sales information for a given day.",
    //       "parameter_definitions": {
    //           "day": {
    //               "description": "Retrieves sales data for this day, formatted as YYYY-MM-DD.",
    //               "type": "str",
    //               "required": True
    //           }
    //       }
    //   },
    const cohereTools: Cohere.Tool[] = []
    tools.forEach(tool => {
      if (tool.type !== 'function') {
        log.error(`createCohereTools(): ${tool.type} not function.`, tool)
        return
      }
      // functionの引数定義を変換
      let parameterDefinitions: Record<string, Cohere.ToolParameterDefinitionsValue> | undefined
      if (tool.function.parameters) {
        if (tool.function.parameters.type !== 'object') {
          log.error(`createCohereTools(): parameter.type ${tool.function.parameters.type} is not  'object'`)
          return
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const props = tool.function.parameters.properties as any
        parameterDefinitions = {}
        for (const propsKey in props) {
          const param = props[propsKey] as {
            description?: string
            type: string
            required?: boolean
          } // TODO: JSON Schema
          parameterDefinitions[propsKey] = {
            description: param.description,
            type: param.type,
            required: param.required,
          }
        }
      }
      cohereTools.push({
        description: tool.function.description ?? '',
        name: this.encodeName(tool.function.name), //tool names can only contain certain characters (A-Za-z0-9_) and can't begin with a digit
        parameterDefinitions,
      })
    })
    //log.trace('Cohere tools', cohereTools)
    return cohereTools
  }

  /*
   * TypeScriptでCohere.Toolの名前をA-Za-z0-9_以外を__HEXエンコードするプログラム
   */
  private encodeName(name: string): string {
    // const encodedName = name.replace(/[^A-Za-z0-9_]/g, match => {
    //   return `__${match.charCodeAt(0).toString(16).padStart(2, '0')}`
    // })
    const encodedName = name.replaceAll('-', '_')
    return encodedName
  }
  private decodeName(name: string): string {
    // const decodedName = name.replace(/__([0-9a-f]{2})/g, match => {
    //   const codePoint = parseInt(match[1], 16)
    //   return String.fromCharCode(codePoint)
    // })
    const decodedName = name.replaceAll('_', '-')
    return decodedName
  }

  private getChatHistory(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]) {
    if (messages.length < 1) {
      return undefined
    }
    const chatHistory: Cohere.Message[] = []
    messages.forEach(message => {
      if (message.role === 'user') {
        chatHistory.push({
          role: 'USER',
          message: this.getUserMessage(message),
        })
      } else if (message.role === 'system') {
        chatHistory.push({
          role: 'SYSTEM',
          message: message.content as string,
        })
      } else if (message.role === 'assistant') {
        chatHistory.push({
          role: 'CHATBOT',
          message: (message.content ?? '') as string,
        })
      } else {
        // "function" | "tool"
        log.debug(`getChatHistory(): ${message.role} not yet support.`, message)
      }
    })
    //log.debug('Cohere chat history', chatHistory)
    return chatHistory
  }

  async imagesGenerate(_imageGeneratePrams: OpenAI.Images.ImageGenerateParams): Promise<OpenAI.Images.ImagesResponse> {
    // イメージを作るAPIはない?
    throw new Error('Cohere does not support image generation.')
  }
}
