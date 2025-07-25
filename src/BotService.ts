/* eslint-disable max-lines */
//import 'isomorphic-fetch'
import { JSONMessageData, MattermostMessageData } from './types.js'
import { OpenGraphMetadata, Post } from '@mattermost/types/lib/posts'
import { botLog, matterMostLog } from './logging.js'
import { ExitPlugin } from './plugins/ExitPlugin.js'
// the mattermost library uses FormData - so here is a polyfill
// Upstream import 'babel-polyfill'
import FormData from 'form-data'
import { GraphPlugin } from './plugins/GraphPlugin.js'
import { ImagePlugin } from './plugins/ImagePlugin.js'
import { MattermostClient } from './MattermostClient.js'
import { MessageCollectPlugin } from './plugins/MessageCollectPlugin.js'
import OpenAI from 'openai'
import { OpenAIWrapper } from './OpenAIWrapper.js'
import { PluginBase } from './plugins/PluginBase.js'
import { UnuseImagesPlugin } from './plugins/UnuseImagesPlugin.js'
import { WebSocketMessage } from '@mattermost/client'
import { getConfig } from './config.js'
import { postMessage } from './postMessage.js'
import sharp from 'sharp'

// グローバルオブジェクトにFormDataを設定
declare const global: {
  FormData: typeof FormData
}
if (!global.FormData) {
  global.FormData = FormData
}

const config = getConfig()
const contextMsgCount = Number(config.BOT_CONTEXT_MSG ?? process.env['BOT_CONTEXT_MSG'] ?? 100)
export const SYSTEM_MESSAGE_HEADER = '// BOT System Message: '
const additionalBotInstructions =
  config.BOT_INSTRUCTION ??
  process.env['BOT_INSTRUCTION'] ??
  'You are a helpful assistant. Whenever users asks you for help you will ' +
    "provide them with succinct answers formatted using Markdown. You know the user's name as it is provided within the " +
    'meta data of the messages.'

export class BotService {
  private mattermostClient: MattermostClient
  private meId: string // ex. @ChatGPTのID
  private name: string // ex. @ChatGPT
  private openAIWrapper: OpenAIWrapper

  public getMattermostClient(): MattermostClient {
    return this.mattermostClient
  }
  public getOpenAIWrapper() {
    return this.openAIWrapper
  }

  constructor(
    mattermostClient: MattermostClient,
    meId: string,
    name: string,
    openAIWrapper: OpenAIWrapper,
    plugins: string,
  ) {
    this.mattermostClient = mattermostClient
    this.meId = meId
    this.name = name
    this.openAIWrapper = openAIWrapper
    /* List of all registered plugins */
    const pluginsAvailable: PluginBase<unknown>[] = [
      new GraphPlugin('graph-plugin', 'Generate a graph based on a given description or topic'),
      new ImagePlugin('image-plugin', 'Generates an image based on a given image description.'),
      new ExitPlugin('exit-plugin', 'Says goodbye to the user and wish him a good day.'),
      new MessageCollectPlugin('message-collect-plugin', 'Collects messages in the thread for a specific user or time'),
      new UnuseImagesPlugin('unuse-images-plugin', 'Ignore images when asked to "ignore images".'), // 画像を無視してGPT-4に戻す まだGPT-4Vではfunction使えないけどね
    ]
    for (const plugin of pluginsAvailable) {
      if (plugin.setup(plugins)) {
        this.openAIWrapper.registerChatPlugin(plugin)
        botLog.trace(`${name} Registered plugin ${plugin.key}`)
      }
    }
  }

  // クライアントメッセージを処理する
  async onClientMessage(msg: WebSocketMessage<JSONMessageData>) {
    if ((msg.event !== 'posted' && msg.event !== 'post_edited') || !this.meId) {
      matterMostLog.debug(`Event not posted: ${msg.event}`)
      return
    }

    const msgData = this.parseMessageData(msg.data)
    const posts = await this.getOlderPosts(msgData.post, {
      lookBackTime: 1000 * 60 * 60 * 24 * 7,
      postCount: contextMsgCount,
    })

    if (await this.isMessageIgnored(msgData, posts)) {
      return
    }
    matterMostLog.trace({ threadPosts: posts }) // Mattermostのスレッド全部

    const chatmessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      {
        role: 'system' as const, // ChatCompletionRequestMessageRoleEnum.System,
        content: 'Your name is ' + this.name + '. ' + additionalBotInstructions,
      },
    ]
    await this.appendThreadPosts(posts, chatmessages, await this.isUnuseImages(posts))
    await postMessage(this, msgData, chatmessages, this.meId, this.openAIWrapper.getMaxPromptTokens())
  }

  /**
   * Appends thread posts to the chat messages array, formatting them based on the content and metadata.
   * 今までスレッドのPostを取得してChatMessageに組み立てる
   *
   * @param posts - An array of Post objects to be appended.
   * @param meId - The ID of the current user (bot).
   * @param chatmessages - An array of chat completion message parameters where the formatted messages will be appended.
   * @param unuseImages - A boolean indicating whether to omit images from the messages.
   */
  // スレッドの投稿をチャットメッセージに追加する
  // eslint-disable-next-line max-lines-per-function
  private async appendThreadPosts(
    posts: Post[],
    chatmessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    unuseImages: boolean,
  ) {
    for (const threadPost of posts) {
      let role: never = 'user' as never // ChatCompletionRequestMessageRoleEnum.User
      let message = threadPost.message
      if (threadPost.user_id === this.meId) {
        // bot自身のメッセージなのでassitantに入れる
        // assitant は content: に画像は取り込めない
        role = 'assistant' as never
        if (threadPost.props.originalMessage) {
          message = threadPost.props.originalMessage as string
        }
      }
      // Mattermost スレッドに画像の有無で処理が変わる
      // .metadata.files[] extension mime_type id height width  mini_preview=JPEG16x16
      if (
        !unuseImages &&
        (threadPost.metadata.files?.length > 0 || threadPost.metadata.images || threadPost.metadata.embeds)
      ) {
        // 画像つきのPost TODO: すべての過去画像を入れるのか?
        role = 'user' as never // 画像つきのPostはuserにするしかないのでbotでも強制上書き
        // textとimage_urlの配列を準備
        const content: Array<OpenAI.Chat.ChatCompletionContentPart> = [{ type: 'text', text: message }]
        // Mattermost内部の画像
        if (threadPost.metadata.files) {
          await Promise.all(
            threadPost.metadata.files.map(async file => {
              //const url = (await mmClient.getFilePublicLink(file.id)).link
              const originalUrl = await this.mattermostClient.getClient().getFileUrl(file.id, NaN) //これではOpenAIから見えない
              // urlの画像を取得してBASE64エンコードされたURLにする
              const url = await this.getBase64Image(
                originalUrl,
                this.mattermostClient.getClient().getToken(),
                file.mime_type || file.extension, // mime_typeがない場合は拡張子を使う
                file.width,
                file.height,
              )
              if (url) {
                if (
                  [
                    'pdf',
                    'x-javascript',
                    'javascript',
                    'x-python',
                    'plain',
                    'html',
                    'css',
                    'md',
                    'csv',
                    'xml',
                    'rtf',
                  ].includes(file.mime_type.replace(/^.+\//, ''))
                ) {
                  // ドキュメントファイル
                  content.push({ type: 'file', file: { filename: file.name, file_data: url } })
                } else {
                  content.push(
                    { type: 'image_url', image_url: { url } }, //detail?: 'auto' | 'low' | 'high' はdefaultのautoで
                  )
                }
              } //画像取得が失敗した場合は無視
            }),
          )
        }
        const excludeImage: string[] = []
        // メッセージにURLを埋め込んだ内部画像や動画のURL
        if (threadPost.metadata.embeds) {
          for (const embed of threadPost.metadata.embeds) {
            if (embed.url && embed.type === 'link') {
              const url = await this.getBase64Image(embed.url, this.mattermostClient.getClient().getToken())
              if (url) {
                content.push({ type: 'image_url', image_url: { url } })
              }
            } else if (
              embed.type === 'opengraph' &&
              embed.url &&
              (embed.url.startsWith('https://youtu.be/') || embed.url.startsWith('https://www.youtube.com/'))
              // 24分だと437,195トークン>32,768トークン 'gemini-2.0-flash-preview-image-generation'
              // <1,048,576 'gemini-2.5-flash-preview-05-20'
            ) {
              const data = embed.data as OpenGraphMetadata | undefined
              if (data?.type === 'opengraph' && data?.images?.[0]?.secure_url) {
                // YouTubeのサムネイルは画像から除くので除外リストに加える
                excludeImage.push(data.images[0].secure_url)
              }
              content.push({ type: 'image_url', image_url: { url: embed.url } }) // OpenAIのimage_urlは、まだ動画のURLを受け付けないけど
            } else {
              botLog.warn(`Unsupported embed type: ${embed.type}. Skipping.`, embed)
            }
          }
        }
        // 外部画像URL
        if (threadPost.metadata.images) {
          await Promise.all(
            Object.keys(threadPost.metadata.images).map(async url => {
              // urlがexcludeImageに含まれている場合はスキップ
              if (!excludeImage.includes(url)) {
                const postImage = threadPost.metadata.images[url]
                // GPT-4Vの解釈できてリーズナブルな画像形式とサイズに変換
                url = await this.getBase64Image(
                  url,
                  this.mattermostClient.getClient().getToken(),
                  postImage.format,
                  postImage.width,
                  postImage.height,
                ) // 元のURLもMattermostのURL
                content.push({ type: 'image_url', image_url: { url } })
              } else {
                botLog.info(`Skipping image URL: ${url} as it is in the exclude list.`)
              }
            }),
          )
        }
        chatmessages.push({
          role,
          name: await this.userIdToName(threadPost.user_id),
          content,
        })
      } else {
        // テキストだけのPost
        chatmessages.push({
          role,
          name: await this.userIdToName(threadPost.user_id),
          content: message,
        })
      }
    }
  }

  /**
   * 画像をBase64形式で取得します。
   *
   * @param url - 画像のURL。
   * @param token - 認証トークン（任意）。
   * @param format - 画像フォーマット（任意）。
   * @param width - 画像の幅（任意）。
   * @param height - 画像の高さ（任意）。
   * @returns Base64形式の画像データ。
   */
  // 画像をBase64形式で取得する //TODO: 関数も、画像の取得と変換を別の関数に分割することが考えられます。
  private async getBase64Image(
    url: string,
    token: string = '',
    format: string = '',
    width: number = 0,
    height: number = 0,
  ): Promise<string> {
    // formatは、mime_typeのときと拡張子のときがあるから注意
    // fetch the image
    const init: RequestInit = {}
    if (token) {
      init.headers = {
        Authorization: `Bearer ${token}`, // Add the Authentication header here
      }
    }
    const response = await fetch(url, init).catch(error => {
      matterMostLog.error(`Fech Exception! url: ${url}`, error)
      return { ok: false } as Response
    })
    if (!response.ok) {
      botLog.error(`Fetch Image URL HTTP error! status: ${response?.status}`)
      return ''
    }
    let buffer = Buffer.from((await response.arrayBuffer()) as ArrayBufferLike)
    // OpenAIのサポートしている画像形式はPNG, JPEG, WEBP, GIF
    // see: https://platform.openai.com/docs/guides/vision/what-type-of-files-can-i-upload
    // Geminiのサポートしている画像・ビデオ形式は
    // image/png image/jpeg   video/mov video/mpeg video/mp4 video/mpg video/avi video/wmv video/mpegps video/flv
    // https://cloud.google.com/vertex-ai/docs/generative-ai/model-reference/gemini?hl=ja
    // Geminiのサポートしているドキュメント形式は
    // https://ai.google.dev/gemini-api/docs/document-processing?hl=ja&lang=node 最大1,000ページ
    if (
      ['pdf', 'x-javascript', 'javascript', 'x-python', 'plain', 'html', 'css', 'md', 'csv', 'xml', 'rtf'].includes(
        format.replace(/^.+\//, ''),
      )
    ) {
      // ドキュメントファイル
      matterMostLog.info(`Find Document file ${format} ${url}`)
      format = this.toMimeType(format, 'text') // PDFはappliccation/pdfで来るから変換無いはず
    } else if (['mov', 'mpeg', 'mp4', 'mpg', 'avi', 'wmv', 'mpegps', 'flv'].includes(format.replace(/^.+\//, ''))) {
      //ビデオ
      format = this.toMimeType(format, 'video')
    } else if (['mp3', 'wav', 'ogg'].includes(format.replace(/^.+\//, ''))) {
      // 音声 TTSでアシスタントに音声が入ることがあるので
      format = this.toMimeType(format, 'audio')
    } else {
      // 画像
      // sharp画像変換ライブラリの対応形式は    PNG, JPEG, WebP, GIF and AVIF
      // https://www.npmjs.com/package/sharp
      if (
        !format ||
        (['png', 'jpeg', 'webp', 'gif'].includes(format.replace(/^.+\//, '')) && (width <= 0 || height <= 0))
      ) {
        // mattermostがサイズを持っていなかったので実物から取る
        const metadata = await sharp(buffer).metadata() //TODO:ビデオだった場合はsharpどうなるの?
        width = metadata.width ?? 0
        height = metadata.height ?? 0
        format = metadata.format ?? '' //jpeg, png, webp, gif, svg
      }
      if (!['png', 'jpeg', 'webp', 'gif'].includes(format.replace(/^.+\//, ''))) {
        matterMostLog.warn(`Unsupported image format: ${format}. Converting to JPEG.`)
        buffer = await sharp(buffer).jpeg().toBuffer()
        ;({ format = '', width = 0, height = 0 } = await sharp(buffer).metadata())
      }
      // 画像の短辺は768px、長辺は2,000px以下に縮小する
      buffer = await this.resizeImage(width, height, buffer)
      format = this.toMimeType(format, 'image')
    }
    // Convert the buffer to a data URL
    const mimeType = format
    const base64 = buffer.toString('base64')
    const dataURL = 'data:' + mimeType + ';base64,' + base64
    return dataURL
  }

  /**
   * 指定された形式をMIMEタイプに変換します。
   *
   * @param format - 変換したいファイル形式を表す文字列。
   * @param mime - MIMEタイプのプレフィックス（例: 'image', 'video'）。
   * @returns 正しく形式化されたMIMEタイプ。
   */
  // 形式をMIMEタイプに変換する
  private toMimeType(format: string, mime: string) {
    // 形式が既に "/" を含んでいない場合、imageやvideoなどのプレフィックスを追加する
    if (format.indexOf('/') < 0) {
      format = `${mime}/${format}`
    }
    return format
  }

  // 画像をリサイズする
  private async resizeImage(width: number, height: number, buffer: Buffer) {
    // 画像の短辺は768px、長辺は2,000px以下に縮小する
    let resize = false
    const shortEdge = 768
    const longEdge = 1024 //仕様上は2000 //$0.00765 vs $0.01445 倍違うので
    if (width > longEdge || height > longEdge) {
      const resizeRatio = longEdge / Math.max(width, height)
      width *= resizeRatio
      height *= resizeRatio
      resize = true
    }
    if (Math.min(width, height) > shortEdge) {
      const resizeRatio = shortEdge / Math.min(width, height)
      width *= resizeRatio
      height *= resizeRatio
      resize = true
    }
    if (resize) {
      buffer = await sharp(buffer)
        .resize({
          width: Math.round(width),
          height: Math.round(height),
        })
        .toBuffer()
    }
    return buffer
  }

  /**
   * Checks if we are responsible to answer to this message.
   * We do only respond to messages which are posted in a thread or addressed to the bot. We also do not respond to
   * message which were posted by the bot.
   * @param msgData The parsed message data
   * @param meId The mattermost client id
   * @param previousPosts Older posts in the same channel
   */
  // メッセージが無視されるべきかどうかを判定する
  private async isMessageIgnored(msgData: MattermostMessageData, previousPosts: Post[]): Promise<boolean> {
    // it is our own message
    if (msgData.post.user_id === this.meId) {
      return true // 自分自身のメッセージの場合
    }

    // チャンネルではなく自分自身へのDMなのか調べる
    const channelId = msgData.post.channel_id
    const channel = await this.mattermostClient.getClient().getChannel(channelId)
    const members = await this.mattermostClient.getClient().getChannelMembers(channelId)
    if (
      channel.type === 'D' &&
      msgData.post.root_id === '' &&
      members.length === 2 &&
      members.find(member => member.user_id === this.meId)
    ) {
      // 自分のDMだったので、スレッドでなければ、メンションされていなくても返信する よって stopも効かない
      return false
    } else {
      // we are not in a thread and not mentioned
      if (msgData.post.root_id === '' && !msgData.mentions.includes(this.meId)) {
        return true // スレッドではなく、メンションされていない場合
      }
    }
    // 過去の対話を調べる
    for (let i = previousPosts.length - 1; i >= 0; i--) {
      // we were asked to stop participating in the conversation
      if (previousPosts[i].props.bot_status === 'stopped') {
        return true // 会話から退出するように要求されていた場合
      }

      if (previousPosts[i].user_id === this.meId || previousPosts[i].message.includes(this.name)) {
        // we are in a thread were we are actively participating, or we were mentioned in the thread => respond
        return false // アクティブに参加している場合またはスレッドでメンションされている場合は返信する
      }
    }
    // we are in a thread but did not participate or got mentioned - we should ignore this message
    return true // スレッドにいるがメンションされていない場合
  }

  /**
   * 画像を使用しないかどうかを判定します。
   *
   * @param meId - 自分のユーザーID。
   * @param previousPosts - 過去の投稿の配列。
   * @returns 画像を使用しない場合はtrue、使用する場合はfalse。
   */
  // 画像を使用しないかどうかを判定する
  private async isUnuseImages(previousPosts: Post[]): Promise<boolean> {
    for (let i = previousPosts.length - 1; i >= 0; i--) {
      const post = previousPosts[i]
      // we were asked to stop participating in the conversation
      if (post.props.bot_images === 'stopped') {
        return true // 会話で画像を使用しないように要求された場合
      }
      if (post.user_id === this.meId || post.message.includes('@' + (await this.userIdToName(this.meId)))) {
        // we are in a thread were we are actively participating, or we were mentioned in the thread => respond
        return false // アクティブに参加している場合またはスレッドでメンションされている場合は返信する
      }
    }
    return false // 特にないのでDefaultは画像を使う
  }

  /**
   * Transforms a data object of a WebSocketMessage to a JS Object.
   * @param msg The WebSocketMessage data.
   */
  // メッセージデータを解析する
  private parseMessageData(msg: JSONMessageData): MattermostMessageData {
    return {
      mentions: JSON.parse(msg.mentions ?? '[]'), // MattermostがちまよっていたらJSON.parseで例外でるかもしれない
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
  // 古い投稿を取得する
  private async getOlderPosts(refPost: Post, options: { lookBackTime?: number; postCount?: number }) {
    const thread = await this.mattermostClient
      .getClient()
      .getPostThread(refPost.id, true, false, true /*関連するユーザを取得*/)

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

  private usernameCache: Record<string, { username: string; expireTime: number }> = {}

  /**
   * Looks up the mattermost username for the given userId. Every username which is looked up will be cached for 5 minutes.
   * @param userId
   */
  // ユーザーIDからユーザー名を取得する
  public async userIdToName(userId: string): Promise<string> {
    let username: string

    // check if userId is in cache and not outdated
    if (this.usernameCache[userId] && Date.now() < this.usernameCache[userId].expireTime) {
      username = this.usernameCache[userId].username
    } else {
      // username not in cache our outdated
      username = (await this.mattermostClient.getClient().getUser(userId)).username

      // ユーザー名に含まれる「.」「@」「!」「?」をアンダースコアに置換し、64文字以内に切り詰める
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(username)) {
        username = username.replace(/[.@!?]/g, '_').slice(0, 64)
      }

      // ユーザー名が英数字、アンダースコア、ハイフンのみで構成されているか確認し、64文字以内に切り詰める
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(username)) {
        username = [...username.matchAll(/[a-zA-Z0-9_-]/g)].join('').slice(0, 64)
      }

      this.usernameCache[userId] = {
        username: username,
        expireTime: Date.now() + 1000 * 60 * 5,
      }
    }

    return username
  }
}
