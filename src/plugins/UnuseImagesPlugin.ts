import { AiResponse, MattermostMessageData } from '../types.js'
import { OpenAIWrapper } from '../OpenAIWrapper.js'
import { PluginBase } from './PluginBase.js'

export class UnuseImagesPlugin extends PluginBase<never> {
  async runPlugin(_args: never, _msgData: MattermostMessageData, openAIWrapper: OpenAIWrapper): Promise<AiResponse> {
    // TODO: msgData.mentions.includes(meId) のときだけ反応したい、でもmeIdとれない
    return {
      message: 'No use images! :stop_sign:\n```' + openAIWrapper.getAIProvidersName() + ' left the conversation.```',
      props: { bot_images: 'stopped' },
    }
  }
}
