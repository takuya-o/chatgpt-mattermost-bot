import { BotService } from './BotService'
import { MattermostClient } from './MattermostClient'
import { OpenAIWrapper } from './OpenAIWrapper'
import { ProviderConfig } from './types'
import { botLog } from './logging.js'
import { getConfig } from './config'

const botServices: Record<string, BotService> = {}

/* Entry point */
// eslint-disable-next-line max-lines-per-function
async function main(): Promise<void> {
  const config = getConfig()
  config.bots = config.bots || [{}] // 旧バージョンの環境変数での設定を期待する
  await Promise.all(
    config.bots.map(async (botConfig: ProviderConfig) => {
      const name = botConfig.name ?? process.env['MATTERMOST_BOTNAME']
      if (botServices[name]) {
        botLog.error(`Duplicate bot name detected: ${name}. Ignoring this bot configuration.`, hideTokens(botConfig))
        return
      }
      if (!name) {
        botLog.error('No name. Ignore provider config', hideTokens(botConfig))
        return
      }
      botConfig.name = name
      if (!botConfig.type) {
        // typeが無いので、どのAPI_KEYが環境変数で定義されているかで推測する
        if (
          process.env['AZURE_OPENAI_API_KEY'] ||
          botConfig.apiVersion ||
          botConfig.instanceName ||
          botConfig.deploymentName
        ) {
          botConfig.type = 'azure'
        } else if (process.env['OPENAI_API_KEY']) {
          botConfig.type = 'openai'
        } else if (process.env['GOOGLE_API_KEY']) {
          botConfig.type = 'google'
        } else if (process.env['COHERE_API_KEY']) {
          botConfig.type = 'cohere'
        } else if (process.env['ANTHROPIC_API_KEY']) {
          botConfig.type = 'anthropic'
        } else {
          botLog.error(`${name} No type. Ignore provider config`, hideTokens(botConfig))
          return
        }
        botLog.warn(`${name} No type. Guessing type as ${botConfig.type}.`, hideTokens(botConfig))
      }
      botLog.log(`${name} Connected to Mattermost.`)
      // AZURE_MATTERMOST_TOKEN, GOOGLE_MATTERMOST_TOKEN... を新設
      const mattermostToken =
        botConfig.mattermostToken ??
        process.env[`${name.toUpperCase()}_MATTERMOST_TOKEN`] ??
        process.env[`${botConfig.type.toUpperCase()}_MATTERMOST_TOKEN`] ??
        process.env['MATTERMOST_TOKEN']
      const mattermostClient = new MattermostClient(
        botConfig.mattermostUrl ?? config.MATTERMOST_URL ?? process.env['MATTERMOST_URL'],
        mattermostToken,
      )
      botLog.log(`${name} Start LLM wrapper.`)
      let openAIWrapper: OpenAIWrapper
      try {
        openAIWrapper = new OpenAIWrapper(botConfig, mattermostClient)
      } catch (e) {
        botLog.error(`${name} Failed to create OpenAIWrapper. Ignore it.`, e)
        return
      }
      botLog.log(`${name} Start BotService.`)
      const meId = (await mattermostClient.getClient().getMe()).id
      const botService = new BotService(
        mattermostClient,
        meId,
        name,
        openAIWrapper,
        botConfig.plugins ?? config.PLUGINS ?? process.env['PLUGINS'] ?? 'image-plugin graph-plugin',
      )
      mattermostClient.getWsClient().addMessageListener(e => botService.onClientMessage(e))
      botLog.trace(`${name} Listening to MM messages...`)
      botServices[name] = botService
    }),
  )
  if (Object.keys(botServices).length === 0) {
    botLog.error('No bot is configured. Exiting...')
    process.exit(-1)
  }
  botLog.log('All bots started.', Object.keys(botServices))

  function hideTokens(botConfig: ProviderConfig): ProviderConfig {
    const result = { ...botConfig }
    if (result.mattermostToken) {
      result.mattermostToken = '***'
    }
    if (result.apiKey) {
      result.apiKey = '***'
    }
    if (result.imageKey) {
      result.imageKey = '***'
    }
    if (result.visionKey) {
      result.visionKey = '***'
    }
    return result
  }
}

main().catch(reason => {
  botLog.error(reason)
  process.exit(-1)
})
