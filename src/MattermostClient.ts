import Mattermost from '@mattermost/client'
import { MessageListener } from '@mattermost/client/lib/websocket'
import { WebSocket } from 'ws'
import fetch from 'node-fetch'
import { botLog as log } from './logging.js'

declare const global: {
  WebSocket: typeof WebSocket
  fetch: typeof fetch
}
if (!global.WebSocket) {
  global.WebSocket = WebSocket
}
// Workaround: Use "node-fetch" instead of "undici" that is being used in Node 18 for "fetch()".
// The undici not work fine at uploadFile() multipart/form-data on Mattermost JavaScript Driver.
global.fetch = fetch

//const log = new Log('bot')

export class MattermostClient {
  private client: Mattermost.Client4
  private wsClient: Mattermost.WebSocketClient

  constructor(matterMostURLString: string, mattermostToken: string) {
    // mattermostTokenかmatterMostURLStringがundefinedだったらエラー
    if (!mattermostToken || !matterMostURLString) {
      log.error('MATTERMOST_TOKEN or MATTERMOST_URL is undefined')
      throw new Error('MATTERMOST_TOKEN or MATTERMOST_URL is undefined')
    }
    log.trace('Configuring Mattermost URL to ' + matterMostURLString)
    this.client = new Mattermost.Client4()
    this.client.setUrl(matterMostURLString)
    this.client.setToken(mattermostToken)

    this.wsClient = new Mattermost.WebSocketClient()
    const wsUrl = new URL(this.client.getWebSocketUrl())
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss' : 'ws'

    new Promise((_resolve, reject) => {
      this.wsClient.addCloseListener(() => reject())
      this.wsClient.addErrorListener((e: Event) => {
        reject(e)
      })
    })
      .then(() => {
        process.exit(0)
      })
      .catch(reason => {
        log.error(reason)
        process.exit(-1)
      })

    this.workaroundWebsocketPackageLostIssue(this.wsClient)
    this.wsClient.initialize(wsUrl.toString(), mattermostToken)
  }

  private workaroundWebsocketPackageLostIssue(webSocketClient: Mattermost.WebSocketClient) {
    let messageCount = 100 //TODO: magic number
    const firstMessagesListener: MessageListener = (_e: unknown) => {
      if (messageCount-- < 1) {
        webSocketClient.removeMessageListener(firstMessagesListener)
      }
    }
    webSocketClient.addMessageListener(firstMessagesListener)
  }

  getClient() {
    return this.client
  }

  getWsClient() {
    return this.wsClient
  }
}