import { AiResponse, MattermostMessageData } from '../types.js'
import { PluginBase } from './PluginBase.js'

export class UnuseImagesPlugin extends PluginBase<never> {
  private name = process.env['MATTERMOST_BOTNAME'] || '@chatgpt'

  async runPlugin(_args: never, _msgData: MattermostMessageData): Promise<AiResponse> {
    // TODO: msgData.mentions.includes(meId) のときだけ反応したい、でもmeIdとれない
    return {
      message: 'No use images! :stop_sign:\n```' + this.name + ' left the conversation.```',
      props: { bot_images: 'stopped' },
    }
  }
}
