import 'isomorphic-fetch'
import { JSONMessageData, MessageData } from './types.js'
import { botLog, matterMostLog } from './logging.js'
import { continueThread, registerChatPlugin } from './openai-wrapper.js'
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
import { tokenCount } from './tokenCount.js'

declare const global: {
  FormData: typeof FormData
}
if (!global.FormData) {
  global.FormData = FormData
}
if (!global.FormData) {
  global.FormData = FormData
}
// Upstream
// if (!global.FormData) {
//     global.FormData = require('form-data')
// }

const name = process.env['MATTERMOST_BOTNAME'] || '@chatgpt'
const contextMsgCount = Number(process.env['BOT_CONTEXT_MSG'] ?? 100)
const SYSTEM_MESSAGE_HEADER = '// BOT System Message: '
const LIMIT_TOKENS = Number(process.env['MAX_PROMPT_TOKENS'] ?? 2000)

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
  if (msg.event !== 'posted' || !meId) {
    matterMostLog.debug({ msg: msg })
    return
  }

  const msgData = parseMessageData(msg.data)
  const posts = await getOlderPosts(msgData.post, { lookBackTime: 1000 * 60 * 60 * 24 * 7 }) //TODO: オプションのpostCount使ってない

  if (isMessageIgnored(msgData, meId, posts)) {
    return
  }

  const chatmessages: OpenAI.Chat.CreateChatCompletionRequestMessage[] = [
    {
      role: 'system' as const, // ChatCompletionRequestMessageRoleEnum.System,
      content: botInstructions,
    },
  ]

  // create the context
  for (const threadPost of posts.slice(-contextMsgCount)) {
    matterMostLog.trace({ msg: threadPost })
    if (threadPost.user_id === meId) {
      chatmessages.push({
        role: 'assistant' as const, //ChatCompletionRequestMessageRoleEnum.Assistant,
        content: threadPost.props.originalMessage ?? threadPost.message,
      })
    } else {
      chatmessages.push({
        role: 'user' as const, //ChatCompletionRequestMessageRoleEnum.User,
        //Not have openai V4 name: await userIdToName(threadPost.user_id),
        content: threadPost.message,
      })
    }
  }

  await postMessage(msgData, chatmessages)
}

//TODO: トークン数でメッセージ分割
// eslint-disable-next-line max-lines-per-function
async function postMessage(msgData: MessageData, messages: Array<OpenAI.Chat.CreateChatCompletionRequestMessage>) {
  // start typing
  const typing = () => wsClient.userTyping(msgData.post.channel_id, (msgData.post.root_id || msgData.post.id) ?? '')
  typing()
  const typingInterval = setInterval(typing, 2000)

  let answer = ''
  let { sumMessagesCount, messagesCount } = calcMessagesTokenCount(messages) //全体トークン数カウント
  try {
    botLog.trace({ chatmessages: messages })
    let systemMessage = SYSTEM_MESSAGE_HEADER
    ;({
      messages,
      sumMessagesCount: sumMessagesCount,
      messagesCount,
      systemMessage,
    } = expireMessages(messages, sumMessagesCount, messagesCount, systemMessage)) //古いメッセージを消去
    if (systemMessage !== SYSTEM_MESSAGE_HEADER) {
      newPost(systemMessage, msgData.post, undefined, undefined)
    }
    if (sumMessagesCount >= LIMIT_TOKENS) {
      // 最後の user messageだけでも長すぎるので行単位で分割
      botLog.info('Too long user message', sumMessagesCount, LIMIT_TOKENS)
      // failsafeチェック
      try {
        answer = await failSafeCheck(messages, answer, msgData.post)
      } catch (e) {
        if (e instanceof TypeError) {
          newPost(e.message, msgData.post, undefined, undefined)
          return
        }
        throw e
      }
      let lines = typeof messages[1].content === 'string' ? messages[1].content.split('\n') : undefined // 行に分割 //!messave:ChatCompletionRequestMessageがあればcontentはある
      if (!lines) {
        // 最近は文字列だけでなく ChatCompletionContentPartText | ChatCompletionContentPartImage のときもある。
        if (messages[1].content) {
          lines = []
          for (let i = 0; messages[1].content.length > i; i++) {
            if ((messages[1].content[i] as OpenAI.Chat.ChatCompletionContentPartText).type === 'text') {
              lines.push(...(messages[1].content[i] as OpenAI.Chat.ChatCompletionContentPartText).text.split('\n'))
            }
            // TODO: image_urlのときは? see:https://github.com/openai/openai-node/blob/2242688f14d5ab7dbf312d92a99fa4a7394907dc/src/resources/chat/completions.ts#L287
          }
        }
      }
      if (!lines || lines.length < 1) {
        // failsafe
        botLog.error('No contents', messages[1].content)
        answer += 'No contents.'
        newPost(SYSTEM_MESSAGE_HEADER + answer, msgData.post, undefined, undefined)
        return
      }
      // 先に行ごとにトークン数も数えておく
      const linesCount: Array<number> = []
      lines.forEach((line: string, i: number) => {
        if (lines) {
          //当たり前だけどlinterが気が付かない
          if (line === '') {
            lines[i] = '\n'
            linesCount[i] = 1 // 空行なら改行分のトークン1に決め打ち
          } else {
            lines[i] += '\n'
            linesCount[i] = tokenCount(lines[i]) //時間かかる 200行で40秒
          }
        }
      })
      if (messagesCount[0] + linesCount[0] >= LIMIT_TOKENS) {
        botLog.warn('Too long first line', lines[0]) //最初の行ですら長くて無理
        answer += 'Too long first line.\n```\n' + lines[0] + '```\n'
        newPost(SYSTEM_MESSAGE_HEADER + answer, msgData.post, undefined, undefined)
        return
      }
      let partNo = 0 // パート分けしてChat
      let currentMessages = [messages[0]]
      let currentMessagesCount = [messagesCount[0]]
      let sumCurrentMessagesCount = currentMessagesCount[0] //はじめはSystem Prompt分だけ
      for (let i = 1; i < lines.length; i++) {
        botLog.info('Separate part. No.' + partNo)
        let currentLines = lines[0] // 一行目はオーダー行として全てに使う。
        let currentLinesCount = linesCount[0]
        let systemMessage = SYSTEM_MESSAGE_HEADER
        while (
          currentMessages.length > 1 &&
          (sumCurrentMessagesCount + currentLinesCount + linesCount[i] >= LIMIT_TOKENS ||
            sumCurrentMessagesCount + currentLinesCount > LIMIT_TOKENS / 2)
        ) {
          // 次の行を足したらトークン数が足りなくなった場合はassitantを消す
          // assistantが半分以上の場合も本体よりassistantの方が多いので消す
          botLog.info('Remove assistant message', currentMessages[1])
          systemMessage +=
            'Forget previous message.\n```\n' +
            (typeof messages[1].content === 'string'
              ? messages[1].content.split('\n').slice(0, 3).join('\n')
              : currentMessages[1].content) + // ChatCompletionContentPartの場合は考えられていない TODO: 本当はtextを選んで出すべき
            '...\n```\n'
          // 古いassitant messageを取り除く
          sumCurrentMessagesCount -= currentMessagesCount[1]
          currentMessagesCount = [currentMessagesCount[0], ...currentMessagesCount.slice(2)]
          // 最初のmessageをsystem messageと決め打って、二番目のmessageを消す
          currentMessages = [currentMessages[0], ...currentMessages.slice(2)]
        }
        if (sumCurrentMessagesCount + currentLinesCount + linesCount[i] >= LIMIT_TOKENS) {
          // assitant message を 消したけど、まだ足りなかったので、その行は無視
          botLog.warn('Too long line', lines[i])
          systemMessage += `*** No.${++partNo} *** Too long line.\n~~~\n${lines[i]}~~~\n`
          await newPost(systemMessage, msgData.post, undefined, undefined) //続くので順番維持のため待つ
          // TODO: 消してしまったassitant messageのroolback
          continue
        }
        if (systemMessage !== SYSTEM_MESSAGE_HEADER) {
          await newPost(systemMessage, msgData.post, undefined, undefined)
        }
        while (i < lines.length && sumCurrentMessagesCount + currentLinesCount + linesCount[i] < LIMIT_TOKENS) {
          // トークン分まで行を足す
          currentLinesCount += linesCount[i]
          currentLines += lines[i++]
        }
        botLog.debug(`line done i=${i} currentLinesCount=${currentLinesCount} currentLines=${currentLines}`)
        currentMessages.push({ role: 'user', content: currentLines })
        const { message: completion, usage, fileId, props } = await continueThread(currentMessages, msgData)
        answer += `*** No.${++partNo} ***\n${completion}`
        answer += makeUsageMessage(usage)
        botLog.debug('answer=' + answer)
        await newPost(answer, msgData.post, fileId, props)
        answer = ''
        currentMessages.pop() // 最後のuser messageを削除
        currentMessages.push({ role: 'assistant', content: answer }) // 今の答えを保存
        currentMessagesCount.push(currentLinesCount)
        if (usage) {
          sumCurrentMessagesCount += usage.completion_tokens
        }
        botLog.debug('length=' + currentMessages.length)
      }
    } else {
      const { message: completion, usage, fileId, props } = await continueThread(messages, msgData)
      answer += completion
      answer += makeUsageMessage(usage)
      await newPost(answer, msgData.post, fileId, props)
      botLog.debug('answer=' + answer)
    }
  } catch (e) {
    botLog.error('Exception in postMessage()', e)
    answer += '\n' + 'Sorry, but I encountered an internal error when trying to process your message'
    if (e instanceof Error) {
      answer += `\nError: ${e.message}`
    }
    await newPost(answer, msgData.post, undefined, undefined)
  } finally {
    // stop typing
    clearInterval(typingInterval)
  }

  function makeUsageMessage(usage: OpenAI.CompletionUsage | undefined) {
    if (!usage) return ''
    return `\n${SYSTEM_MESSAGE_HEADER}Prompt:${usage.prompt_tokens} Completion:${usage.completion_tokens} Total:${usage.total_tokens}`
  }
}
async function newPost(
  answer: string,
  post: Post,
  fileId: string | undefined,
  props: Record<string, string> | undefined,
) {
  botLog.trace({ answer })
  const newPost = await mmClient.createPost({
    message: answer,
    channel_id: post.channel_id,
    props,
    root_id: post.root_id || post.id,
    file_ids: fileId ? [fileId] : undefined,
  } as Post)
  botLog.trace({ msg: newPost })
}
function expireMessages(
  messages: OpenAI.Chat.CreateChatCompletionRequestMessage[],
  sumMessagesCount: number,
  messagesCount: number[],
  systemMessage: string,
) {
  while (messages.length > 2 && sumMessagesCount >= LIMIT_TOKENS) {
    // system message以外の一番古いメッセージを取り除く
    botLog.info('Remove message', messages[1])
    systemMessage += `Forget old message.\n~~~\n${
      typeof messages[1].content === 'string'
        ? messages[1].content.split('\n').slice(0, 3).join('\n')
        : messages[1].content //TODO: 本当はtextを選んで出すべき
    }\n...\n~~~\n`
    sumMessagesCount -= messagesCount[1]
    messagesCount = [messagesCount[0], ...messagesCount.slice(2)]
    messages = [messages[0], ...messages.slice(2)] // 最初のmessageをsystemと決め打ち
  }
  return { messages, sumMessagesCount, messagesCount, systemMessage }
}
function calcMessagesTokenCount(messages: Array<OpenAI.Chat.CreateChatCompletionRequestMessage>) {
  let sumMessagesCount = 0
  const messagesCount = new Array<number>(messages.length)
  messages.forEach((message: OpenAI.Chat.CreateChatCompletionRequestMessage, i) => {
    messagesCount[i] = typeof message.content === 'string' ? tokenCount(message.content) : 0 //TODO: 本当はtextを選んでカウントすべき
    sumMessagesCount += messagesCount[i]
  })
  return { sumMessagesCount, messagesCount }
}
async function failSafeCheck(
  messages: Array<OpenAI.Chat.CreateChatCompletionRequestMessage>,
  answer: string,
  post: Post,
): Promise<string> {
  if (messages[0].role !== 'system') {
    // 最初のmessageをsystemと決め打っているので確認failsafe
    botLog.error('Invalid message', messages[0])
    answer += `Invalid message. Role: ${messages[0].role} \n~~~\n${messages[0].content}\n~~~\n`
    await newPost(SYSTEM_MESSAGE_HEADER + answer, post, undefined, undefined)
    throw new TypeError(answer)
  }
  if (messages[1].role !== 'user') {
    // 2つめのmessageがuserと決め打っているので確認failsafe
    botLog.error('Invalid message', messages[1])
    answer += `Invalid message. Role: ${messages[1].role} \n~~~\n${messages[1].content}\n~~~\n`
    await newPost(SYSTEM_MESSAGE_HEADER + answer, post, undefined, undefined)
    throw new TypeError(answer)
  }
  return answer
}

/**
 * Checks if we are responsible to answer to this message.
 * We do only respond to messages which are posted in a thread or addressed to the bot. We also do not respond to
 * message which were posted by the bot.
 * @param msgData The parsed message data
 * @param meId The mattermost client id
 * @param previousPosts Older posts in the same channel
 */
function isMessageIgnored(msgData: MessageData, meId: string, previousPosts: Post[]): boolean {
  // we are not in a thread and not mentioned
  if (msgData.post.root_id === '' && !msgData.mentions.includes(meId)) {
    return true // スレッドではなく、メンションされていない場合
  }

  // it is our own message
  if (msgData.post.user_id === meId) {
    return true // 自分自身のメッセージの場合
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
function parseMessageData(msg: JSONMessageData): MessageData {
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
  const thread = await mmClient.getPostThread(refPost.id, true, false, true)

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
    posts = posts.slice(-options.postCount)
  }

  return posts
}

// const usernameCache: Record<string, { username: string; expireTime: number }> = {}

// /**
//  * Looks up the mattermost username for the given userId. Every username which is looked up will be cached for 5 minutes.
//  * @param userId
//  */
// async function userIdToName(userId: string): Promise<string> {
//   let username: string

//   // check if userId is in cache and not outdated
//   if (usernameCache[userId] && Date.now() < usernameCache[userId].expireTime) {
//     username = usernameCache[userId].username
//   } else {
//     // username not in cache our outdated
//     username = (await mmClient.getUser(userId)).username

//     if (!/^[a-zA-Z0-9_-]{1,64}$/.test(username)) {
//       username = username.replace(/[.@!?]/g, '_').slice(0, 64)
//     }

//     if (!/^[a-zA-Z0-9_-]{1,64}$/.test(username)) {
//       username = [...username.matchAll(/[a-zA-Z0-9_-]/g)].join('').slice(0, 64)
//     }

//     usernameCache[userId] = {
//       username: username,
//       expireTime: Date.now() + 1000 * 60 * 5,
//     }
//   }

//   return username
// }

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
