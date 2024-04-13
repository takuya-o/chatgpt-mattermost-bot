import { AIAdapter, AIProvider } from '../AIProvider.js'
import { Content, GenerativeModel, GoogleGenerativeAI } from '@google/generative-ai'
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
        apiVersion: 'v1beta',
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
    const prompt = this.getUserMessage(this.getLastMessage(options.messages)) //最後がユーザのメッセージでないと駄目ので重なるけど

    // const chat = this.generativeModel
    //   .startChat({
    //     history: currentMessages,
    //   })
    // const generateContentResult = await chat.sendMessage(prompt)
    const generateContentResult = await this.generativeModel.generateContent({
      // https://ai.google.dev/api/rest/v1/models/generateContent?hl=ja#request-body
      contents: currentMessages,
      //safetySettings,
      //generationConfig,
      systemInstruction,
      //tools?: Tool[];
      //toolConfig?: ToolConfig;
    })
    log.trace('GenerateContentResult', generateContentResult)
    const responseText = generateContentResult.response.text()
    //log.trace('responseText', responseText)

    // tokenCOuntはv1betaからJavaScript SDK not support yet?
    // let tokenCount = 0
    // generateContentResult.response.candidates?.forEach(candidate => tokenCount += candidat.tokenCount)

    //レスポンスメッセージの詰替え
    const choices: OpenAI.Chat.Completions.ChatCompletion.Choice[] = this.createChoice(responseText) //TODO resposeTextではなくresonse.candidates[]を使う
    const usage = await this.getUsage(currentMessages, prompt, responseText)

    return {
      id: '',
      created: 0,
      object: 'chat.completion', //OputAI固定値
      choices,
      usage,
      model: options.model,
    }
  }
  private createContents(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]) {
    const currentMessages: Content[] = []
    messages.forEach(async message => {
      switch (message.role) {
        // To Google ["user", "model", "function", "system"]
        case 'system':
          //currentMessages.push({ role: 'system', parts: [{ text: message.content as string }] }) //Geminiにsystemは無い。
          currentMessages.push({ role: 'user', parts: [{ text: message.content as string }] }) //Geminiにsystemは無い。
          currentMessages.push({ role: 'model', parts: [{ text: 'OKay' }] }) // user連続もだめ
          break
        case 'user':
          currentMessages.push({ role: 'user', parts: [{ text: this.getUserMessage(message) }] }) //TODO: inlineData対応
          break
        case 'assistant':
          currentMessages.push({ role: 'model', parts: [{ text: message.content as string }] })
          break
        case 'tool':
        case 'function': //Deprecated
        default:
          log.error(`getChatHistory(): ${message.role} not yet support.`, message)
          break
      }
    })
    log.trace('currentMessages():', currentMessages)
    return currentMessages
  }

  private createChoice(responseText: string): OpenAI.Chat.Completions.ChatCompletion.Choice[] {
    return [
      {
        finish_reason: 'stop',
        index: 0,
        logprobs: null, //ログ確率情報
        message: {
          role: 'assistant',
          content: responseText,
        },
      },
    ]
  }

  private async getUsage(
    history: Content[],
    prompt: string,
    responseText: string,
  ): Promise<OpenAI.Completions.CompletionUsage> {
    // usageのためにトークン数を取得する
    // https://ai.google.dev/tutorials/get_started_node?hl=ja#count-tokens
    const msgContent = { role: 'user', parts: [{ text: prompt }] }
    const contents = [...history, msgContent]
    let inputTokens = -1
    let outputTokens = -1
    try {
      inputTokens = (await this.generativeModel.countTokens({ contents })).totalTokens
      outputTokens = (await this.generativeModel.countTokens(responseText)).totalTokens
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
