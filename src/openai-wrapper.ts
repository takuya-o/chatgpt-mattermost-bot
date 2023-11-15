import { AiResponse, MattermostMessageData } from './types.js'
import OpenAI from 'openai'
import { PluginBase } from './plugins/PluginBase.js'

import { openAILog as log } from './logging.js'

const apiKey = process.env['OPENAI_API_KEY']
// log.trace({ apiKey })

let config = { apiKey } as {
  apiKey: string
  baseURL?: string
  defaultQuery?: Record<string, string>
  defaultHeaders?: Record<string, string>
}
const azureOpenAiApiKey = process.env['AZURE_OPENAI_API_KEY']
if (azureOpenAiApiKey) {
  config = {
    apiKey: azureOpenAiApiKey,
    baseURL: `https://${process.env['AZURE_OPENAI_API_INSTANCE_NAME']}.openai.azure.com/openai/deployments/${
      process.env['AZURE_OPENAI_API_DEPLOYMENT_NAME'] ?? 'gpt-35-turbo'
    }`,
    defaultQuery: { 'api-version': process.env['AZURE_OPENAI_API_VERSION'] ?? '2023-08-01-preview' },
    defaultHeaders: { 'api-key': azureOpenAiApiKey },
  }
}
const openai = new OpenAI(config)
let openaiImage: OpenAI
if (azureOpenAiApiKey) {
  // イメージ生成 DALL-E用のOpenAI APIは別のを使う
  if (!apiKey) {
    // OPENAI_API_KEY が設定されていないのでAzureを使う 動かないけど。
    openaiImage = new OpenAI({
      apiKey: azureOpenAiApiKey,
      baseURL: `https://${process.env['AZURE_OPENAI_API_INSTANCE_NAME']}.openai.azure.com/openai`,
      defaultQuery: { 'api-version': process.env['AZURE_OPENAI_API_VERSION'] ?? '2023-08-01-preview' },
      defaultHeaders: { 'api-key': azureOpenAiApiKey },
    })
  } else {
    openaiImage = new OpenAI({ apiKey })
  }
}

const model = process.env['OPENAI_MODEL_NAME'] ?? 'gpt-3.5-turbo'
const MAX_TOKENS = Number(process.env['OPENAI_MAX_TOKENS'] ?? 2000)
const temperature = Number(process.env['OPENAI_TEMPERATURE'] ?? 1)

log.debug({ model, max_tokens: MAX_TOKENS, temperature })

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
  let aiResponse: AiResponse = {
    message: 'Sorry, but it seems I found no valid response.',
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    model: '',
  }

  // the number of rounds we're going to run at maximum
  let maxChainLength = 7

  // check whether ChatGPT hallucinates a plugin name.
  const missingPlugins = new Set<string>()

  let isIntermediateResponse = true
  while (isIntermediateResponse && maxChainLength-- > 0) {
    const { responseMessage, usage, model } = await createChatCompletion(messages, functions)
    log.trace(responseMessage)
    if (responseMessage) {
      aiResponse.model += model + ' '
      if (usage && aiResponse.usage) {
        aiResponse.usage.prompt_tokens += usage.prompt_tokens
        aiResponse.usage.completion_tokens += usage.completion_tokens
        aiResponse.usage.total_tokens += usage.total_tokens
      }
      // TODO: function_callは古い 新しいのは tools_calls[].function
      // if the function_call is set, we have a plugin call
      if (responseMessage.function_call && responseMessage.function_call.name) {
        const pluginName = responseMessage.function_call.name
        log.trace({ pluginName })
        try {
          const plugin = plugins.get(pluginName)
          if (plugin) {
            aiResponse.model += pluginName + ' '
            const pluginArguments = JSON.parse(responseMessage.function_call.arguments ?? '[]')
            log.trace({ plugin, pluginArguments })
            const pluginResponse = await plugin.runPlugin(pluginArguments, msgData)
            log.trace({ pluginResponse })
            if (pluginResponse.intermediate) {
              messages.push({
                role: 'function' as const, //ChatCompletionResponseMessageRoleEnum.Function,
                name: pluginName,
                content: pluginResponse.message,
              })
              continue
            }
            pluginResponse.model = aiResponse.model
            pluginResponse.usage = aiResponse.usage
            aiResponse = pluginResponse
          } else {
            if (!missingPlugins.has(pluginName)) {
              missingPlugins.add(pluginName)
              log.debug({
                error: 'Missing plugin ' + pluginName,
                pluginArguments: responseMessage.function_call.arguments,
              })
              messages.push({
                role: 'system',
                content: `There is no plugin named '${pluginName}' available. Try without using that plugin.`,
              })
              continue
            } else {
              log.debug({ messages })
              aiResponse.message = `Sorry, but it seems there was an error when using the plugin \`\`\`${pluginName}\`\`\`.`
            }
          }
        } catch (e) {
          log.debug({ messages, error: e })
          aiResponse.message = `Sorry, but it seems there was an error when using the plugin \`\`\`${pluginName}\`\`\`.`
        }
      } else if (responseMessage.content) {
        aiResponse.message = responseMessage.content
      }
    }

    isIntermediateResponse = false
  }

  return aiResponse
}

/**
 * Creates a openAI chat model response.
 * @param messages The message history the response is created for.
 * @param functions Function calls which can be called by the openAI model
 */
export async function createChatCompletion(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  functions: OpenAI.Chat.ChatCompletionCreateParams.Function[] | undefined = undefined,
): Promise<{
  responseMessage: OpenAI.Chat.Completions.ChatCompletionMessage | undefined
  usage: OpenAI.CompletionUsage | undefined
  model: string
}> {
  //gpt-4-vision-preview への切り替え
  let tools = false
  let currentOpenAi = openai
  let currentModel = model
  const visionModel = process.env['OPENAI_VISION_MODEL_NAME']
  if (visionModel) {
    messages.some((message: OpenAI.Chat.ChatCompletionMessageParam) => {
      if (typeof message.content !== 'string') {
        // 画像が入っていたので切り替え
        tools = true
        if (openaiImage) {
          currentOpenAi = openaiImage
        }
        currentModel = visionModel
        return true
      }
    })
  }

  const chatCompletionOptions: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
    model: currentModel,
    messages: messages,
    max_tokens: MAX_TOKENS, //TODO: messageのTOKEN数から最大値にする。レスポンス長くなるけど翻訳などが一発になる
    temperature: temperature,
  }
  if (functions) {
    if (tools) {
      // visionモデルはfunctions使えない?
      // // visionモデルはfunctionsでなくてtoolsなのでfuctnionsをtoolsに展開
      // chatCompletionOptions.tools = []
      // functions?.forEach((funciton) => {
      //   chatCompletionOptions.tools?.push({
      //     type: 'function',
      //     function: funciton
      //   })
      // })
      // chatCompletionOptions.tool_choice = 'auto'
    } else {
      chatCompletionOptions.functions = functions
      chatCompletionOptions.function_call = 'auto'
    }
  }
  log.trace(
    chatCompletionOptions.model,
    chatCompletionOptions.max_tokens,
    chatCompletionOptions.temperature,
    chatCompletionOptions.functions,
    chatCompletionOptions.function_call,
  )
  const chatCompletion = await currentOpenAi.chat.completions.create(chatCompletionOptions)
  log.trace({ chatCompletion })
  return { responseMessage: chatCompletion.choices?.[0]?.message, usage: chatCompletion.usage, model: currentModel }
}

/**
 * Creates a openAI DALL-E response.
 * @param prompt The image description provided to DALL-E.
 */
export async function createImage(prompt: string): Promise<string | undefined> {
  const createImageOptions: OpenAI.Images.ImageGenerateParams = {
    model: process.env['OPENAI_IMAGE_MODEL_NAME'] ?? 'dall-e-2',
    prompt,
    n: 1,
    size: '1024x1024', //Must be one of 256x256, 512x512, or 1024x1024 for dall-e-2. Must be one of 1024x1024, 1792x1024, or 1024x1792 for dall-e-3 models.
    quality: 'standard', //"hd", $0.080/枚=1枚12円で倍額
    response_format: 'b64_json',
  }
  log.trace({ createImageOptions })
  const image = await (openaiImage ? openaiImage : openai).images.generate(createImageOptions)
  log.trace({ image })
  return image.data[0]?.b64_json
}
