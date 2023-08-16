import { MessageListener } from '@mattermost/client/lib/websocket'
import { WebSocket } from 'ws'
import fetch from 'node-fetch'
import { botLog as log } from './logging.js'
import pkg from '@mattermost/client'

// eslint-disable-next-line @typescript-eslint/naming-convention
const { Client4, WebSocketClient } = pkg

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

const mattermostToken = process.env['MATTERMOST_TOKEN']!
const matterMostURLString = process.env['MATTERMOST_URL']!

// mattermostTokenかmatterMostURLStringがundefinedだったらエラー
if (!mattermostToken || !matterMostURLString) {
  log.error('MATTERMOST_TOKEN or MATTERMOST_URL is undefined')
  throw new Error('MATTERMOST_TOKEN or MATTERMOST_URL is undefined')
}

log.trace('Configuring Mattermost URL to ' + matterMostURLString)

export const mmClient = new Client4()
mmClient.setUrl(matterMostURLString)
mmClient.setToken(mattermostToken)

export const wsClient = new WebSocketClient()
const wsUrl = new URL(mmClient.getWebSocketUrl())
wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss' : 'ws'

new Promise((_resolve, reject) => {
  wsClient.addCloseListener(() => reject())
  wsClient.addErrorListener((e: Event) => {
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

/**
 * this resolves an issue with lost web messages and the client rebooting endlessly -
 * we need to have a listener attached to the client from the start so that it does
 * not reconnect infinitely, internally
 */
function workaroundWebsocketPackageLostIssue(webSocketClient: pkg.WebSocketClient) {
  // after a hundred messages it should be ok to unregister - the actual
  // listener should have been added by now.
  let messageCount = 100 //TODO: magic number
  const firstMessagesListener: MessageListener = (_e: unknown) => {
    if (messageCount-- < 1) {
      webSocketClient.removeMessageListener(firstMessagesListener)
    }
  }
  webSocketClient.addMessageListener(firstMessagesListener)
}

workaroundWebsocketPackageLostIssue(wsClient)

wsClient.initialize(wsUrl.toString(), mattermostToken)
