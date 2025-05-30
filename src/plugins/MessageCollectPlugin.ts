import { AiResponse, MattermostMessageData } from '../types.js'
import { Client4 } from '@mattermost/client'
import { OpenAIWrapper } from '../OpenAIWrapper.js'
import { PluginBase } from './PluginBase.js'
import { Post } from '@mattermost/types/lib/posts'

type MessageCollectArgs = {
  messageCount?: number
  lookBackTime?: number
}

export class MessageCollectPlugin extends PluginBase<MessageCollectArgs> {
  setup(plugins: string): boolean {
    this.addPluginArgument(
      'lookBackTime',
      'number',
      'The time in milliseconds to look back in time and collect messages which were posted within this timespan. Omit this parameter if the collected messages are independent from the time they were sent.',
      true,
    )
    this.addPluginArgument(
      'messageCount',
      'number',
      'The number of messages which should be collected. Omit this parameter if you want to collect all messages.',
      true,
    )

    if (!this.isEnable(plugins, 'message-collect-plugin')) return false

    return super.setup(plugins)
  }

  async runPlugin(
    args: MessageCollectArgs,
    msgData: MattermostMessageData,
    openAIWrapper: OpenAIWrapper,
  ): Promise<AiResponse> {
    this.log.trace(args)
    return {
      message: JSON.stringify(
        await this.getPosts(
          msgData.post,
          { lookBackTime: args.lookBackTime, postCount: args.messageCount },
          openAIWrapper.getMattermostClient().getClient(),
        ),
      ),
      intermediate: true,
    }
  }

  async getPosts(refPost: Post, options: { lookBackTime?: number; postCount?: number }, client4: Client4) {
    const thread = await client4.getPostThread(refPost.id, true, false, true)

    let posts: Post[] = [...new Set(thread.order)].map(id => thread.posts[id]).sort((a, b) => a.create_at - b.create_at)

    if (options.lookBackTime && options.lookBackTime > 0) {
      posts = posts.filter(a => a.create_at > refPost.create_at - options.lookBackTime!)
    }
    if (options.postCount && options.postCount > 0) {
      posts = posts.slice(-options.postCount)
    }

    const result = []
    const meId = (await client4.getMe())?.id
    for (const threadPost of posts) {
      if (threadPost.user_id === meId) {
        result.push({
          content: threadPost.props.originalMessage ?? threadPost.message,
        })
      } else {
        result.push({
          content: threadPost.message,
        })
      }
    }

    return result
  }
}
