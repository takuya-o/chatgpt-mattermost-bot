import { AiResponse, MattermostMessageData } from '../types.js'
import { OpenAIWrapper } from '../OpenAIWrapper.js'
import { PluginBase } from './PluginBase.js'

export class ExitPlugin extends PluginBase<never> {
  async runPlugin(_args: never, _msgData: MattermostMessageData, openAIWrapper: OpenAIWrapper): Promise<AiResponse> {
    // TODO: msgData.mentions.includes(meId) のときだけ反応したい
    return {
      message: 'Goodbye! :wave:\n```' + openAIWrapper.getAIProvidersName() + ' left the conversation.```',
      props: { bot_status: 'stopped' },
    }
  }
}
