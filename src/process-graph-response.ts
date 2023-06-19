import { mmClient } from './mm-client.js'
import FormData from 'form-data'
import Log from 'debug-level'

const log = new Log('bot')

const yFilesGPTServerUrl = process.env['YFILES_SERVER_URL']
const yFilesEndpoint = yFilesGPTServerUrl
  ? new URL('/json-to-svg', yFilesGPTServerUrl)
  : undefined

/**\
 * @param {string} content
 * @param {string} channelId
 * @returns {Promise<{message, fileId}>}
 */
export async function processGraphResponse(content: string, channelId: string) {
  const result: {
    message: string
    fileId?: string
    props?: { [originalMessage: string]: string }
  } = {
    message: content,
    fileId: undefined,
    props: undefined,
  }
  if (!yFilesGPTServerUrl) {
    return result
  }
  const replaceStart = content.match(/<graph>/i)?.index
  let replaceEnd = content.match(/<\/graph>/i)?.index
  if (replaceEnd) {
    replaceEnd += '</graph>'.length
  }
  if (replaceStart && replaceEnd) {
    const graphContent = content
      .substring(replaceStart, replaceEnd)
      .replace(/<\/?graph>/gi, '')
      .trim()

    try {
      const sanitized = JSON.parse(graphContent)
      const fileId = await jsonToFileId(JSON.stringify(sanitized), channelId)
      const pre = content.substring(0, replaceStart)
      const post = content.substring(replaceEnd)

      if (post.trim().length < 1) {
        result.message = pre
      } else {
        result.message = `${pre} [see attached image] ${post}`
      }

      result.props = { originalMessage: content }

      result.fileId = fileId
    } catch (e) {
      log.error(e)
      log.error(`The input was:\n\n${graphContent}`)
    }
  }

  return result
}

async function generateSvg(jsonString: string) {
  // @ts-expect-error TS(2345): Argument of type 'URL | undefined' is not assignab... Remove this comment to see the full error message
  return fetch(yFilesEndpoint, {
    method: 'POST',
    body: jsonString,
    headers: {
      'Content-Type': 'application/json',
    },
  }).then((response: { ok: unknown; text: () => unknown }) => {
    if (!response.ok) {
      throw new Error('Bad response from server')
    }
    return response.text()
  })
}

async function jsonToFileId(jsonString: string, channelId: string) {
  const svgString = await generateSvg(jsonString)
  const form = new FormData()
  form.append('channel_id', channelId)
  form.append('files', Buffer.from(svgString), 'diagram.svg')
  log.trace('Appending Diagram SVG', svgString)
  const response = await mmClient.uploadFile(form)
  log.trace('Uploaded a file with id', response.file_infos[0].id)
  return response.file_infos[0].id
}
