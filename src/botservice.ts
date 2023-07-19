import { mmClient, wsClient } from './mm-client.js'

import { ChatCompletionRequestMessage } from 'openai'

// the mattermost library uses FormData - so here is a polyfill
import FormData from 'form-data'

import { Log } from 'debug-level'

import { Post } from '@mattermost/types/lib/posts'
import { UserProfile } from '@mattermost/types/lib/users'
import { WebSocketMessage } from '@mattermost/client/lib/websocket'

import { continueThread } from './openai-thread-completion.js'
import { processGraphResponse } from './process-graph-response.js'
import { tokenCount } from './tokenCount.js'

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

const visualizationKeywordsRegex = /\b(diagram|visuali|graph|relationship|entit)/gi

wsClient.addMessageListener(async function (event: WebSocketMessage) {
  if (['posted'].includes(event.event) && meId) {
    const post: Post = JSON.parse(event.data.post)
    if (post.root_id === '' && (!event.data.mentions || !JSON.parse(event.data.mentions).includes(meId))) {
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
            a => a.create_at > Date.now() - 1000 * 60 * 60 * 24 * 7 && !a.message.startsWith(SYSTEM_MESSAGE_HEADER), //システムメッセージから始まるメッセージの削除
          )
          .map(post => {
            //システムメッセージの行の削除
            post.message = post.message.replace(new RegExp(`^${SYSTEM_MESSAGE_HEADER}.+$`, 'm'), '')
            return post
          })
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

const LIMIT_TOKENS = Number(process.env['MAX_PROMPT_TOKENS'] ?? 2000)

// eslint-disable-next-line max-lines-per-function
async function postMessage(post: Post, messages: Array<ChatCompletionRequestMessage>) {
  const typing = () => wsClient.userTyping(post.channel_id, (post.root_id || post.id) ?? '')
  typing()
  const typingInterval = setInterval(typing, 2000)
  let answer = ''
  let { sumMessagesCount, messagesCount } = calcMessagesTokenCount(messages) //全体トークン数カウント
  try {
    log.trace({ chatmessages: messages })
    let systemMessage = SYSTEM_MESSAGE_HEADER
    ;({
      messages,
      sumMessagesCount: sumMessagesCount,
      messagesCount,
      systemMessage,
    } = expireMessages(messages, sumMessagesCount, messagesCount, systemMessage)) //古いメッセージを消去
    if (systemMessage !== SYSTEM_MESSAGE_HEADER) {
      newPost(systemMessage, post, typingInterval)
    }
    if (sumMessagesCount >= LIMIT_TOKENS) {
      // 最後の user messageだけでも長すぎるので行単位で分割
      log.info('Too long user message', sumMessagesCount, LIMIT_TOKENS)
      // failsafeチェック
      try {
        answer = await faseSafeCheck(messages, answer, post, typingInterval)
      } catch (e) {
        if (e instanceof TypeError) {
          newPost(e.message, post, typingInterval)
          return
        }
        throw e
      }
      const lines = messages[1].content!.split('\n') // 行に分割 //!messave:ChatCompletionRequestMessageがあればcontentはある
      if (lines.length < 1) {
        // failsafe
        log.error('No contents', messages[1].content)
        answer += 'No contents.'
        newPost(SYSTEM_MESSAGE_HEADER + answer, post, typingInterval)
        return
      }
      // 先に行ごとにトークン数も数えておく
      const linesCount: Array<number> = []
      lines.forEach((line: string, i: number) => {
        if (line === '') {
          lines[i] = '\n'
          linesCount[i] = 1 // 空行なら改行分のトークン1に決め打ち
        } else {
          lines[i] += '\n'
          linesCount[i] = tokenCount(lines[i]) //時間かかる 200行で40秒
        }
      })
      if (messagesCount[0] + linesCount[0] >= LIMIT_TOKENS) {
        log.warn('Too long first line', lines[0]) //最初の行ですら長くて無理
        answer += 'Too long first line.\n```\n' + lines[0] + '```\n'
        newPost(SYSTEM_MESSAGE_HEADER + answer, post, typingInterval)
        return
      }
      let partNo = 0 // パート分けしてChat
      let currentMessages = [messages[0]]
      let currentMessagesCount = [messagesCount[0]]
      let sumCurrentMessagesCount = currentMessagesCount[0] //はじめはSystem Prompt分だけ
      for (let i = 1; i < lines.length; i++) {
        log.info('Separate part. No.' + partNo)
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
          log.info('Remove assistant message', currentMessages[1])
          systemMessage +=
            'Forget previous message.\n```\n' +
            currentMessages[1].content!.split('\n').slice(0, 3).join('\n') +
            '...\n```\n'
          // 古いassitant messageを取り除く
          sumCurrentMessagesCount -= currentMessagesCount[1]
          currentMessagesCount = [currentMessagesCount[0], ...currentMessagesCount.slice(2)]
          // 最初のmessageをsystem messageと決め打って、二番目のmessageを消す
          currentMessages = [currentMessages[0], ...currentMessages.slice(2)]
        }
        if (sumCurrentMessagesCount + currentLinesCount + linesCount[i] >= LIMIT_TOKENS) {
          // assitant message を 消したけど、まだ足りなかったので、その行は無視
          log.warn('Too long line', lines[i])
          systemMessage += `*** No.${++partNo} *** Too long line.\n~~~\n${lines[i]}~~~\n`
          await newPost(systemMessage, post, typingInterval) //続くので順番維持のため待つ
          // TODO: 消してしまったassitant messageのroolback
          continue
        }
        if (systemMessage !== SYSTEM_MESSAGE_HEADER) {
          await newPost(systemMessage, post, typingInterval)
        }
        while (i < lines.length && sumCurrentMessagesCount + currentLinesCount + linesCount[i] < LIMIT_TOKENS) {
          // トークン分まで行を足す
          currentLinesCount += linesCount[i]
          currentLines += lines[i++]
        }
        log.debug(`line done i=${i} currentLinesCount=${currentLinesCount} currentLines=${currentLines}`)
        currentMessages.push({ role: 'user', content: currentLines })
        const { answer: completion, usage } = await continueThread(currentMessages)
        answer += `*** No.${++partNo} ***\n${completion}`
        answer = modifyLastLine(answer)
        log.debug('answer=' + answer)
        await newPost(answer, post, typingInterval)
        answer = ''
        currentMessages.pop() // 最後のuser messageを削除
        currentMessages.push({ role: 'assistant', content: answer }) // 今の答えを保存
        currentMessagesCount.push(currentLinesCount)
        sumCurrentMessagesCount += usage.completion_tokens
        log.debug('length=' + currentMessages.length)
      }
    } else {
      const { answer: completion } = await continueThread(messages)
      answer += completion
      answer = modifyLastLine(answer)
      await newPost(answer, post, typingInterval)
      log.debug('answer=' + answer)
    }
  } catch (e) {
    log.error('Exception in postMessage()', e)
    // @ts-expect-error TS(2571): Object is of type 'unknown'.
    await newPost(answer + '\nError: ' + e.message)
  }

  // 終わりの空行の削除
  // AdHoc対応 最後の行がトークン数だったらシステムメッセージにする
  function modifyLastLine(message: string) {
    const lines = message.split('\n')
    let lastLine = lines.pop()
    if (lastLine) {
      if (lastLine.startsWith('Prompt:')) {
        //トークン数ならシステムメッセージとする
        lastLine = SYSTEM_MESSAGE_HEADER + lastLine
      }
      lines.push(lastLine)
    }
    return lines.join('\n')
  }
}

async function newPost(answer: string, post: Post, typingInterval: NodeJS.Timeout) {
  log.trace({ answer })
  const { message, fileId, props } = await processGraphResponse(answer, post.channel_id)
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

function expireMessages(
  messages: ChatCompletionRequestMessage[],
  sumMessagesCount: number,
  messagesCount: number[],
  systemMessage: string,
) {
  while (messages.length > 2 && sumMessagesCount >= LIMIT_TOKENS) {
    // system message以外の一番古いメッセージを取り除く
    log.info('Remove message', messages[1])
    systemMessage += `Forget old message.\n~~~\n${messages[1].content!.split('\n').slice(0, 3).join('\n')}\n...\n~~~\n`
    sumMessagesCount -= messagesCount[1]
    messagesCount = [messagesCount[0], ...messagesCount.slice(2)]
    messages = [messages[0], ...messages.slice(2)] // 最初のmessageをsystemと決め打ち
  }
  return { messages, sumMessagesCount, messagesCount, systemMessage }
}

function calcMessagesTokenCount(messages: Array<ChatCompletionRequestMessage>) {
  let sumMessagesCount = 0
  const messagesCount = new Array<number>(messages.length)
  messages.forEach((message: ChatCompletionRequestMessage, i) => {
    messagesCount[i] = tokenCount(message.content)
    sumMessagesCount += messagesCount[i]
  })
  return { sumMessagesCount, messagesCount }
}

async function faseSafeCheck(
  messages: Array<ChatCompletionRequestMessage>,
  answer: string,
  post: Post,
  typingInterval: NodeJS.Timeout,
): Promise<string> {
  if (messages[0].role !== 'system') {
    // 最初のmessageをsystemと決め打っているので確認failsafe
    log.error('Invalid message', messages[0])
    answer += `Invalid message. Role: ${messages[0].role} \n~~~\n${messages[0].content}\n~~~\n`
    await newPost(SYSTEM_MESSAGE_HEADER + answer, post, typingInterval)
    throw new TypeError(answer)
  }
  if (messages[1].role !== 'user') {
    // 2つめのmessageがuserと決め打っているので確認failsafe
    log.error('Invalid message', messages[1])
    answer += `Invalid message. Role: ${messages[1].role} \n~~~\n${messages[1].content}\n~~~\n`
    await newPost(SYSTEM_MESSAGE_HEADER + answer, post, typingInterval)
    throw new TypeError(answer)
  }
  return answer
}
