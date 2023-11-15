import { AiResponse, MattermostMessageData } from '../types.js'
import { PluginBase } from './PluginBase.js'

export class ExitPlugin extends PluginBase<never> {
  private name = process.env['MATTERMOST_BOTNAME'] || '@chatgpt'

  async runPlugin(_args: never, _msgData: MattermostMessageData): Promise<AiResponse> {
    return {
      message: 'Goodbye! :wave:\n```' + this.name + ' left the conversation.```',
      props: { bot_status: 'stopped' },
    }
  }
}
