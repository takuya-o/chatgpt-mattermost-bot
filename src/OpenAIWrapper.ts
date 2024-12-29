/* eslint-disable max-lines */
import { AIProvider, shortenString } from './AIProvider'
import { AIProviders, AiResponse, MattermostMessageData, ProviderConfig } from './types.js'
import { AnthropicAdapter } from './adapters/AnthropicAdapter'
import { CohereAdapter } from './adapters/CohereAdapter'
import { GoogleGeminiAdapter } from './adapters/GoogleGeminiAdapter'
import { MattermostClient } from './MattermostClient'
import OpenAI from 'openai'
import { OpenAIAdapter } from './adapters/OpenAIAdapter'
import { PluginBase } from './plugins/PluginBase.js'
import { getConfig } from './config.js'
import { openAILog as log } from './logging.js'

export class OpenAIWrapper {
  private name: string
  private provider: AIProviders
  private plugins: Map<string, PluginBase<unknown>> = new Map()
  private functions: OpenAI.Chat.ChatCompletionCreateParams.Function[] = []
  private MAX_TOKENS: number
  private TEMPERATURE: number
  private MAX_PROMPT_TOKENS: number
  public getMaxPromptTokens() {
    return this.MAX_PROMPT_TOKENS
  }

  private mattermostCLient: MattermostClient
  public getMattemostClient() {
    return this.mattermostCLient
  }

  // eslint-disable-next-line max-lines-per-function
  constructor(providerConfig: ProviderConfig, mattermostClient: MattermostClient) {
    this.mattermostCLient = mattermostClient
    const yamlConfig = getConfig()
    this.MAX_TOKENS = providerConfig.maxTokens ?? Number(yamlConfig.OPENAI_MAX_TOKENS ?? 2000)
    this.TEMPERATURE = providerConfig.temperature ?? Number(yamlConfig.OPENAI_TEMPERATURE ?? 1)
    this.MAX_PROMPT_TOKENS = providerConfig.maxPromptTokens ?? Number(yamlConfig.MAX_PROMPT_TOKENS ?? 2000)
    if (!providerConfig.apiKey || !providerConfig.name) {
      log.error('No apiKey or name. Ignore provider config', providerConfig)
      throw new Error('No apiKey or name. Ignore provider config')
    }
    this.name = providerConfig.name
    // TODO: name重複チェック
    let chatProvider: AIProvider
    let imageProvider: AIProvider | undefined = undefined
    let visionProvider: AIProvider | undefined = undefined
    switch (providerConfig.type) {
      case 'azure':
        chatProvider = new OpenAIAdapter({
          apiKey: providerConfig.apiKey,
          baseURL: `https://${providerConfig.instanceName}.openai.azure.com/openai/deployments/${providerConfig.deploymentName}`,
          defaultQuery: { 'api-version': providerConfig.apiVersion },
          defaultHeaders: { 'api-key': providerConfig.apiKey },
        })
        // イメージ生成用のエンドポイントを用意する
        if (providerConfig.imageKey && providerConfig.imageDeploymentName) {
          imageProvider = new OpenAIAdapter({
            // Azureは東海岸(dall-e-2)やスエーデン(dall-e-3)しかDALL-Eが無いので新規に作る
            apiKey: providerConfig.imageKey,
            baseURL: `https://${providerConfig.imageInstanceName ?? providerConfig.instanceName}.openai.azure.com/openai/deployments/${providerConfig.imageDeploymentName}`,
            defaultQuery: { 'api-version': providerConfig.apiVersion ?? '2024-10-21' },
            defaultHeaders: { 'api-key': providerConfig.imageKey },
          })
        }
        // ビジョン用のエンドポイントを用意する
        if (providerConfig.visionKey && providerConfig.visionDeploymentName) {
          visionProvider = new OpenAIAdapter({
            apiKey: providerConfig.visionKey,
            baseURL: `https://${providerConfig.visionInstanceName ?? providerConfig.instanceName}.openai.azure.com/openai/deployments/${providerConfig.visionDeploymentName}`,
            defaultQuery: { 'api-version': providerConfig.apiVersion ?? '2024-10-21' },
            defaultHeaders: { 'api-key': providerConfig.visionKey },
          })
        }
        // 前にimageProviderなどが定義されていてmodelNameがあればそれを使う 前はopenaiを期待している
        ;({ imageProvider, visionProvider } = this.setImageAndVisionProvider(
          providerConfig,
          imageProvider,
          visionProvider,
        ))
        this.provider = {
          chatProvider,
          imageProvider,
          visionProvider,
          type: providerConfig.type,
          modelName: providerConfig.modelName ?? 'gpt-4o-mini',
          imageModelName: providerConfig.imageModelName,
          visionModelName: providerConfig.visionModelName,
        }
        break
      case 'anthropic':
        chatProvider = new AnthropicAdapter({ apiKey: providerConfig.apiKey })
        //AnthropicにimageはvisionなさそうなのでvisionModelNameがあり定義されていれば前のを使う
        ;({ imageProvider, visionProvider } = this.setImageAndVisionProvider(
          providerConfig,
          imageProvider,
          visionProvider,
        ))
        this.provider = {
          chatProvider,
          imageProvider,
          visionProvider,
          type: providerConfig.type,
          modelName: providerConfig.modelName ?? 'claude-3-opus-20240229',
          imageModelName: providerConfig.imageModelName,
          visionModelName: providerConfig.visionModelName,
        }
        break
      case 'cohere':
        chatProvider = new CohereAdapter({ apiKey: providerConfig.apiKey })
        //CohereにvisionないのでvisionModelNameがあり定義されていれば前のを使う
        ;({ imageProvider, visionProvider } = this.setImageAndVisionProvider(
          providerConfig,
          imageProvider,
          visionProvider,
        ))
        this.provider = {
          chatProvider,
          imageProvider,
          visionProvider,
          type: providerConfig.type,
          modelName: providerConfig.modelName ?? 'command-r-plus',
          imageModelName: providerConfig.imageModelName,
          visionModelName: providerConfig.visionModelName,
        }
        break
      case 'google':
        chatProvider = new GoogleGeminiAdapter(
          providerConfig.apiKey,
          providerConfig.modelName,
          this.MAX_TOKENS,
          this.TEMPERATURE,
        )
        if (!imageProvider!) {
          imageProvider = chatProvider
        }
        // 前にimageProviderが定義されていればそれを使う
        visionProvider = undefined //GoogleはVisionもあるのでchatProviderを使う
        this.provider = {
          chatProvider,
          imageProvider,
          visionProvider,
          type: providerConfig.type,
          modelName: providerConfig.modelName ?? 'gemini-1.5-flash',
          imageModelName: providerConfig.imageModelName,
          visionModelName: providerConfig.visionModelName,
        }
        break
      case 'openai':
        chatProvider = new OpenAIAdapter({
          apiKey: providerConfig.apiKey,
          baseURL: providerConfig.apiBase,
        })
        if (providerConfig.imageModelName) {
          imageProvider = chatProvider //imageModelNameが有れば使う
        }
        if (providerConfig.visionModelName) {
          visionProvider = chatProvider //visionModelNameが有れば使う
        }
        this.provider = {
          chatProvider,
          imageProvider,
          visionProvider,
          type: providerConfig.type,
          modelName: providerConfig.modelName ?? 'gpt-4o-mini',
          imageModelName: providerConfig.imageModelName,
          visionModelName: providerConfig.visionModelName,
        }
        break
      default:
        log.error('Unknown LLM provider type. "`${providerConfig.type}`"', providerConfig)
        throw new Error('Unknown LLM provider type. "`${providerConfig.type}`"')
    }
    log.debug(`AIProvider: ${providerConfig.name}`, this.provider)
  }

  private setImageAndVisionProvider(
    providerConfig: ProviderConfig,
    imageProvider: AIProvider | undefined,
    visionProvider: AIProvider | undefined,
  ) {
    if (!providerConfig.imageModelName && !providerConfig.imageDeploymentName && imageProvider!) {
      // imageModelNameがない場合はimageProviderは無し
      imageProvider = undefined
    }
    // 前にimageProviderが定義されていればそれを使う
    if (!providerConfig.visionModelName && !providerConfig.visionDeploymentName && visionProvider!) {
      // visionModelNameがない場合はvisionProviderは無し
      visionProvider = undefined
    }
    return { imageProvider, visionProvider }
  }

  public getAIProvider(): AIProviders {
    return this.provider
  }

  public getAIProvidersName(): string {
    return this.name
  }

  public registerChatPlugin(plugin: PluginBase<unknown>) {
    this.plugins.set(plugin.key, plugin)
    this.functions.push({
      name: plugin.key,
      description: plugin.description,
      parameters: {
        type: 'object',
        properties: plugin.pluginArguments,
        required: plugin.requiredArguments,
      },
    })
  }

  /**
   * Sends a message thread to chatGPT. The response can be the message responded by the AI model or the result of a
   * plugin call.
   * @param messages The message thread which should be sent.
   * @param msgData The message data of the last mattermost post representing the newest message in the message thread.
   * @param provider The provider to use for the chat completion.
   */
  // eslint-disable-next-line max-lines-per-function
  public async continueThread(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    msgData: MattermostMessageData,
  ): Promise<AiResponse> {
    this.logMessages(messages)
    const NO_MESSAGE = 'Sorry, but it seems I found no valid response.'
    const promptTokensDetails: OpenAI.Completions.CompletionUsage.PromptTokensDetails = { cached_tokens: 0 }
    let aiResponse: AiResponse = {
      message: NO_MESSAGE,
      usage: { prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: promptTokensDetails, total_tokens: 0 },
      model: '',
    }

    // the number of rounds we're going to run at maximum
    let maxChainLength = 7

    // check whether ChatGPT hallucinates a plugin name.
    const missingPlugins = new Set<string>()

    let isIntermediateResponse = true
    while (isIntermediateResponse && maxChainLength-- > 0) {
      const { responseMessage, finishReason, usage, model } = await this.createChatCompletion(messages, this.functions)
      //chatCompletion.choices?.[0]?.messageで同じログが出ている log.trace("responseMessage: ", responseMessage)
      if (responseMessage) {
        aiResponse.model += model + ' '
        if (usage && aiResponse.usage) {
          aiResponse.usage.prompt_tokens += usage.prompt_tokens
          aiResponse.usage.completion_tokens += usage.completion_tokens
          aiResponse.usage.prompt_tokens_details!.cached_tokens! += usage?.prompt_tokens_details?.cached_tokens
            ? usage.prompt_tokens_details.cached_tokens
            : 0
          aiResponse.usage.total_tokens += usage.total_tokens
        }
        // function_callは古い 新しいのは tools_calls[].functionなので、そちらにする
        if (responseMessage.function_call) {
          if (!responseMessage.tool_calls) {
            responseMessage.tool_calls = []
          }
          responseMessage.tool_calls.push({
            id: '',
            type: 'function',
            function: responseMessage.function_call,
          })
        }
        // if the function_call is set, we have a plugin call
        if (responseMessage.tool_calls) {
          await Promise.all(
            responseMessage.tool_calls.map(async tool_call => {
              if (tool_call.type !== 'function') {
                return
              }
              const pluginName = tool_call.function.name
              log.trace({ pluginName })
              try {
                const plugin = this.plugins.get(pluginName)
                if (plugin) {
                  aiResponse.model += pluginName + ' '
                  const pluginArguments = JSON.parse(tool_call.function.arguments ?? '[]') // JSON.parse例外出るかも
                  log.trace({ plugin, pluginArguments })
                  const pluginResponse = await plugin.runPlugin(pluginArguments, msgData, this)
                  log.trace({ pluginResponse })
                  if (pluginResponse.intermediate) {
                    messages.push({
                      role: 'function' as const, //ChatCompletionResponseMessageRoleEnum.Function,
                      name: pluginName,
                      content: pluginResponse.message,
                    })
                    return //continue
                  }
                  pluginResponse.model = aiResponse.model
                  pluginResponse.usage = aiResponse.usage
                  aiResponse = pluginResponse
                } else {
                  if (!missingPlugins.has(pluginName)) {
                    missingPlugins.add(pluginName)
                    log.debug({
                      error: 'Missing plugin ' + pluginName,
                      pluginArguments: tool_call.function.arguments,
                    })
                    messages.push({
                      role: 'system',
                      content: `There is no plugin named '${pluginName}' available. Try without using that plugin.`,
                    })
                    return //continue
                  } else {
                    log.debug({ messages })
                    aiResponse.message = `Sorry, but it seems there was an error when using the plugin \`\`\`${pluginName}\`\`\`.`
                  }
                }
              } catch (e) {
                log.debug({ messages, error: e })
                aiResponse.message = `Sorry, but it seems there was an error when using the plugin \`\`\`${pluginName}\`\`\`.`
              }
            }),
          )
        } else if (responseMessage.content) {
          if (NO_MESSAGE === aiResponse.message) {
            aiResponse.message = responseMessage.content //最初のときは上書き
          } else {
            aiResponse.message += responseMessage.content
          }
          if (finishReason === 'length') {
            // MAX_TOKENで切られたので続きがある。
            messages.push({
              role: 'assistant',
              content: responseMessage.content,
            })
            //TODO 永遠は怖い maxChainLength++ //maxカウント外なので戻す
            continue
          }
        }
      }

      isIntermediateResponse = false
    }

    return aiResponse
  }

  /**
   * Logs the provided messages array after serializing and shortening long image URLs.
   *
   * @param {OpenAI.Chat.Completions.ChatCompletionMessageParam[]} messages - An array of chat completion messages.
   */
  private logMessages(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]) {
    log.trace(
      'messages: ',
      //シリアライズでDeep Copy
      (JSON.parse(JSON.stringify(messages)) as OpenAI.Chat.ChatCompletionMessageParam[]).map(message => {
        if (typeof message.content !== 'string') {
          // 画像データのdata:image/png;base64 messages[].content.image_url.url
          // ログでは長いurlの文字列を短くする
          message.content?.forEach(content => {
            const url = shortenString((content as OpenAI.Chat.ChatCompletionContentPartImage).image_url?.url)
            if (url) {
              ;(content as OpenAI.Chat.ChatCompletionContentPartImage).image_url.url = url
            }
          })
        }
        return message
      }),
    )
  }

  /**
   * Creates a openAI chat model response.
   * @param messages The message history the response is created for.
   * @param functions Function calls which can be called by the openAI model
   * @param provider The provider to use for the chat completion.
   *
   */
  public async createChatCompletion(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    functions: OpenAI.Chat.ChatCompletionCreateParams.Function[] | undefined = undefined, //TODO: tools[]化
  ): Promise<{
    responseMessage: OpenAI.Chat.Completions.ChatCompletionMessage | undefined
    usage: OpenAI.CompletionUsage | undefined
    model: string
    finishReason: 'function_call' | 'tool_calls' | 'length' | 'stop' | 'content_filter'
  }> {
    //gpt-4-vision-preview への切り替え
    let useTools = true
    const currentProvider = this.getAIProvider()
    let currentOpenAi = currentProvider.chatProvider
    let currentModel = currentProvider.modelName
    if (currentProvider.type === 'anthropic') {
      // Antrhopicはtoolsやfunctionsはない vision専用Modelもない
      useTools = false
    } else if (currentProvider.visionModelName) {
      // もしVision Modelがあるならば
      messages.some((message: OpenAI.Chat.ChatCompletionMessageParam) => {
        if (typeof message.content !== 'string') {
          // 画像が入っていたのでVision Modelに切り替え
          if (currentProvider.visionModelName.indexOf('gpt-4v') >= 0) {
            // gpt-4vはtoolsはおろかfunctionsも使えない see: https://platform.openai.com/docs/guides/vision/introduction
            useTools = false
          }
          if (currentProvider.visionProvider) {
            currentOpenAi = currentProvider.visionProvider
          }
          currentModel = currentProvider.visionModelName
          return true
        }
      })
    }
    const chatCompletionOptions: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: currentModel,
      messages: messages,
      temperature: this.TEMPERATURE,
    }
    //TODO: messageのTOKEN数から最大値にする。レスポンス長くなるけど翻訳などが一発になる
    if (currentModel.indexOf('o1') === 0) {
      chatCompletionOptions.max_completion_tokens = this.MAX_TOKENS
    } else {
      // gpt-4o では、こちらでないとエラー
      chatCompletionOptions.max_tokens = this.MAX_TOKENS
    }
    if (functions && useTools) {
      if (currentModel.indexOf('gpt-3') >= 0) {
        // gpt-3/gpt-3.5/gpt-3.5-turbo などだったらfunctionsを使う
        chatCompletionOptions.functions = functions
        chatCompletionOptions.function_call = 'auto'
      } else {
        // gpt-4以降の新しいモデルならtoolsに展開
        chatCompletionOptions.tools = functions.map(func => ({ type: 'function', function: func }))
        chatCompletionOptions.tool_choice = 'auto'
      }
    }
    this.logChatCompletionsCreateParameters(chatCompletionOptions)
    const chatCompletion = await currentOpenAi.createMessage(chatCompletionOptions)
    log.trace({ chatCompletion })
    return {
      responseMessage: chatCompletion.choices?.[0]?.message,
      usage: chatCompletion.usage,
      model: chatCompletion.model,
      finishReason: chatCompletion.choices?.[0]?.finish_reason,
    }
  }

  /**
   * Logs the parameters used for creating a chat completion in OpenAI.
   *
   * @param chatCompletionOptions - The options provided to create a chat completion.
   */
  private logChatCompletionsCreateParameters(
    chatCompletionOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ) {
    log.trace('chat.completions.create() Parameters', {
      model: chatCompletionOptions.model,
      max_tokens: chatCompletionOptions.max_tokens,
      temperature: chatCompletionOptions.temperature,
      function_call: chatCompletionOptions.function_call,
      functions: chatCompletionOptions.functions?.map(
        func => `${func.name}(${this.toStringParameters(func.parameters)}): ${func.description}`,
      ),
      tools_choice: chatCompletionOptions.tool_choice,
      tools: chatCompletionOptions.tools?.map(
        tool =>
          `${tool.type} ${tool.function.name}(${this.toStringParameters(tool.function.parameters)}): ${tool.function.description}`,
      ),
    })
  }

  // Function Parametersのプロパティを文字列に展開する
  private toStringParameters(parameters?: OpenAI.FunctionParameters) {
    if (!parameters) {
      return ''
    }
    let string = ''
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const props = parameters.properties as any
    for (const paramKey in props) {
      if (string.length > 0) {
        string += ', '
      }
      string += `${paramKey}:${props[paramKey].type}` // ${props[paramKey].description}
    }
    return string
  }

  /**
   * Creates a openAI DALL-E response.
   * @param prompt The image description provided to DALL-E.
   */
  public async createImage(prompt: string): Promise<string | undefined> {
    const currentProvider = this.getAIProvider()
    const createImageOptions: OpenAI.Images.ImageGenerateParams = {
      model: currentProvider.imageModelName,
      prompt,
      n: 1,
      size: '1024x1024', //Must be one of 256x256, 512x512, or 1024x1024 for dall-e-2. Must be one of 1024x1024, 1792x1024, or 1024x1792 for dall-e-3 models.
      quality: 'standard', //"hd", $0.080/枚=1枚12円で倍額
      response_format: 'b64_json',
    }
    log.trace({ createImageOptions })
    let image: OpenAI.Images.ImagesResponse
    if (currentProvider.type !== 'azure' || currentProvider.imageModelName !== 'dall-e-2') {
      image = await currentProvider.imageProvider.imagesGenerate(createImageOptions)
    } else {
      // AzureはDALL-E2の場合の非同期の特別な対応をしていた
      image = await currentProvider.imageProvider.imagesGenerate(createImageOptions)
    }
    const dataTmp = image.data[0]?.b64_json
    if (dataTmp) {
      image.data[0].b64_json = shortenString(image.data[0].b64_json)
    }
    log.trace('images.generate', { image })
    if (dataTmp) {
      image.data[0].b64_json = dataTmp
    }
    return image.data[0]?.b64_json // TODO revised_promptの利用
  }
}
