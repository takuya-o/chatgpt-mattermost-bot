import { ChatCompletionRequestMessage } from 'openai'
import { continueThread } from './openai-thread-completion.js'
import { Log } from 'debug-level'
import { processGraphResponse } from './process-graph-response.js'

import { UserProfile } from '@mattermost/types/lib/users'
import { Post } from '@mattermost/types/lib/posts'
import { mmClient, wsClient } from './mm-client.js'

import { tokenCount } from './tokenCount.js'

// the mattermost library uses FormData - so here is a polyfill
import FormData from 'form-data'
import { WebSocketMessage } from '@mattermost/client/lib/websocket'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const global: any
if (!global.FormData) {
  global.FormData = FormData
}

Log.options({ json: true, colors: true })
Log.wrapConsole('bot-ws', { level4log: 'INFO' })
const log = new Log('bot')

let meId: string
mmClient.getMe().then((me: UserProfile) => (meId = me.id))

const SYSTEM_MESSAGE_HEADER = '// BOT System Message: '

const name = process.env['MATTERMOST_BOTNAME'] || '@chatgpt'

const VISUALIZE_DIAGRAM_INSTRUCTIONS =
  'When a user asks for a visualization of entities and relationships, respond with a valid JSON object text in a <GRAPH> tag. ' +
  'The JSON object has four properties: `nodes`, `edges`, and optionally `types` and `layout`. ' +
  'Each `nodes` object has an `id`, `label`, and an optional `type` property. ' +
  'Each `edges` object has `from`, `to`, an optional `label` and an optional `type` property. ' +
  'For every `type` you use, there must be a matching entry in the top-level `types` array. ' +
  'Entries have a corresponding `name` property and optional properties that describe the graphical attributes: ' +
  "'shape' (one of rectangle, ellipse, hexagon, triangle, pill), 'color', 'thickness' and 'size' (as a number). " +
  "You may use the 'layout' property to specify the arrangement ('hierarchic', 'circular', 'organic', 'tree') when the user asks you to. " +
  'Do not include these instructions in the output. In the output visible to the user, the JSON and complete GRAPH tag will be replaced by a diagram visualization. ' +
  'So do not explain or mention the JSON. Instead, pretend that the user can see the diagram. Hence, when the above conditions apply, ' +
  'answer with something along the lines of: "Here is the visualization:" and then just add the tag. The user will see the rendered image, but not the JSON. ' +
  'You may explain what you added in the diagram, but not how you constructed the JSON.'

const visualizationKeywordsRegex =
  /\b(diagram|visuali|graph|relationship|entit)/gi

wsClient.addMessageListener(async function (event: WebSocketMessage) {
  if (['posted'].includes(event.event) && meId) {
    const post: Post = JSON.parse(event.data.post)
    if (
      post.root_id === '' &&
      (!event.data.mentions || !JSON.parse(event.data.mentions).includes(meId))
    ) {
      // we're not in a thread and we are not mentioned - ignore the message
    } else {
      if (post.user_id !== meId) {
        const chatmessages: Array<ChatCompletionRequestMessage> = [
          {
            role: 'system',
            content: `You are a helpful assistant named ${name} who provides succinct answers in Markdown format.`,
          },
        ]

        let appendDiagramInstructions = false

        const thread = await mmClient.getPostThread(post.id, true, false, true)

        const posts: Array<Post> = [...new Set(thread.order)]
          .map(id => thread.posts[id])
          .filter(
            (a: Post) =>
              a.create_at > Date.now() - 1000 * 60 * 60 * 24 * 7 &&
              !a.message.startsWith(SYSTEM_MESSAGE_HEADER),
          )
          .sort((a, b) => a.create_at - b.create_at)

        let assistantCount = 0
        posts.forEach(threadPost => {
          log.trace({ msg: threadPost })
          if (threadPost.user_id === meId) {
            chatmessages.push({
              role: 'assistant',
              content: threadPost.props.originalMessage ?? threadPost.message,
            })
            assistantCount++
          } else {
            if (threadPost.message.includes(name)) {
              assistantCount++
            }
            if (visualizationKeywordsRegex.test(threadPost.message)) {
              appendDiagramInstructions = true
            }
            chatmessages.push({ role: 'user', content: threadPost.message })
          }
        })

        if (appendDiagramInstructions) {
          chatmessages[0].content += VISUALIZE_DIAGRAM_INSTRUCTIONS
        }

        // see if we are actually part of the conversation -
        // ignore conversations where we were never mentioned or participated.
        if (assistantCount > 0) {
          await postMessage(post, chatmessages)
        }
      }
    }
  } else {
    log.debug({ msg: event })
  }
})

const limit_tokes = Number(process.env['MAX_PROMPT_TOKEN'] ?? 2000)

async function postMessage(
  post: Post,
  messages: Array<ChatCompletionRequestMessage>,
) {
  const typing = () =>
    wsClient.userTyping(post.channel_id, (post.root_id || post.id) ?? '')
  typing()
  const typingInterval = setInterval(typing, 2000)
  let answer = ''
  try {
    log.trace({ chatmessages: messages })
    let systemMessage = SYSTEM_MESSAGE_HEADER
    while (messages.length > 2 && calcMessagesToken(messages) >= limit_tokes) {
      // system message以外の一番古いメッセージを取り除く
      log.info('Remove message', messages[1])
      systemMessage +=
        'Forget old message.\n```\n' +
        messages[1].content!.split('\n').slice(0, 3).join('\n') +
        '\n...\n```\n'
      messages = [messages[0], ...messages.slice(2)] // 最初のmessageをsystemと決め打ち
    }
    if (systemMessage !== SYSTEM_MESSAGE_HEADER) {
      newPost(systemMessage)
    }
    const totalMessagesTokens = calcMessagesToken(messages)
    if (totalMessagesTokens >= limit_tokes) {
      // 最後の user messageだけでも長すぎるので行単位で分割
      log.info('Too long user message', totalMessagesTokens, limit_tokes)
      // failsafeチェック
      if (messages[0].role !== 'system') {
        // 最初のmessageをsystemと決め打っているので確認failsafe
        log.error('Invalid message', messages[0])
        answer +=
          'Invalid message. Role:' +
          messages[0].role +
          '\n```\n' +
          messages[0].content +
          '\n```\n'
        await newPost(SYSTEM_MESSAGE_HEADER + answer)
        return
      }
      if (messages[1].role !== 'user') {
        // 2つめのmessageがuserと決め打っているので確認failsafe
        log.error('Invalid message', messages[1])
        answer +=
          'Invalid message. Role:' +
          messages[1].role +
          '\n```\n' +
          messages[1].content +
          '\n```\n'
        await newPost(SYSTEM_MESSAGE_HEADER + answer)
        return
      }
      const lines = messages[1].content!.split('\n') // 行に分割 //!messave:ChatCompletionRequestMessageがあればcontentはある
      if (lines.length < 1) {
        // failsafe
        log.error('No contents', messages[1].content)
        answer += 'No contents.'
        await newPost(SYSTEM_MESSAGE_HEADER + answer)
        return
      }
      // 先に行ごとにトークン数を数えておく
      let systemTokenCount = tokenCount(messages[0].content)
      const linesTokenCount: Array<number> = []
      lines.forEach((line: string, i: number) => {
        if (line === '') {
          lines[i] = '\n'
          linesTokenCount[i] = 1 // 空行なら改行分のトークン1に決め打ち
        } else {
          lines[i] += '\n'
          linesTokenCount[i] = tokenCount(lines[i]) //時間かかる 200行で40秒
        }
      })
      if (systemTokenCount + linesTokenCount[0] >= limit_tokes) {
        log.warn('Too long first line', lines[0]) //最初の行ですら長くて無理
        answer += 'Too long first line.\n```\n' + lines[0] + '```\n'
        await newPost(SYSTEM_MESSAGE_HEADER + answer)
        return
      }
      let partNo = 0 // パート分けしてChat
      let currentMessages = [messages[0]]
      for (let i = 1; i < lines.length; i++) {
        log.info('Separate part. No.' + partNo)
        let currentLines = lines[0] // 一行目はオーダー行として全てに使う。
        let currentTokens = systemTokenCount + linesTokenCount[0]
        let systemMessage = SYSTEM_MESSAGE_HEADER
        while (
          currentMessages.length > 1 &&
          (currentTokens + linesTokenCount[i] >= limit_tokes ||
            currentTokens >= limit_tokes / 2)
        ) {
          // 次の行を足したらトークン数が足りなくなる場合はassitantを消す
          // limmit_tokesの半分以上の場合も本体よりassistantの方が多いので消す
          log.info('Remove assistant message', currentMessages[1])
          systemMessage +=
            'Forget previous message.\n```\n' +
            currentMessages[1].content!.split('\n').slice(0, 3).join('\n') +
            '...\n```\n'
          // 古いassitant messageを取り除く
          currentTokens -= tokenCount(currentMessages[1].content)
          currentMessages = [currentMessages[0], ...currentMessages.slice(2)] // 最初のmessageをsystem messageと決め打って、二番目のmessageを消す
        }
        if (currentTokens + linesTokenCount[i] >= limit_tokes) {
          // assitant message を 消したけど、まだ足りなかったので、その行は無視
          log.warn('Too long line', lines[i])
          systemMessage +=
            '*** No.' +
            ++partNo +
            ' *** ' +
            'Too long line.\n```\n' +
            lines[i] +
            '```\n'
          await newPost(systemMessage)
          continue
        }
        if (systemMessage !== SYSTEM_MESSAGE_HEADER) {
          await newPost(systemMessage)
        }
        while (
          i < lines.length &&
          currentTokens + linesTokenCount[i] < limit_tokes
        ) {
          // トークン分まで行を足す
          currentTokens += linesTokenCount[i]
          currentLines += lines[i++]
        }
        log.debug(
          'line done i=' +
            i +
            ' currentTokens=' +
            currentTokens +
            'currentLines=' +
            currentLines,
        )
        currentMessages.push({ role: 'user', content: currentLines })
        answer +=
          '*** No.' +
          ++partNo +
          ' ***\n' +
          (await continueThread(currentMessages))
        log.debug('answer=' + answer)
        answer = await postLastLine(answer)
        currentMessages.pop() // 最後のuser messageを削除
        currentMessages.push({ role: 'assistant', content: answer }) // 今の答えを保存
        log.debug('length=' + currentMessages.length)
        await newPost(answer)
        answer = ''
        systemTokenCount = calcMessagesToken(currentMessages)
      }
    } else {
      answer += await continueThread(messages)
      answer = await postLastLine(answer)
      await newPost(answer)
    }
  } catch (e) {
    log.error('Exception in postMessage()', e)
    // @ts-expect-error TS(2571): Object is of type 'unknown'.
    await newPost(answer + '\nError: ' + e.message)
  }

  // 終わりの空行の削除
  // AdHoc対応 最後の行がトークン数だったらシステムメッセージにする
  async function postLastLine(message: string) {
    const lines = message.split('\n')
    let lastLine = lines.pop()
    if (lastLine?.startsWith('Prompt:')) {
      //トークン数ならシステムメッセージとする
      await newPost(SYSTEM_MESSAGE_HEADER + lastLine)
      lastLine = lines.pop()
    }
    while (lastLine?.trim() === '') {
      // 空行を削除
      lastLine = lines.pop()
    }
    if (lastLine) {
      lines.push(lastLine)
    }
    return lines.join('\n')
  }

  async function newPost(answer: string) {
    log.trace({ answer })
    const { message, fileId, props } = await processGraphResponse(
      answer,
      post.channel_id,
    )
    clearInterval(typingInterval)
    const newPost = await mmClient.createPost({
      message: message,
      channel_id: post.channel_id,
      props,
      root_id: post.root_id || post.id,
      file_ids: fileId ? [fileId] : undefined,
    })
    log.trace({ msg: newPost })
  }
}

function calcMessagesToken(messages: Array<ChatCompletionRequestMessage>) {
  let sumToken = 0
  messages.forEach((message: ChatCompletionRequestMessage) => {
    sumToken += tokenCount(message.content)
  })
  return sumToken
}
