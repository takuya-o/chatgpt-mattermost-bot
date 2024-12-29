import { BotService } from './BotService'
import { MattermostClient } from './MattermostClient'
import { OpenAIWrapper } from './OpenAIWrapper'
import { ProviderConfig } from './types'
import { botLog } from './logging.js'
import { getConfig } from './config'

const botServices: Record<string, BotService> = {}

/* Entry point */
async function main(): Promise<void> {
  const config = getConfig()
  config.bots.forEach(async (botConfig: ProviderConfig) => {
    if (!botConfig.name) {
      botLog.error('No  name. Ignore provider config', botConfig)
      return
    }
    botLog.log(`${botConfig.name} Connected to Mattermost.`)
    const mattermostClient = new MattermostClient(
      botConfig.mattermostUrl ?? config.MATTERMOST_URL,
      botConfig.mattermostToken,
    )
    if (!botConfig.apiKey) {
      botLog.error('No apiKey. Ignore provider config', botConfig)
      return
    }
    let openAIWrapper: OpenAIWrapper
    try {
      openAIWrapper = new OpenAIWrapper(botConfig, mattermostClient)
    } catch (e) {
      botLog.error(`${botConfig.name} Failed to create OpenAIWrapper. Ignore it.`, e)
      return
    }
    botLog.log(`${botConfig.name} Start BotService.`)
    const meId = (await mattermostClient.getClient().getMe()).id
    const botService = new BotService(
      mattermostClient,
      meId,
      botConfig.name,
      openAIWrapper,
      botConfig.plugins ?? config.PLUGINS,
    )
    mattermostClient.getWsClient().addMessageListener(e => botService.onClientMessage(e))
    botLog.trace(`${botConfig.name} Listening to MM messages...`)
    botServices[botConfig.name] = botService
  })
}

main().catch(reason => {
  botLog.error(reason)
  process.exit(-1)
})
