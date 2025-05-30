import { AIAdapter, AIProvider, shortenString } from '../AIProvider.js'
import {
  Candidate,
  Content,
  FinishReason,
  FunctionDeclaration,
  GenerateContentParameters,
  GenerateContentResponse,
  GoogleGenAI,
  Modality,
  Models,
  Part,
  Schema,
  Tool,
  Type,
} from '@google/genai'
import { Log } from 'debug-level'
import OpenAI from 'openai'

Log.options({ json: true, colors: true })
const log = new Log('Gemini')

/**
 * Google Gemini Adapter
 * See: https://blog.gopenai.com/how-to-use-google-gemini-with-node-js-and-typescript-393cde945eab
 */
export class GoogleGeminiAdapter extends AIAdapter implements AIProvider {
  private generativeModels: Models
  public baseURL: string
  private MAX_TOKENS: number
  private temperature: number
  private model: string

  constructor(apiKey: string, model: string, MAX_TOKENS: number, temperature: number) {
    super()
    this.MAX_TOKENS = MAX_TOKENS
    this.temperature = temperature
    this.model = model
    // GoogleGenerativeAI required config
    const ai = new GoogleGenAI({
      apiKey,
      // httpOptions: { apiVersion: 'v1beta' }, //v1beta v1alpha
    })
    this.generativeModels = ai.models
    this.baseURL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:`
  }

  // eslint-disable-next-line max-lines-per-function
  async createMessage(
    options: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Promise<{ response: OpenAI.Chat.Completions.ChatCompletion; images: Blob[] }> {
    //These arrays are to maintain the history of the conversation
    const systemInstruction = this.model.includes('image')
      ? undefined // gemini-2.0-flash-preview-image-generation でシステムインストラクションを入れるとDeveloper instruction is not enabled エラー
      : this.createContents([options.messages.shift() as OpenAI.Chat.Completions.ChatCompletionMessageParam])[0]
    const currentMessages: Content[] = this.createContents(options.messages)
    const tool: Tool | undefined = this.createGeminiTool(options.tools, options.functions)
    let tools: Tool[] | undefined = undefined
    if (tool) {
      tools = [tool]
    }
    if (
      [
        // 関数未対応のモデル
        'models/gemini-2.0-flash-preview-image-generation',
        'gemini-2.0-flash-exp-image-generation',
        'gemini-2.0-flash-preview-image-generation',
        //
        'models/gemini-2.0-flash-lite',
        'gemini-2.0-flash-lite',
      ].some(model => this.model.includes(model))
    ) {
      tools = undefined
    }
    // const chat = this.generativeModel
    //   .startChat({
    //     history: currentMessages,
    //   })
    // const generateContentResult = await chat.sendMessage(prompt)
    const request: GenerateContentParameters = {
      model: this.model,
      // https://ai.google.dev/api/rest/v1/models/generateContent?hl=ja#request-body
      // https://ai.google.dev/api/rest/v1beta/models/generateContent?hl=ja
      contents: currentMessages,
      //safetySettings,
      //generationConfig,
      config: {
        systemInstruction,
        maxOutputTokens: this.MAX_TOKENS,
        temperature: this.temperature,
        //topP, TopK
        tools, // v1betaより
        //toolConfig?: ToolConfig;
        responseModalities: this.model.includes('image') ? [Modality.IMAGE, Modality.TEXT] : [Modality.TEXT], // だめ[Modality.MODALITY_UNSPECIFIED],
        //なくてもIMAGEできる responseMimeType: 'text/plain',
      },
    }
    log.trace('request', JSON.parse(this.shortenLongString(JSON.stringify(request)))) // JSON.parse()の例外のリスク
    const generateContentResponse = await this.generativeModels.generateContent(request)
    log.trace('generateContentResponse', this.shortenResponse(generateContentResponse))
    let usage: OpenAI.Completions.CompletionUsage

    //レスポンスメッセージの詰替え
    const { choices, tokenCount, images } = this.createChoices(generateContentResponse.candidates)
    if (generateContentResponse.usageMetadata) {
      usage = {
        completion_tokens: generateContentResponse.usageMetadata.candidatesTokenCount || 0,
        prompt_tokens: generateContentResponse.usageMetadata.promptTokenCount || tokenCount, // usageMetadata.promptTokenCountは無い時はtokenCountを使う
        total_tokens: generateContentResponse.usageMetadata.totalTokenCount || 0,
        // completion_tokens_details?: CompletionUsage.CompletionTokensDetails || 0,
        // prompt_tokens_details?: CompletionUsage.PromptTokensDetails || 0,
      }
    } else {
      // usageMetadataはないので、トークン数を算出する
      usage = await this.getUsage(currentMessages, tokenCount)
    }
    return {
      response: {
        id: '',
        choices,
        created: 0,
        model: options.model,
        system_fingerprint: '',
        object: 'chat.completion', //OpenAI固定値
        usage,
      },
      images,
    }
  }
  // TRACE Gemini   "modelVersion": "gemini-2.0-flash-preview-image-generation",
  // TRACE Gemini   "usageMetadata": {
  // TRACE Gemini     "promptTokenCount": 62,
  // TRACE Gemini     "candidatesTokenCount": 6,
  // TRACE Gemini     "totalTokenCount": 68,
  // TRACE Gemini     "promptTokensDetails": [
  // TRACE Gemini       {
  // TRACE Gemini         "modality": "TEXT",
  // TRACE Gemini         "tokenCount": 62
  // TRACE Gemini       }
  // TRACE Gemini     ]
  // TRACE Gemini   }

  private shortenResponse(generateContentResponse: GenerateContentResponse) {
    // generateContentResponseのディープコピーを作る
    const g: GenerateContentResponse = JSON.parse(JSON.stringify(generateContentResponse))
    // 画像データ部分を短くする
    g.candidates?.forEach((candidate: Candidate) => {
      candidate.content?.parts?.forEach((part: Part) => {
        if (part.inlineData) {
          part.inlineData.data = shortenString(part.inlineData.data) || ''
        }
      })
    })
    return JSON.stringify(g)
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
  private createChoices(candidates: Candidate[] | undefined) {
    //レスポンスメッセージの詰替え
    // OpenAI のレスポンスメッセージは "choices": [{
    //   "index": 0,
    //   "message": {
    //     "role": "assistant",
    //     "content": "\n\nHello there, how may I assist you today?",
    //   },
    let tokenCount = 0
    const choices: OpenAI.Chat.Completions.ChatCompletion.Choice[] = []
    const images: Blob[] = []
    candidates?.forEach(candidate => {
      tokenCount += candidate.tokenCount ?? 0
      let content: string | null = null
      let toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined = undefined

      if (candidate.finishReason !== FinishReason.STOP && candidate.finishReason !== FinishReason.MAX_TOKENS) {
        log.error(`Abnormal finishReason ${candidate.finishReason}`)
        return
      }

      candidate.content?.parts?.forEach(part => {
        let found: boolean = false
        if (part.functionCall) {
          found = true
          if (!toolCalls) {
            toolCalls = []
          }
          toolCalls.push({
            id: '',
            type: 'function',
            function: {
              name: part.functionCall.name?.replaceAll('_', '-') || 'name' + part.functionCall.id, //なぜか、pluginの名前の「-」が「_」になってしまう。
              arguments: JSON.stringify(part.functionCall.args),
            },
          })
        }
        if (part.text) {
          found = true
          if (!content) {
            content = ''
          }
          content += part.text //TODO 繋げす別のchoiceにする?
        }
        if (part.inlineData) {
          found = true
          // part.inlineData.mimeType
          const imageData = part.inlineData //.data // image/png - image/jpeg
          if (imageData) {
            // const blob = new Blob([buffer], { type: "image/png" });
            // const buffer = Buffer.from(imageData || '', 'base64')
            images.push(new Blob([Buffer.from(imageData.data || '', 'base64')], { type: imageData.mimeType }))
          }
        }
        if (!found) {
          // functionResponse fileData executableCode codeExecutionResult
          log.error(`Unexpected part`, part)
        }
      })
      choices.push({
        index: candidate.index || 0,
        finish_reason: 'stop', //| 'length' | 'tool_calls' | 'content_filter' | 'function_call';
        logprobs: null, //Choice.Logprobs | null;  //ログ確率情報
        message: {
          role: 'assistant', //this.convertRoleGeminitoOpenAI(candidate.content.role),
          content,
          tool_calls: toolCalls,
          refusal: null, // アシスタントからの拒否メッセージ
        },
      })
    })
    return { choices, tokenCount, images }
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
      const properties: { [key: string]: unknown } = {}
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
      let parameters: Schema | undefined = tool.function.parameters as any
      // {
      //   type: FunctionDeclarationSchemaType.STRING, //OpenAIではリターン値の型指定はない SchemaType に変わった
      //   //省略可 format: 'fload', //int32, int64...
      //   description: tool.function.description, //省略可
      //   properties, //省略可 {"name": "wrench", "mass": "1.3kg", "count": "3" }, //OBJECTでのプロパティ
      //   //省略可 required: {name: 'wrench'}, //OBJECTでの必須プロバティ
      //   //省略可 nullable: true,
      //   //省略可 emum: [ "EAST", "NORTH", "SOUTH", "WEST"], //STRINGでの有効値
      //   //省略可 items: Schema, //ARRAYの要素スキーマ
      // }
      this.convertType(tool, parameters)
      parameters = this.workaroundObjectNoParameters(parameters)
      functionDeclarations.push({
        name: tool.function.name,
        description: tool.function.description,
        parameters,
      })
    })
    return geminiTool
  }

  private workaroundObjectNoParameters(parameters: Schema | undefined) {
    if (parameters?.type === Type.OBJECT && Object.keys(parameters?.properties ?? []).length === 0) {
      // [400 Bad Request] * GenerateContentRequest.tools[0].function_declarations[0].parameters.properties: should be non-empty for OBJECT type 対策
      // https://ai.google.dev/api/rest/v1beta/cachedContents?hl=ja#Schema では、parameters.properties は省略可能となっているが、d.tsは違う
      // ので、OBJECTだけど、プロパティが無い、パラメータはなきものにする。
      parameters = undefined
    }
    return parameters
  }

  private convertType(tool: OpenAI.Chat.Completions.ChatCompletionTool, parameters: Schema | undefined) {
    // https://ai.google.dev/api/rest/v1beta/cachedContents?hl=ja#type
    const typeMapping: Record<string, Type> = {
      object: Type.OBJECT,
      string: Type.STRING,
      number: Type.NUMBER,
      integer: Type.INTEGER,
      boolean: Type.BOOLEAN,
      array: Type.ARRAY,
    }
    const paramType = tool.function.parameters?.type as unknown as string | undefined
    if (paramType && typeMapping[paramType]) {
      parameters!.type = typeMapping[paramType]
    }
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
        parts: this.mapShotenInlineDataInParts(message.parts ?? []),
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
      inputTokens = (await this.generativeModels.countTokens({ model: this.model, contents })).totalTokens || 0
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
