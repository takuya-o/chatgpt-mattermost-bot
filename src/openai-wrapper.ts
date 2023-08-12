import { AiResponse, MessageData } from './types.js'
import {
  ChatCompletionFunctions,
  ChatCompletionRequestMessage,
  ChatCompletionResponseMessage,
  ChatCompletionResponseMessageRoleEnum,
  Configuration,
  CreateChatCompletionRequest,
  CreateCompletionResponseUsage,
  CreateImageRequest,
  OpenAIApi,
} from 'openai'
import { PluginBase } from './plugins/PluginBase.js'

import { openAILog as log } from './logging.js'

const apiKey = process.env['OPENAI_API_KEY']
log.trace({ apiKey })

const configuration = new Configuration({ apiKey })
const azureOpenAiApiKey = process.env['AZURE_OPENAI_API_KEY']
if (azureOpenAiApiKey) {
  configuration.baseOptions = {
    headers: { 'api-key': azureOpenAiApiKey },
    params: {
      'api-version': process.env['AZURE_OPENAI_API_VERSION'] ?? '2023-07-01-preview',
    },
  }
  configuration.basePath =
    'https://' +
      process.env['AZURE_OPENAI_API_INSTANCE_NAME'] +
      '.openai.azure.com/openai/deployments/' +
      process.env['AZURE_OPENAI_API_DEPLOYMENT_NAME'] ?? 'gpt-35-turbo'
}
const openai = new OpenAIApi(configuration)
let openaiImage: OpenAIApi
if (azureOpenAiApiKey) {
  // イメージ生成 DALL-E用のOpenAI APIは別のを使う
  const configuration = new Configuration({ apiKey })
  if (!apiKey) {
    // OPENAI_API_KEY が設定されていないのでAzureを使う 動かないけど。
    configuration.baseOptions = {
      headers: { 'api-key': azureOpenAiApiKey },
      params: {
        'api-version': process.env['AZURE_OPENAI_API_VERSION'] ?? '2023-07-01-preview',
      },
    }
    configuration.basePath = 'https://' + process.env['AZURE_OPENAI_API_INSTANCE_NAME'] + '.openai.azure.com/openai'
  }
  openaiImage = new OpenAIApi(configuration)
}

const model = process.env['OPENAI_MODEL_NAME'] ?? 'gpt-3.5-turbo'
const MAX_TOKENS = Number(process.env['OPENAI_MAX_TOKENS'] ?? 2000)
const temperature = Number(process.env['OPENAI_TEMPERATURE'] ?? 1)

log.debug({ model, max_tokens: MAX_TOKENS, temperature })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const plugins: Map<string, PluginBase<any>> = new Map()
const functions: ChatCompletionFunctions[] = []

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
  messages: ChatCompletionRequestMessage[],
  msgData: MessageData,
): Promise<AiResponse> {
  let aiResponse: AiResponse = {
    message: 'Sorry, but it seems I found no valid response.',
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }

  // the number of rounds we're going to run at maximum
  let maxChainLength = 7

  // check whether ChatGPT hallucinates a plugin name.
  const missingPlugins = new Set<string>()

  let isIntermediateResponse = true
  while (isIntermediateResponse && maxChainLength-- > 0) {
    const { responseMessage, usage } = await createChatCompletion(messages, functions)
    log.trace(responseMessage)
    if (responseMessage) {
      if (usage && aiResponse.usage) {
        aiResponse.usage.prompt_tokens += usage.prompt_tokens
        aiResponse.usage.completion_tokens += usage.completion_tokens
        aiResponse.usage.total_tokens += usage.total_tokens
      }
      // if the function_call is set, we have a plugin call
      if (responseMessage.function_call && responseMessage.function_call.name) {
        const pluginName = responseMessage.function_call.name
        log.trace({ pluginName })
        try {
          const plugin = plugins.get(pluginName)
          if (plugin) {
            const pluginArguments = JSON.parse(responseMessage.function_call.arguments ?? '[]')
            log.trace({ plugin, pluginArguments })
            const pluginResponse = await plugin.runPlugin(pluginArguments, msgData)
            log.trace({ pluginResponse })

            if (pluginResponse.intermediate) {
              messages.push({
                role: ChatCompletionResponseMessageRoleEnum.Function,
                name: pluginName,
                content: pluginResponse.message,
              })
              continue
            }
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
  messages: ChatCompletionRequestMessage[],
  functions: ChatCompletionFunctions[] | undefined = undefined,
): Promise<{
  responseMessage: ChatCompletionResponseMessage | undefined
  usage: CreateCompletionResponseUsage | undefined
}> {
  const chatCompletionOptions: CreateChatCompletionRequest = {
    model: model,
    messages: messages,
    max_tokens: MAX_TOKENS,
    temperature: temperature,
  }
  if (functions) {
    chatCompletionOptions.functions = functions
    chatCompletionOptions.function_call = 'auto'
  }

  log.trace({ chatCompletionOptions })

  const chatCompletion = await openai.createChatCompletion(chatCompletionOptions)

  log.trace({ chatCompletion })

  return { responseMessage: chatCompletion.data?.choices?.[0]?.message, usage: chatCompletion.data?.usage }
}

/**
 * Creates a openAI DALL-E response.
 * @param prompt The image description provided to DALL-E.
 */
export async function createImage(prompt: string): Promise<string | undefined> {
  const createImageOptions: CreateImageRequest = {
    prompt,
    n: 1,
    size: '512x512',
    response_format: 'b64_json',
  }
  log.trace({ createImageOptions })
  const image = await (openaiImage ? openaiImage : openai).createImage(createImageOptions)
  log.trace({ image })
  return image.data?.data[0]?.b64_json
}
