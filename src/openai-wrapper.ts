import { AIProvider, OpenAiArgs, shortenString } from './AIProvider'
import { AiResponse, MattermostMessageData } from './types.js'
import { AnthropicAdapter } from './adapters/AnthropicAdapter'
import { CohereAdapter } from './adapters/CohereAdapter'
import { GoogleGeminiAdapter } from './adapters/GoogleGeminiAdapter'
import OpenAI from 'openai'
import { OpenAIAdapter } from './adapters/OpenAIAdapter'
import { PluginBase } from './plugins/PluginBase.js'
import { openAILog as log } from './logging.js'

const apiKey = process.env['OPENAI_API_KEY']
const azureOpenAiApiKey = process.env['AZURE_OPENAI_API_KEY']
const azureOpenAiApiVersion = process.env['AZURE_OPENAI_API_VERSION'] ?? '2024-03-01-preview'
const anthropicApiKey = process.env['ANTHROPIC_API_KEY']
const cohereApiKey = process.env['COHERE_API_KEY']
const googleApiKey = process.env['GOOGLE_API_KEY']
const basePath = process.env['OPENAI_API_BASE']
log.trace({ basePath })

let model = process.env['OPENAI_MODEL_NAME'] ?? 'gpt-3.5-turbo'
const MAX_TOKENS = Number(process.env['OPENAI_MAX_TOKENS'] ?? 2000)
const temperature = Number(process.env['OPENAI_TEMPERATURE'] ?? 1)

const azureOpenAiVisionApiKey = process.env['AZURE_OPENAI_API_VISION_KEY']
let visionModel = process.env['OPENAI_VISION_MODEL_NAME'] //Recommend 'gpt-4-vision-preview'

const azureOpenAiImageApiKey = process.env['AZURE_OPENAI_API_IMAGE_KEY']
let imageModel = process.env['OPENAI_IMAGE_MODEL_NAME'] ?? 'dall-e-3'

// log.trace({ apiKey })
if (!apiKey && !azureOpenAiApiKey && !anthropicApiKey && !cohereApiKey && !googleApiKey) {
  log.error('OPENAI_API_KEY, AZURE_OPENAI_API_KEY, ANTHROPIC_API_KEY, COHERE_API_KEY or GOOGLE_API_KEY is not set')
  process.exit(1) //呼び出されるまで落ちないのでrestartストリームにはならない
}

let config: OpenAiArgs = { apiKey, baseURL: basePath }

// テキスト用のエンドポイントを用意する
if (azureOpenAiApiKey) {
  model = process.env['AZURE_OPENAI_API_DEPLOYMENT_NAME'] ?? 'gpt-35-turbo'
  config = {
    apiKey: azureOpenAiApiKey,
    baseURL: `https://${process.env['AZURE_OPENAI_API_INSTANCE_NAME']}.openai.azure.com/openai/deployments/${model}`,
    defaultQuery: { 'api-version': azureOpenAiApiVersion },
    defaultHeaders: { 'api-key': azureOpenAiApiKey },
  }
}

const openai: AIProvider = anthropicApiKey
  ? new AnthropicAdapter({ apiKey: anthropicApiKey })
  : cohereApiKey
    ? new CohereAdapter({ apiKey: cohereApiKey })
    : googleApiKey
      ? new GoogleGeminiAdapter(googleApiKey, model, MAX_TOKENS, temperature)
      : new OpenAIAdapter(config)
log.debug(`OpenAI ${openai?.baseURL}`)

// イメージ生成用のエンドポイントを用意する
let openaiImage: AIProvider = openai
if (azureOpenAiApiKey || azureOpenAiImageApiKey) {
  // イメージ生成 DALL-E用のOpenAI APIは別のを使う
  if (!apiKey || azureOpenAiImageApiKey) {
    // OPENAI_API_KEY が設定されていいないかつAZURE_OPENAI_API_IMAGE_KEY が設定されているのでAzureを使う
    imageModel = process.env['AZURE_OPENAI_API_IMAGE_DEPLOYMENT_NAME'] ?? imageModel
    config = {
      // Azureは東海岸(dall-e-2)やスエーデン(dall-e-3)しかDALL-Eが無いので新規に作る
      apiKey: (azureOpenAiImageApiKey ?? azureOpenAiApiKey) as string,
      baseURL: `https://${
        process.env['AZURE_OPENAI_API_IMAGE_INSTANCE_NAME'] ?? process.env['AZURE_OPENAI_API_INSTANCE_NAME']
      }.openai.azure.com/openai/deployments/${imageModel}`,
      defaultQuery: { 'api-version': azureOpenAiApiVersion },
      defaultHeaders: { 'api-key': (azureOpenAiImageApiKey ?? azureOpenAiApiKey) as string },
    }
    openaiImage = new OpenAIAdapter(config)
  } else {
    // OPENAI_API_KEY が設定されているのでImage APIは本家OpenAI APIを使う
    if (azureOpenAiApiKey) {
      openaiImage = new OpenAIAdapter({ apiKey })
    } else {
      openaiImage = openai // すでに有る本家OpenAIのエンドポイントを使う
    }
  }
}
log.debug(`Image ${openaiImage.baseURL}`)

// Vision用のエンドポイントを用意する
let openaiVision: AIProvider = openai
if (azureOpenAiApiKey || azureOpenAiVisionApiKey) {
  // Vision用のOpenAI APIは別のを使う
  if (!apiKey || azureOpenAiVisionApiKey) {
    // OPENAI_API_KEY が設定されていいないかつAZURE_OPENAI_API_VISION_KEY が設定されているのでAzureを使う
    visionModel =
      process.env['AZURE_OPENAI_API_VISION_DEPLOYMENT_NAME'] ?? process.env['AZURE_OPENAI_API_DEPLOYMENT_NAME']
    config = {
      // Azureは、まだgpt-4Vないけど将来のため準備
      apiKey: (azureOpenAiVisionApiKey ?? azureOpenAiApiKey) as string,
      baseURL: `https://${
        process.env['AZURE_OPENAI_API_VISION_INSTANCE_NAME'] ?? process.env['AZURE_OPENAI_API_INSTANCE_NAME']
      }.openai.azure.com/openai/deployments/${visionModel}`,
      defaultQuery: { 'api-version': azureOpenAiApiVersion },
      defaultHeaders: { 'api-key': (azureOpenAiVisionApiKey ?? azureOpenAiApiKey) as string },
    }
    openaiVision = new OpenAIAdapter(config)
  } else {
    // Vision用のOpenAI APIは本家OpenAI APIを使う
    if (azureOpenAiApiKey && azureOpenAiImageApiKey) {
      openaiVision = new OpenAIAdapter({ apiKey })
    } else {
      openaiVision = openai // すでに有る本家OpenAIのエンドポイントを使う
    }
  }
}
log.debug(`Vision ${openaiVision.baseURL}`)
log.debug('Models and parameters: ', { model, visionModel, imageModel, max_tokens: MAX_TOKENS, temperature })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const plugins: Map<string, PluginBase<any>> = new Map()
const functions: OpenAI.Chat.ChatCompletionCreateParams.Function[] = []

/**
 * Registers a plugin as a GPT function. These functions are sent to openAI when the user interacts with chatGPT.
 * @param plugin
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerChatPlugin(plugin: PluginBase<any>) {
  plugins.set(plugin.key, plugin)
  functions.push({
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
 */
// eslint-disable-next-line max-lines-per-function
export async function continueThread(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  msgData: MattermostMessageData,
): Promise<AiResponse> {
  logMessages(messages)
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
    const { responseMessage, finishReason, usage, model } = await createChatCompletion(messages, functions)
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
              const plugin = plugins.get(pluginName)
              if (plugin) {
                aiResponse.model += pluginName + ' '
                const pluginArguments = JSON.parse(tool_call.function.arguments ?? '[]') // JSON.parse例外出るかも
                log.trace({ plugin, pluginArguments })
                const pluginResponse = await plugin.runPlugin(pluginArguments, msgData)
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
function logMessages(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]) {
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
 */
export async function createChatCompletion(
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
  let currentOpenAi = openai
  let currentModel = model
  if (anthropicApiKey) {
    // Antrhopicはtoolsやfunctionsはない vision専用Modelもない
    useTools = false
  } else if (visionModel) {
    // もしVision Modelがあるならば
    messages.some((message: OpenAI.Chat.ChatCompletionMessageParam) => {
      if (typeof message.content !== 'string') {
        // 画像が入っていたのでVision Modelに切り替え
        if (visionModel.indexOf('gpt-4v') >= 0) {
          // gpt-4vはtoolsはおろかfunctionsも使えない see: https://platform.openai.com/docs/guides/vision/introduction
          useTools = false
        }
        if (openaiVision) {
          currentOpenAi = openaiVision
        }
        currentModel = visionModel || currentModel
        return true
      }
    })
  }
  const chatCompletionOptions: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
    model: currentModel,
    messages: messages,
    temperature: temperature,
  }
  //TODO: messageのTOKEN数から最大値にする。レスポンス長くなるけど翻訳などが一発になる
  if (currentModel.indexOf('o1') === 0) {
    chatCompletionOptions.max_completion_tokens = MAX_TOKENS
  } else {
    // gpt-4o では、こちらでないとエラー
    chatCompletionOptions.max_tokens = MAX_TOKENS
  }
  if (functions && useTools) {
    if (model.indexOf('gpt-3') >= 0) {
      // gpt-3/gpt-3.5/gpt-3.5-turbo などだったらfunctionsを使う
      chatCompletionOptions.functions = functions
      chatCompletionOptions.function_call = 'auto'
    } else {
      // gpt-4以降の新しいモデルならtoolsに展開
      chatCompletionOptions.tools = functions.map(func => ({ type: 'function', function: func }))
      chatCompletionOptions.tool_choice = 'auto'
    }
  }
  logChatCompletionsCreateParameters(chatCompletionOptions)
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
function logChatCompletionsCreateParameters(
  chatCompletionOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
) {
  log.trace('chat.completions.create() Parameters', {
    model: chatCompletionOptions.model,
    max_tokens: chatCompletionOptions.max_tokens,
    temperature: chatCompletionOptions.temperature,
    function_call: chatCompletionOptions.function_call,
    functions: chatCompletionOptions.functions?.map(
      func => `${func.name}(${toStringParameters(func.parameters)}): ${func.description}`,
    ),
    tools_choice: chatCompletionOptions.tool_choice,
    tools: chatCompletionOptions.tools?.map(
      tool =>
        `${tool.type} ${tool.function.name}(${toStringParameters(tool.function.parameters)}): ${tool.function.description}`,
    ),
  })
}

/* Function Parametersのプロパティを文字列に展開する */
function toStringParameters(parameters?: OpenAI.FunctionParameters) {
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
export async function createImage(prompt: string): Promise<string | undefined> {
  const createImageOptions: OpenAI.Images.ImageGenerateParams = {
    model: imageModel,
    prompt,
    n: 1,
    size: '1024x1024', //Must be one of 256x256, 512x512, or 1024x1024 for dall-e-2. Must be one of 1024x1024, 1792x1024, or 1024x1792 for dall-e-3 models.
    quality: 'standard', //"hd", $0.080/枚=1枚12円で倍額
    response_format: 'b64_json',
  }
  log.trace({ createImageOptions })
  let image: OpenAI.Images.ImagesResponse
  // AzureだけどOPENAI_IMAGE_MODELをしてくれていればDALL-E2の場合の特別な対応をする
  if (!azureOpenAiImageApiKey || imageModel !== 'dall-e-2') {
    image = await openaiImage.imagesGenerate(createImageOptions)
  } else {
    // Azure OpenAIのdall-e-2の場合は非同期なので特別な対応が必要
    const url = `https://${
      process.env['AZURE_OPENAI_API_IMAGE_INSTANCE_NAME'] ?? process.env['AZURE_OPENAI_API_INSTANCE_NAME']
    }.openai.azure.com/openai/images/generate:submit?api-version=${azureOpenAiApiVersion}`
    const headers = { 'api-key': azureOpenAiImageApiKey ?? '', 'Content-Type': 'application/json' }
    const submission = await fetch(url, { headers, method: 'POST', body: JSON.stringify(createImageOptions) })
    if (!submission.ok) {
      log.error(`Failed to submit request ${url}}`)
      return undefined // 何らかのエラー
    }
    const operationLocation = submission.headers.get('operation-location')
    if (!operationLocation) {
      log.error(`No operation location ${url}`)
      return undefined // 何らかのエラー
    }
    let result: { status: string; result?: OpenAI.Images.ImagesResponse } = { status: 'unknown' }
    while (result.status != 'succeeded') {
      await new Promise(resolve => setTimeout(resolve, 1000)) // 1秒待機
      const response = await fetch(operationLocation, { headers })
      if (!response.ok) {
        log.error(`Failed to get status ${url}`)
        return undefined // 何らかのエラー
      }
      result = (await response.json()) as { status: string; result?: OpenAI.Images.ImagesResponse }
    }
    if (result?.result) {
      image = result.result
    } else {
      log.error(`No result ${url}`)
      return undefined // 何らかのエラー
    }
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
