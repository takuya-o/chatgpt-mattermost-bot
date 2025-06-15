import { AiResponse, MattermostMessageData } from '../types.js'
import { Client4 } from '@mattermost/client'
import { OpenAIWrapper } from '../OpenAIWrapper.js'
import { PluginBase } from './PluginBase.js'

type ImagePluginArgs = {
  imageDescription: string
}

export class ImagePlugin extends PluginBase<ImagePluginArgs> {
  private readonly GPT_INSTRUCTIONS =
    'You are a prompt engineer who helps a user to create good prompts for ' +
    'the image AI DALL-E. The user will provide you with a short image description and you transform this into a ' +
    'proper prompt text. When creating the prompt first describe the looks and structure of the image. ' +
    'Secondly, describe the photography style, like camera angle, camera position, lenses. Third, describe the ' +
    'lighting and specific colors. Your prompt have to focus on the overall image and not describe any details ' +
    "on it. Consider adding buzzwords, for example 'detailed', 'hyper-detailed', 'very realistic', 'sketchy', " +
    "'street-art', 'drawing', or similar words. Keep the prompt as simple as possible and never get longer than " +
    '400 characters. You may only answer with the resulting prompt and provide no description or explanations.'

  setup(plugins: string): boolean {
    this.addPluginArgument('imageDescription', 'string', 'The description of the image provided by the user')

    if (!this.isEnable(plugins, 'image-plugin')) return false

    return super.setup(plugins)
  }

  async runPlugin(
    args: ImagePluginArgs,
    msgData: MattermostMessageData,
    openAIWrapper: OpenAIWrapper,
  ): Promise<AiResponse> {
    const aiResponse: AiResponse = {
      message: 'Sorry, I could not execute the image plugin.',
    }

    try {
      const imagePrompt = await this.createImagePrompt(args.imageDescription, openAIWrapper)
      if (imagePrompt) {
        this.log.trace({ imageInputPrompt: args.imageDescription, imageOutputPrompt: imagePrompt })
        const base64Image = /*this.img256 //*/ /*this.sampleB64String */ await openAIWrapper.createImage(imagePrompt)
        if (base64Image) {
          const fileId = await this.base64ToFile(
            base64Image,
            msgData.post.channel_id,
            openAIWrapper.getMattermostClient().getClient(),
          )
          aiResponse.message = 'Here is the image you requested: ' + imagePrompt
          aiResponse.props = {
            originalMessage: 'Sure here is the image you requested. <IMAGE>' + imagePrompt + '</IMAGE>',
          }
          aiResponse.fileId = [fileId] // mattermostのFileIDで一つだけファイルをリターンできる
        }
      }
    } catch (e) {
      this.log.error(e)
      this.log.error(`The input was:\n\n${args.imageDescription}`)
      aiResponse.message += `\n${(e as Error).message}\nThe input was:${args.imageDescription}`
    }

    return aiResponse
  }

  async createImagePrompt(userInput: string, openAIWrapper: OpenAIWrapper): Promise<string | null | undefined> {
    const messages = [
      {
        role: 'system' as const, //ChatCompletionRequestMessageRoleEnum.System,
        content: this.GPT_INSTRUCTIONS,
      },
      {
        role: 'user' as const, //ChatCompletionRequestMessageRoleEnum.User,
        content: userInput,
      },
    ]

    const response = await openAIWrapper.createChatCompletion(messages, undefined) //TODO トークン数の記録
    return response?.responseMessage?.content
  }

  async base64ToFile(b64String: string, channelId: string, mattermostClient: Client4) {
    const form = new FormData()
    form.append('channel_id', channelId)
    // const bin = atob(b64String)
    // const buffer = new Uint8Array(bin.length)
    // for (let i = 0; i < bin.length; i++) {
    //   buffer[i] = bin.charCodeAt(i)
    // }
    const fileName = OpenAIWrapper.createImageFileName('image/png')
    form.append('files', new Blob([Buffer.from(b64String, 'base64')], { type: 'image/png' }), fileName)
    // form.append('files', Buffer.from(b64String, 'base64'), 'image.png')
    const response = await mattermostClient.uploadFile(form)
    this.log.trace('Uploaded a file with id', response.file_infos[0].id)
    return response.file_infos[0].id
  }
}
