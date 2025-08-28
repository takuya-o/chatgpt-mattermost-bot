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
  fileId?: string[] // 添付画像 mattermostファイルID
  intermediate?: boolean
  model?: string
}

export type ProviderConfig = {
  name: string
  mattermostUrl?: string
  mattermostToken?: string
  type: string
  apiKey: string
  apiBase: string
  modelName: string
  visionModelName: string
  imageModelName: string
  apiVersion: string
  instanceName: string
  deploymentName: string
  visionKey: string
  visionInstanceName: string
  visionDeploymentName: string
  imageKey: string
  imageInstanceName: string
  imageDeploymentName: string
  maxTokens?: number
  temperature?: number
  maxPromptTokens?: number
  reasoningEffort: OpenAI.Chat.Completions.ChatCompletionReasoningEffort
  verbosity: OpenAI.Chat.Completions.ChatCompletionVerbosity
  plugins?: string
}

// 設定ファイルの型を定義
export type ConfigFile = {
  bots: ProviderConfig[]
  BOT_CONTEXT_MSG: string
  BOT_INSTRUCTION: string
  OPENAI_MAX_TOKENS: number
  OPENAI_TEMPERATURE: number
  MAX_PROMPT_TOKENS: number
  MATTERMOST_URL: string
  PLUGINS: string
}

export type AIProviders = {
  chatProvider: AIProvider
  imageProvider: AIProvider
  visionProvider: AIProvider
  type: string
  modelName: string
  imageModelName: string
  visionModelName: string
}
