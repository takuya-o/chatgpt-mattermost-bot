import { AiResponse, MattermostMessageData } from '../types.js'
import { createChatCompletion, createImage } from '../openai-wrapper.js'
import FormData from 'form-data'
import { PluginBase } from './PluginBase.js'
import { mmClient } from '../mm-client.js'

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

  setup(): boolean {
    this.addPluginArgument('imageDescription', 'string', 'The description of the image provided by the user')

    const plugins = process.env['PLUGINS']
    if (!plugins || plugins.indexOf('image-plugin') === -1) return false

    return super.setup()
  }

  async runPlugin(args: ImagePluginArgs, msgData: MattermostMessageData): Promise<AiResponse> {
    const aiResponse: AiResponse = {
      message: 'Sorry, I could not execute the image plugin.',
    }

    try {
      const imagePrompt = await this.createImagePrompt(args.imageDescription)
      if (imagePrompt) {
        this.log.trace({ imageInputPrompt: args.imageDescription, imageOutputPrompt: imagePrompt })
        const base64Image = /*this.img256 //*/ /*this.sampleB64String */ await createImage(imagePrompt)
        if (base64Image) {
          const fileId = await this.base64ToFile(base64Image, msgData.post.channel_id)
          aiResponse.message = 'Here is the image you requested: ' + imagePrompt
          aiResponse.props = {
            originalMessage: 'Sure here is the image you requested. <IMAGE>' + imagePrompt + '</IMAGE>',
          }
          aiResponse.fileId = fileId // mattermostのFileIDで一つだけファイルをリターンできる
        }
      }
    } catch (e) {
      this.log.error(e)
      this.log.error(`The input was:\n\n${args.imageDescription}`)
      aiResponse.message += `\n${(e as Error).message}\nThe input was:${args.imageDescription}`
    }

    return aiResponse
  }

  async createImagePrompt(userInput: string): Promise<string | null | undefined> {
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

    const response = await createChatCompletion(messages) //TODO トークン数の記録
    return response?.responseMessage?.content
  }

  async base64ToFile(b64String: string, channelId: string) {
    const form = new FormData()
    form.append('channel_id', channelId)
    // const bin = atob(b64String)
    // const buffer = new Uint8Array(bin.length)
    // for (let i = 0; i < bin.length; i++) {
    //   buffer[i] = bin.charCodeAt(i)
    // }
    // form.append('files', new Blob([buffer], { type: 'image/png' }), 'image.png')
    form.append('files', Buffer.from(b64String, 'base64'), 'image.png')
    const response = await mmClient.uploadFile(form)
    this.log.trace('Uploaded a file with id', response.file_infos[0].id)
    return response.file_infos[0].id
  }
}
