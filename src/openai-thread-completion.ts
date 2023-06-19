import {
  Configuration,
  OpenAIApi,
  ChatCompletionRequestMessage,
  CreateChatCompletionResponse,
} from 'openai'
import { AxiosResponse } from 'axios'
import { Log } from 'debug-level'

Log.options({ json: true, colors: true })
const log = new Log('bot-openai')
const configuration = new Configuration({
  apiKey: process.env['OPENAI_API_KEY'],
})
const azureOpenAiApiKey = process.env['AZURE_OPENAI_API_KEY']
if (azureOpenAiApiKey) {
  configuration.baseOptions = {
    headers: { 'api-key': azureOpenAiApiKey },
    params: {
      'api-version': process.env['AZURE_OPENAI_API_VERSION'] ?? '2023-05-15',
    },
  }
  configuration.basePath =
    'https://' +
    process.env['AZURE_OPENAI_API_INSTANCE_NAME'] +
    '.openai.azure.com/openai/deployments/' +
    process.env['AZURE_OPENAI_API_DEPLOYMENT_NAME' ?? 'gpt-35-turbo']
}
const openai = new OpenAIApi(configuration)

const model = process.env['OPENAI_MODEL_NAME'] ?? 'gpt-3.5-turbo'
const max_tokens = Number(process.env['OPENAI_MAX_TOKENS'] ?? 2000)
const temperature = Number(process.env['OPENAI_TEMPERATURE'] ?? 1)

export async function continueThread(
  messages: Array<ChatCompletionRequestMessage>,
) {
  let answer = ''
  try {
    const response = await openai.createChatCompletion({
      messages: messages,
      model: model,
      max_tokens: max_tokens,
      temperature: temperature,
    })
    log.info(response)
    answer =
      response.data?.choices?.[0]?.message?.content +
      formatUsageStatistics(response)
  } catch (e) {
    log.error(e)
    // @ts-expect-error TS(2571): Object is of type 'unknown'.
    answer = 'Error: ' + e.message
  }
  return answer

  function formatUsageStatistics(
    response: AxiosResponse<CreateChatCompletionResponse>,
  ) {
    return (
      '\n\nPrompt:' +
      response.data.usage?.prompt_tokens +
      ' Completion:' +
      response.data.usage?.completion_tokens +
      ' Total:' +
      response.data.usage?.total_tokens
    )
  }
}
