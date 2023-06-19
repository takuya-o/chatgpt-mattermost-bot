import tiktoken from 'tiktoken-node'

const enc = tiktoken.encodingForModel('gpt-3.5-turbo')

export function tokenCount(content: string | undefined) {
  if (!content) return 0 //知らんもの来たら 0
  const tokens = enc.encode(content)
  return tokens.length
}
