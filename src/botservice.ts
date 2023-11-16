import 'isomorphic-fetch'
import { JSONMessageData, MattermostMessageData } from './types.js'
import { botLog, matterMostLog } from './logging.js'
import { mmClient, wsClient } from './mm-client.js'
import { ExitPlugin } from './plugins/ExitPlugin.js'
// the mattermost library uses FormData - so here is a polyfill
// Upstream import 'babel-polyfill'
import FormData from 'form-data'
import { GraphPlugin } from './plugins/GraphPlugin.js'
import { ImagePlugin } from './plugins/ImagePlugin.js'
import { MessageCollectPlugin } from './plugins/MessageCollectPlugin.js'
import OpenAI from 'openai'
import { PluginBase } from './plugins/PluginBase.js'
import { Post } from '@mattermost/types/lib/posts'
import { WebSocketMessage } from '@mattermost/client'
import { postMessage } from './postMessage.js'
import { registerChatPlugin } from './openai-wrapper.js'
import sharp from 'sharp'

declare const global: {
  FormData: typeof FormData
}
if (!global.FormData) {
  global.FormData = FormData
}

const name = process.env['MATTERMOST_BOTNAME'] || '@chatgpt'
const contextMsgCount = Number(process.env['BOT_CONTEXT_MSG'] ?? 100)
export const SYSTEM_MESSAGE_HEADER = '// BOT System Message: '
export const LIMIT_TOKENS = Number(process.env['MAX_PROMPT_TOKENS'] ?? 2000)

/* List of all registered plugins */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const plugins: PluginBase<any>[] = [
  new GraphPlugin('graph-plugin', 'Generate a graph based on a given description or topic'),
  new ImagePlugin('image-plugin', 'Generates an image based on a given image description.'),
  new ExitPlugin('exit-plugin', 'Says goodbye to the user and wish him a good day.'),
  new MessageCollectPlugin('message-collect-plugin', 'Collects messages in the thread for a specific user or time'),
]

/* The main system instruction for GPT */
const botInstructions =
  'Your name is ' +
  name +
  ' and you are a helpful assistant. Whenever users asks you for help you will ' +
  "provide them with succinct answers formatted using Markdown. You know the user's name as it is provided within the " +
  'meta data of the messages.'

async function onClientMessage(msg: WebSocketMessage<JSONMessageData>, meId: string) {
  if ((msg.event !== 'posted' && msg.event !== 'post_edited') || !meId) {
    matterMostLog.debug('Event not posted ', msg.event, { msg })
    return
  }

  const msgData = parseMessageData(msg.data)
  const posts = await getOlderPosts(msgData.post, {
    lookBackTime: 1000 * 60 * 60 * 24 * 7,
    postCount: contextMsgCount,
  })

  if (await isMessageIgnored(msgData, meId, posts)) {
    return
  }
  botLog.trace({ threadPosts: posts })

  const chatmessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: 'system' as const, // ChatCompletionRequestMessageRoleEnum.System,
      content: botInstructions,
    },
  ]
  await appendThreadPosts(posts, meId, chatmessages)

  await postMessage(msgData, chatmessages)
}

// 今までスレッドのPostを取得してChatMessageに組み立てる
async function appendThreadPosts(
  posts: Post[],
  meId: string,
  chatmessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
) {
  for (const threadPost of posts) {
    matterMostLog.trace({ msg: threadPost })
    if (threadPost.user_id === meId) {
      // bot自身のメッセージなのでassitantに入れる
      // assitant は content: string | null でArrayはないので画像は取り込めない
      chatmessages.push({
        role: 'assistant' as never,
        name: await userIdToName(threadPost.user_id),
        content: threadPost.props.originalMessage ?? threadPost.message,
      })
    } else {
      // Mattermost スレッドに画像の有無で処理が変わる
      // .metadata.files[] extension mime_type id height width  mini_preview=JPEG16x16
      if (threadPost.metadata.files?.length > 0 || threadPost.metadata.images) {
        // 画像つきのPost TODO: すべての過去画像を入れるのか?
        // textとimage_urlの配列を準備
        const content: Array<OpenAI.Chat.ChatCompletionContentPart> = [{ type: 'text', text: threadPost.message }]
        // Mattermost内部の画像
        await Promise.all(
          threadPost.metadata.files.map(async file => {
            //const url = (await mmClient.getFilePublicLink(file.id)).link
            const originalUrl = await mmClient.getFileUrl(file.id, NaN) //これではOpenAIから見えない
            // urlの画像を取得してBASE64エンコードされたURLにする
            const url = await getBase64Image(originalUrl)
            if (url) {
              content.push(
                { type: 'image_url', image_url: { url } }, //detail?: 'auto' | 'low' | 'high' はdefaultのautoで
              )
            } //画像取得が失敗した場合は無視
          }),
        )
        // 外部画像URL
        if (threadPost.metadata.images) {
          Object.keys(threadPost.metadata.images).forEach(url => {
            content.push({ type: 'image_url', image_url: { url } })
          })
        }
        chatmessages.push({
          role: 'user' as never,
          name: await userIdToName(threadPost.user_id),
          content,
        })
      } else {
        // テキストだけのPost
        chatmessages.push({
          role: 'user' as never,
          name: await userIdToName(threadPost.user_id),
          content: threadPost.message,
        })
      }
    }
  }
}

async function getBase64Image(url: string): Promise<string> {
  // fetch the image
  const token = mmClient.getToken()
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`, // Add the Authentication header here
    },
  })
  // error handling if the fetch failed
  if (!response.ok) {
    matterMostLog.error(`Fech Image URL HTTP error! status: ${response.status}`)
    return ''
  }
  let buffer = Buffer.from(await response.arrayBuffer())
  let { width = 0, height = 0, format = '' } = await sharp(buffer).metadata()
  // サポートしている画像形式はPNG, JPEG, WEBP, GIF
  // see: https://platform.openai.com/docs/guides/vision/what-type-of-files-can-i-upload
  if (!['png', 'jpeg', 'webp', 'gif'].includes(format)) {
    matterMostLog.warn(`Unsupported image format: ${format}. Converting to JPEG.`)
    buffer = await sharp(buffer).jpeg().toBuffer()
    format = 'jpeg'
  }
  // 画像の短辺は768px、長辺は2,000px以下に縮小する
  const shortEdge = 768
  const longEdge = 1024 //仕様上は2000 //$0.00765 vs $0.01445 倍違うので
  if (width > longEdge || height > longEdge) {
    const resizeRatio = longEdge / Math.max(width, height)
    width *= resizeRatio
    height *= resizeRatio
  }
  if (Math.min(width, height) > shortEdge) {
    const resizeRatio = shortEdge / Math.min(width, height)
    width *= resizeRatio
    height *= resizeRatio
  }
  buffer = await sharp(buffer)
    .resize({
      width: Math.round(width),
      height: Math.round(height),
    })
    .toBuffer()
  // Convert the buffer to a data URL
  const mimeType = `image/${format}`
  const base64 = buffer.toString('base64')
  const dataURL = 'data:' + mimeType + ';base64,' + base64
  return dataURL
}

/**
 * Checks if we are responsible to answer to this message.
 * We do only respond to messages which are posted in a thread or addressed to the bot. We also do not respond to
 * message which were posted by the bot.
 * @param msgData The parsed message data
 * @param meId The mattermost client id
 * @param previousPosts Older posts in the same channel
 */
async function isMessageIgnored(msgData: MattermostMessageData, meId: string, previousPosts: Post[]): Promise<boolean> {
  // it is our own message
  if (msgData.post.user_id === meId) {
    return true // 自分自身のメッセージの場合
  }

  // チャンネルではなく自分自身へのDMなのか調べる
  const channelId = msgData.post.channel_id
  const channel = await mmClient.getChannel(channelId)
  const members = await mmClient.getChannelMembers(channelId)
  if (channel.type === 'D' && members.length === 2 && members.find(member => member.user_id === meId)) {
    // 自分のDMだったので、スレッドもメンションされていなくても返信する stopも効かない
    return false
  } else {
    // we are not in a thread and not mentioned
    if (msgData.post.root_id === '' && !msgData.mentions.includes(meId)) {
      return true // スレッドではなく、メンションされていない場合
    }
  }

  for (let i = previousPosts.length - 1; i >= 0; i--) {
    // we were asked to stop participating in the conversation
    if (previousPosts[i].props.bot_status === 'stopped') {
      return true // 会話から退出するように要求された場合
    }

    if (previousPosts[i].user_id === meId || previousPosts[i].message.includes(name)) {
      // we are in a thread were we are actively participating, or we were mentioned in the thread => respond
      return false // アクティブに参加している場合またはスレッドでメンションされている場合は返信する
    }
  }

  // we are in a thread but did not participate or got mentioned - we should ignore this message
  return true // スレッドにいるがメンションされていない場合
}

/**
 * Transforms a data object of a WebSocketMessage to a JS Object.
 * @param msg The WebSocketMessage data.
 */
function parseMessageData(msg: JSONMessageData): MattermostMessageData {
  return {
    mentions: JSON.parse(msg.mentions ?? '[]'),
    post: JSON.parse(msg.post),
    sender_name: msg.sender_name,
  }
}

/**
 * Looks up posts which where created in the same thread and within a given timespan before the reference post.
 * @param refPost The reference post which determines the thread and start point from where older posts are collected.
 * @param options Additional arguments given as object.
 * <ul>
 *     <li><b>lookBackTime</b>: The look back time in milliseconds. Posts which were not created within this time before the
 *     creation time of the reference posts will not be collected anymore.</li>
 *     <li><b>postCount</b>: Determines how many of the previous posts should be collected. If this parameter is omitted all posts are returned.</li>
 * </ul>
 */
async function getOlderPosts(refPost: Post, options: { lookBackTime?: number; postCount?: number }) {
  const thread = await mmClient.getPostThread(refPost.id, true, false, true /*関連するユーザを取得*/)

  let posts: Post[] = [...new Set(thread.order)]
    .map(id => thread.posts[id])
    .filter(a => !a.message.startsWith(SYSTEM_MESSAGE_HEADER)) //システムメッセージから始まるメッセージの削除
    .map(post => {
      //システムメッセージの行の削除
      post.message = post.message.replace(new RegExp(`^${SYSTEM_MESSAGE_HEADER}.+$`, 'm'), '')
      return post
    })
    .sort((a, b) => a.create_at - b.create_at)

  if (options.lookBackTime && options.lookBackTime > 0) {
    posts = posts.filter(a => a.create_at > refPost.create_at - options.lookBackTime!)
  }
  if (options.postCount && options.postCount > 0) {
    posts = posts.slice(-options.postCount) //新しい投稿を指定された個数残す
  }

  return posts
}

const usernameCache: Record<string, { username: string; expireTime: number }> = {}

/**
 * Looks up the mattermost username for the given userId. Every username which is looked up will be cached for 5 minutes.
 * @param userId
 */
async function userIdToName(userId: string): Promise<string> {
  let username: string

  // check if userId is in cache and not outdated
  if (usernameCache[userId] && Date.now() < usernameCache[userId].expireTime) {
    username = usernameCache[userId].username
  } else {
    // username not in cache our outdated
    username = (await mmClient.getUser(userId)).username

    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(username)) {
      username = username.replace(/[.@!?]/g, '_').slice(0, 64)
    }

    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(username)) {
      username = [...username.matchAll(/[a-zA-Z0-9_-]/g)].join('').slice(0, 64)
    }

    usernameCache[userId] = {
      username: username,
      expireTime: Date.now() + 1000 * 60 * 5,
    }
  }

  return username
}

/* Entry point */
async function main(): Promise<void> {
  const meId = (await mmClient.getMe()).id

  botLog.log('Connected to Mattermost.')

  for (const plugin of plugins) {
    if (plugin.setup()) {
      registerChatPlugin(plugin)
      botLog.trace('Registered plugin ' + plugin.key)
    }
  }

  wsClient.addMessageListener(e => onClientMessage(e, meId))
  botLog.trace('Listening to MM messages...')
}

main().catch(reason => {
  botLog.error(reason)
  process.exit(-1)
})
