import OpenAI from 'openai'
import { Post } from '@mattermost/types/lib/posts'

export type JSONMessageData = {
  mentions?: string
  post: string
  sender_name: string
}

export type MattermostMessageData = {
  mentions: string[]
  post: Post
  sender_name: string
}

export type AiResponse = {
  message: string //ChatCompletionのレスポンスのcontentは未だStringのみ
  usage?: OpenAI.CompletionUsage
  props?: Record<string, string>
  fileId?: string // 添付画像 mattermostファイルID
  intermediate?: boolean
  model?: string
}
