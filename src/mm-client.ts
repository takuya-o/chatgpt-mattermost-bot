import pkg from '@mattermost/client'
import { WebSocket } from 'ws'
import { Log } from 'debug-level'

const { Client4, WebSocketClient } = pkg
const log = new Log('bot')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const global: any
if (!global.WebSocket) {
  global.WebSocket = WebSocket
}

const mattermostToken = process.env['MATTERMOST_TOKEN']
const matterMostURLString = process.env['MATTERMOST_URL']

// mattermostTokeかmatterMostURLStringがundefinedだったらエラー
if (!mattermostToken || !matterMostURLString) {
  log.error('MATTERMOST_TOKEN or MATTERMOST_URL is undefined')
  throw new Error('MATTERMOST_TOKEN or MATTERMOST_URL is undefined')
}

const client = new Client4()
client.setUrl(matterMostURLString)
client.setToken(mattermostToken)

export const wsClient = new WebSocketClient()
const wsUrl = new URL(client.getWebSocketUrl())
wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss' : 'ws'

new Promise((_resolve, reject) => {
  wsClient.addCloseListener((_connectFailCount: number) => reject())
  wsClient.addErrorListener((event: Event) => {
    reject(event)
  })
})
  .then(() => process.exit(0))
  .catch(reason => {
    log.error(reason)
    process.exit(-1)
  })

wsClient.initialize(wsUrl.toString(), mattermostToken)

export const mmClient = client
