import { LIMIT_TOKENS, SYSTEM_MESSAGE_HEADER } from './botservice.js'
import { mmClient, wsClient } from './mm-client.js'
import { MattermostMessageData } from './types.js'
import OpenAI from 'openai'
import { Post } from '@mattermost/types/posts'
import { botLog } from './logging.js'
import { continueThread } from './openai-wrapper.js'
import { tokenCount } from './tokenCount.js'

// eslint-disable-next-line max-lines-per-function
export async function postMessage(
  msgData: MattermostMessageData,
  messages: Array<OpenAI.Chat.ChatCompletionMessageParam>,
) {
  // start typing
  const typing = () => wsClient.userTyping(msgData.post.channel_id, (msgData.post.root_id || msgData.post.id) ?? '')
  typing()
  const typingInterval = setInterval(typing, 2000)

  let answer = ''
  let { sumMessagesCount, messagesCount } = calcMessagesTokenCount(messages) //全体トークン数カウント
  try {
    //イメージ入っていると長い botLog.trace({ chatmessages: messages })
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
      // expireしきっていて最後の user messageだけでも長すぎるので行単位で分割
      botLog.info('Too long user message', sumMessagesCount, LIMIT_TOKENS)
      // failsafeチェック
      try {
        answer = await failSafeCheck(messages, answer)
      } catch (e) {
        if (e instanceof TypeError) {
          newPost(SYSTEM_MESSAGE_HEADER + e.message, msgData.post, undefined, undefined)
          return
        }
        throw e
      }
      let lines: string[] = []
      // 行に分割 //!messave:ChatCompletionRequestMessageがあればcontentはある
      if (typeof messages[1].content === 'string') {
        lines = messages[1].content.split('\n')
      } else {
        // 最近は文字列だけでなく ChatCompletionContentPartText | ChatCompletionContentPartImage のときもある。
        if (messages[1].content) {
          for (let i = 0; messages[1].content.length > i; i++) {
            if ((messages[1].content[i] as OpenAI.Chat.ChatCompletionContentPartText).type === 'text') {
              lines.push(...(messages[1].content[i] as OpenAI.Chat.ChatCompletionContentPartText).text.split('\n'))
            }
            // TODO: image_urlのときは? see:https://github.com/openai/openai-node/blob/2242688f14d5ab7dbf312d92a99fa4a7394907dc/src/resources/chat/completions.ts#L287
          }
        }
      }
      if (lines.length < 1) {
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
          systemMessage += mkMessageContentString(messages, 'Forget previous message.')
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
        const { message: completion, usage, fileId, props, model } = await continueThread(currentMessages, msgData)
        answer += `*** No.${++partNo} ***\n${completion}`
        answer += makeUsageMessage(usage, model)
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
      const { message: completion, usage, fileId, props, model } = await continueThread(messages, msgData)
      answer += completion
      answer += makeUsageMessage(usage, model)
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

  function makeUsageMessage(usage: OpenAI.CompletionUsage | undefined, model: string = '') {
    if (!usage && !model) return ''
    let message = `\n${SYSTEM_MESSAGE_HEADER} `
    if (usage) {
      message += ` Prompt:${usage.prompt_tokens} Completion:${usage.completion_tokens} Total:${usage.total_tokens}`
    }
    if (model) {
      message += ` Model:${model}`
    }
    return message
  }
}
async function newPost(
  answer: string,
  post: Post,
  fileId: string | undefined,
  props: Record<string, string> | undefined,
) {
  // botLog.trace({ answer })
  const newPost = await mmClient.createPost({
    message: answer,
    channel_id: post.channel_id,
    props,
    root_id: post.root_id || post.id,
    file_ids: fileId ? [fileId] : undefined,
  } as Post)
  botLog.trace({ newPost })
}
function calcMessagesTokenCount(messages: Array<OpenAI.Chat.ChatCompletionMessageParam>) {
  let sumMessagesCount = 0
  const messagesCount = new Array<number>(messages.length)
  messages.forEach((message: OpenAI.Chat.ChatCompletionMessageParam, i) => {
    messagesCount[i] = 0
    if (typeof message.content === 'string' && message.content.length > 0) {
      messagesCount[i] = tokenCount(message.content)
    } else if (typeof message.content === 'object' && message.content) {
      //  ObjectならArrayと決め打ち
      message.content.forEach(content => {
        // textを選んでカウント
        if (content.type === 'text') {
          messagesCount[i] += tokenCount(content.text)
        }
      })
    }
    sumMessagesCount += messagesCount[i]
  })
  return { sumMessagesCount, messagesCount }
}
async function failSafeCheck(messages: Array<OpenAI.Chat.ChatCompletionMessageParam>, answer: string): Promise<string> {
  if (messages[0].role !== 'system') {
    // 最初のmessageをsystemと決め打っているので確認failsafe
    await throwTypeError(messages[0])
  }
  if (messages[1].role !== 'user') {
    // 2つめのmessageがuserと決め打っているので確認failsafe
    await throwTypeError(messages[1])
  }
  return answer

  async function throwTypeError(message: OpenAI.Chat.ChatCompletionMessageParam) {
    botLog.error('Invalid message', message)
    answer += mkMessageContentString(messages, `Invalid message. Role: ${message.role}`)
    //Postで上位で行う await newPost(SYSTEM_MESSAGE_HEADER + answer, post, undefined, undefined)
    throw new TypeError(answer)
  }
}
function expireMessages(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  sumMessagesCount: number,
  messagesCount: number[],
  systemMessage: string,
) {
  while (messages.length > 2 && sumMessagesCount >= LIMIT_TOKENS) {
    // system message以外の一番古いメッセージを取り除く
    botLog.info('Remove message', messages[1])
    systemMessage += mkMessageContentString(messages, 'Forget old message.')
    sumMessagesCount -= messagesCount[1]
    messagesCount = [messagesCount[0], ...messagesCount.slice(2)]
    messages = [messages[0], ...messages.slice(2)] // 最初のmessageをsystemと決め打ち
  }
  return { messages, sumMessagesCount, messagesCount, systemMessage }
}
function mkMessageContentString(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[], description: string) {
  return `${description}\n~~~\n${
    (typeof messages[1].content === 'string'
      ? messages[1].content
      : messages[1].content?.[0]?.type === 'text'
        ? messages[1].content[0].text
        : ''
    ) //TODO: 本当は次のtextを選んで出すべき
      .split('\n')
      .slice(0, 3)
      .join('\n') //最初の3行だけ取り出す
  }\n...\n~~~\n`
}
