import { AIAdapter, AIProvider, shortenString } from '../AIProvider.js'
import {
  Content,
  FinishReason,
  FunctionDeclaration,
  FunctionDeclarationSchema,
  FunctionDeclarationSchemaProperty,
  GenerateContentCandidate,
  GenerateContentRequest,
  GenerativeModel,
  GoogleGenerativeAI,
  Part,
  Tool,
} from '@google/generative-ai'
import { Log } from 'debug-level'
import OpenAI from 'openai'

Log.options({ json: true, colors: true })
const log = new Log('Gemini')

/**
 * Google Gemini Adapter
 * See: https://blog.gopenai.com/how-to-use-google-gemini-with-node-js-and-typescript-393cde945eab
 */
export class GoogleGeminiAdapter extends AIAdapter implements AIProvider {
  private generativeModel: GenerativeModel
  public baseURL: string
  private MAX_TOKENS: number
  private temperature: number

  constructor(apiKey: string, model: string, MAX_TOKENS: number, temperature: number) {
    super()
    this.MAX_TOKENS = MAX_TOKENS
    this.temperature = temperature
    // GoogleGenerativeAI required config
    const configuration = new GoogleGenerativeAI(apiKey)
    this.generativeModel = configuration.getGenerativeModel(
      {
        model,
        generationConfig: {
          maxOutputTokens: this.MAX_TOKENS,
          temperature: this.temperature,
          //topP, TopK
        },
      },
      {
        apiVersion: 'v1beta', //v1beta にしかtoolsが無い
      },
    )
    this.baseURL = `https://generativelanguage.googleapis.com/v1/models/${model}:`
  }

  async createMessage(
    options: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    //These arrays are to maintain the history of the conversation
    const systemInstruction = this.createContents([
      options.messages.shift() as OpenAI.Chat.Completions.ChatCompletionMessageParam,
    ])[0]
    const currentMessages: Content[] = this.createContents(options.messages)
    const tool: Tool | undefined = this.createGeminiTool(options.tools, options.functions)
    let tools: Tool[] | undefined = undefined
    if (tool) {
      tools = [tool]
    }
    // const chat = this.generativeModel
    //   .startChat({
    //     history: currentMessages,
    //   })
    // const generateContentResult = await chat.sendMessage(prompt)
    const request: GenerateContentRequest = {
      // https://ai.google.dev/api/rest/v1/models/generateContent?hl=ja#request-body
      // https://ai.google.dev/api/rest/v1beta/models/generateContent?hl=ja
      contents: currentMessages,
      //safetySettings,
      //generationConfig,
      systemInstruction,
      tools, // v1betaより
      //toolConfig?: ToolConfig;
    }
    log.trace('request', JSON.parse(this.shortenLongString(JSON.stringify(request))))
    const generateContentResponse = await this.generativeModel.generateContent(request)
    log.trace('generateContentResponse', generateContentResponse)

    //レスポンスメッセージの詰替え
    const { choices, tokenCount } = this.createChoices(generateContentResponse.response.candidates)
    const usage = await this.getUsage(currentMessages, tokenCount)

    return {
      id: '',
      choices,
      created: 0,
      model: options.model,
      system_fingerprint: '',
      object: 'chat.completion', //OputAI固定値
      usage,
    }
  }
  private shortenLongString(str: string) {
    // ""で囲まれた1024文字以上を切り詰める
    const regex = /"(.*?)"/g
    return str.replace(regex, function (match, content) {
      if (content.length > 1024) {
        return `"${content.slice(0, 1024)}..."`
      } else {
        return match
      }
    })
  }
  private createChoices(candidates: GenerateContentCandidate[] | undefined) {
    //レスポンスメッセージの詰替え
    // OpenAI のレスポンスメッセージは "choices": [{
    //   "index": 0,
    //   "message": {
    //     "role": "assistant",
    //     "content": "\n\nHello there, how may I assist you today?",
    //   },
    let tokenCount = 0
    const choices: OpenAI.Chat.Completions.ChatCompletion.Choice[] = []
    candidates?.forEach(candidate => {
      tokenCount += 0 //candidate.tokenCount //TODO: まだ.d.tsにない
      let content: string | null = null
      let toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined = undefined

      if (candidate.finishReason !== FinishReason.STOP && candidate.finishReason !== FinishReason.MAX_TOKENS) {
        log.error(`Abnormal fihishReson ${candidate.finishReason}`)
        return
      }

      candidate.content.parts.forEach(part => {
        if (part.functionCall) {
          if (!toolCalls) {
            toolCalls = []
          }
          toolCalls.push({
            id: '',
            type: 'function',
            function: {
              name: part.functionCall.name.replaceAll('_', '-'), //なぜか、pluginの名前の「-」が「_」になってしまう。
              arguments: JSON.stringify(part.functionCall.args),
            },
          })
        } else if (part.text) {
          if (!content) {
            content = ''
          }
          content += part.text //TODO 繋げす別のchoiceにする?
        } else {
          log.error(`Unexpected part`, part)
        }
      })
      choices.push({
        index: candidate.index,
        finish_reason: 'stop', //| 'length' | 'tool_calls' | 'content_filter' | 'function_call';
        logprobs: null, //Choice.Logprobs | null;  //ログ確率情報
        message: {
          role: 'assistant', //this.convertRoleGeminitoOpenAI(candidate.content.role),
          content,
          tool_calls: toolCalls,
        },
      })
    })
    return { choices, tokenCount }
  }

  private createGeminiTool(
    tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
    functions: OpenAI.Chat.Completions.ChatCompletionCreateParams.Function[] | undefined,
  ): Tool | undefined {
    tools = this.convertFunctionsToTools(functions, tools)
    if (!tools || tools.length === 0) {
      return undefined
    }
    const functionDeclarations: FunctionDeclaration[] = []
    const geminiTool: Tool = {
      functionDeclarations,
    }
    tools.forEach(tool => {
      if (tool.type !== 'function') {
        log.error(`Unexpected tool type ${tool.type}`, tool)
        return
      }
      //tool.function.parameters // OpenAI
      //parameters": {
      // "type": "object",
      // "properties": {
      //   "location": {
      //     "type": "string",
      //     "description": "The city and state, e.g. San Francisco, CA"
      //   },
      //   "unit": {
      //     "type": "string",
      //     "enum": ["celsius", "fahrenheit"]
      //   }
      // },
      const properties: { [key: string]: FunctionDeclarationSchemaProperty } = {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const props = tool.function.parameters?.properties as any
      for (const propKey in props) {
        const param = props[propKey]
        properties[propKey] = {
          type: param.type,
          description: param.description,
          //format: param.format,
          //nullable: param.nullable,
          //items: param.items,
          //enum: param.enum,
          /** Optional. Map of {@link FunctionDeclarationSchema}. */
          //properties?: { [k: string]: FunctionDeclarationSchema; };
          //required: param.required,
          //example:
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parameters: FunctionDeclarationSchema = tool.function.parameters as any
      // {
      //   type: FunctionDeclarationSchemaType.STRING, //OpenAIではリターン値の型指定はない
      //   //省略可 format: 'fload', //int32, int64...
      //   description: tool.function.description, //省略可
      //   properties, //省略可 {"name": "wrench", "mass": "1.3kg", "count": "3" }, //OBJECTでのプロパティ
      //   //省略可 required: {name: 'wrench'}, //OBJECTでの必須プロバティ
      //   //省略可 nullable: true,
      //   //省略可 emum: [ "EAST", "NORTH", "SOUTH", "WEST"], //STRINGでの有効値
      //   //省略可 items: Schema, //ARRAYの要素スキーマ
      // }

      functionDeclarations.push({
        name: tool.function.name,
        description: tool.function.description,
        parameters,
      })
    })
    return geminiTool
  }

  private createContents(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]) {
    const currentMessages: Content[] = []
    messages.forEach(async message => {
      switch (message.role) {
        // To Google ["user", "model", "function", "system"]
        case 'system':
          //Geminiにsystemは無いので user でごまかすけど、user連打のhistoryもだめなのでmodelでダミーもいれる
          //currentMessages.push({ role: 'system', parts: [{ text: message.content as string }] }) //Geminiにsystemは無い。
          currentMessages.push({
            role: 'user',
            parts: this.createParts(message, message.name ? `${message.name} says: ` : ''),
          })
          currentMessages.push({ role: 'model', parts: [{ text: ' ' }] }) // user連続もだめ
          break
        case 'user':
          currentMessages.push({
            role: 'user',
            parts: this.createParts(message, message.name ? `${message.name} says: ` : ''),
          })
          break
        case 'assistant':
          currentMessages.push({
            role: 'model',
            parts: this.createParts(message, message.name ? `${message.name} says: ` : ''),
          })
          break
        case 'tool':
        case 'function': //Deprecated
        default:
          log.error(`getChatHistory(): ${message.role} not yet support.`, message)
          break
      }
    })
    log.trace('currentMessages():', this.mapShotenInlineData(currentMessages))
    return currentMessages
  }
  private mapShotenInlineData(contents: Content[]): Content[] {
    return contents.map(message => {
      const newMessage: Content = {
        role: message.role,
        parts: this.mapShotenInlineDataInParts(message.parts),
      }
      return newMessage
    })
  }
  private mapShotenInlineDataInParts(parts: Part[]): Part[] {
    return parts.map(part => {
      let newPart: Part
      if (part.text) {
        newPart = { text: part.text }
      } else if (part.inlineData) {
        newPart = {
          inlineData: {
            mimeType: part.inlineData.mimeType,
            data: shortenString(part.inlineData.data) ?? '',
          },
        }
      } else {
        log.error('Unexpected Part type', part)
        throw new Error(`Unexpected Part type ${part}`)
      }
      return newPart
    })
  }

  private createParts(
    openAImessage: OpenAI.Chat.Completions.ChatCompletionMessageParam | undefined,
    name: string,
  ): Part[] {
    const parts: Part[] = [] //https://ai.google.dev/api/rest/v1/Content?hl=ja#part
    // TODO: v1beta対応 https://ai.google.dev/api/rest/v1beta/Content?hl=ja#part
    if (!openAImessage || !openAImessage.content) {
      return parts
    }
    if (typeof openAImessage.content === 'string') {
      parts.push({ text: name + openAImessage.content })
    } else {
      openAImessage.content.forEach(contentPart => {
        const contentPartText = contentPart as OpenAI.Chat.Completions.ChatCompletionContentPartText
        if (contentPartText.type === 'text') {
          parts.push({ text: name + contentPartText.text })
        } else if (contentPartText.type === 'image_url') {
          const conteentPartImage = contentPart as OpenAI.Chat.Completions.ChatCompletionContentPartImage
          // image_url
          const dataURL = conteentPartImage.image_url.url
          // dataURL形式: 'data:' + mimeType + ';base64,' + base64
          const mimeEnd = dataURL.indexOf(';')
          // MIME タイプ。使用できるタイプは「image/png」「image/jpeg」「image/heic」「image/heif」「image/webp」です
          const mimeType = dataURL.substring('data:'.length, mimeEnd)
          const data = dataURL.substring(mimeEnd + ';base64,'.length)
          parts.push({ inlineData: { mimeType, data } })
          //下のcreateParts():でも出る log.trace(`Converted image_url ${mimeType}, ${shortenString(data)}`)
        } else {
          log.error(`Ignore unsupported message ${contentPartText.type} type`, contentPartText)
        }
      })
    }
    //位置階層上でcurrentMessages()として出る log.trace('createParts():', this.mapShotenInlineDataInParts(parts) )
    return parts
  }

  private async getUsage(history: Content[], responseTokenCount: number): Promise<OpenAI.Completions.CompletionUsage> {
    // usageのためにトークン数を取得する
    // https://ai.google.dev/tutorials/get_started_node?hl=ja#count-tokens
    const contents = [...history]
    let inputTokens = -1
    let outputTokens = -1
    try {
      inputTokens = (await this.generativeModel.countTokens({ contents })).totalTokens
      outputTokens = responseTokenCount
    } catch (error) {
      if ((error as Error).message.indexOf('GoogleGenerativeAI Error') >= 0) {
        log.info('Gemini 1.5 not support countTokens()?', error)
      } else {
        throw error
      }
    }
    return {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    }
  }

  imagesGenerate(_imageGeneratePrams: OpenAI.Images.ImageGenerateParams): Promise<OpenAI.Images.ImagesResponse> {
    throw new Error('GoogleGeminiAdapter does not support image generation.')
  }
}
