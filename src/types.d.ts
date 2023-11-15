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
  message: string
  usage?: OpenAI.CompletionUsage
  props?: Record<string, string>
  fileId?: string
  intermediate?: boolean
  model?: string
}
