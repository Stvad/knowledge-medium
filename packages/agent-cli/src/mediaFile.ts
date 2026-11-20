import fs from 'node:fs/promises'
import {MEDIA_BRIDGE_MAX_BYTES} from './protocol.js'

const assertMediaSize = (what: string, size: number) => {
  if (size > MEDIA_BRIDGE_MAX_BYTES) {
    throw new Error(`add-media: ${what} is ${size} bytes; add-media carries at most ${MEDIA_BRIDGE_MAX_BYTES}.`)
  }
}

/** A local file as `add-media` carries it. Checks what the path is before reading
 *  it: a FIFO would block the read forever, and an oversize file would be read
 *  whole only to be refused. */
export const readMediaFileBase64 = async (filePath: string): Promise<string> => {
  const stat = await fs.stat(filePath)
  if (!stat.isFile()) throw new Error(`add-media: ${filePath} is not a regular file.`)
  assertMediaSize(filePath, stat.size)
  return (await fs.readFile(filePath)).toString('base64')
}

/** Content a model wrote, as `add-media` carries it. Base64 goes through unchanged:
 *  Node's decoder silently repairs malformed input (a pasted `data:` prefix becomes
 *  bytes), and the bridge's strict one must be the one that sees it. */
export const mediaContentBase64 = (content: string, encoding: 'utf8' | 'base64'): string => {
  if (encoding === 'base64') {
    assertMediaSize('content', Math.floor(content.length * 3 / 4))
    return content
  }
  const bytes = Buffer.from(content, 'utf8')
  assertMediaSize('content', bytes.length)
  return bytes.toString('base64')
}

/** Help for the `mime` option of every `add-media` sender; {@link addMediaMime} is the default it names. */
export const ADD_MEDIA_MIME_HELP = 'MIME type, for bytes that are no recognised image or PDF (those are typed by their bytes). '
  + 'Default: image/svg+xml for a .svg filename, else application/octet-stream, which shows as a download'

/** The `mime` every `add-media` sender puts on the wire: the caller's own, else the
 *  one type a name must supply. An SVG is text, so the app's byte sniffing cannot
 *  recognise it, and untyped it stores as a generic file. */
export const addMediaMime = (filename: string, mime: string | undefined): string | undefined =>
  mime ?? (filename.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : undefined)
