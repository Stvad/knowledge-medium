import {constants as fsConstants, type Stats} from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {MEDIA_BRIDGE_MAX_BYTES} from './protocol.js'

const assertMediaSize = (what: string, size: number) => {
  if (size > MEDIA_BRIDGE_MAX_BYTES) {
    throw new Error(`add-media: ${what} is ${size} bytes; add-media carries at most ${MEDIA_BRIDGE_MAX_BYTES}.`)
  }
}

/** The file a path names once every link is followed, refused unless it is under
 *  `realRoot`, a path resolved once by the caller: resolving it again per call would
 *  follow a root swapped for a link. */
const resolveUnder = async (realRoot: string, filePath: string): Promise<string> => {
  const realFile = await fs.realpath(filePath)
  if (!realFile.startsWith(`${realRoot}${path.sep}`)) throw new Error(`add-media: ${filePath} is outside ${realRoot}.`)
  return realFile
}

/** Refuses an opened file unless `filePath` still names it from under `realRoot`: a
 *  directory on the path swapped for a link between the check and the open
 *  leaves the handle on a file the path no longer resolves to. A file with a
 *  second name may have it outside the root. */
export const assertOpenedUnder = async (opened: Stats, realRoot: string, filePath: string): Promise<void> => {
  const named = await fs.stat(await resolveUnder(realRoot, filePath))
  if (named.dev !== opened.dev || named.ino !== opened.ino) throw new Error(`add-media: ${filePath} changed while it was read.`)
  if (opened.nlink > 1) throw new Error(`add-media: ${filePath} has another name, which may be outside ${realRoot}.`)
}

/** A local file as `add-media` carries it, optionally only from under `realRoot`. Checks
 *  what the path is before reading it: a FIFO would block the read forever (hence
 *  the non-blocking open), and an oversize file would be read whole only to be refused. */
export const readMediaFileBase64 = async (filePath: string, realRoot?: string): Promise<string> => {
  const target = realRoot === undefined ? filePath : await resolveUnder(realRoot, filePath)
  // Defence in depth: the final link was already followed, so one found now was swapped in after the check.
  const noFollow = realRoot === undefined ? 0 : fsConstants.O_NOFOLLOW
  const handle = await fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | noFollow)
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error(`add-media: ${filePath} is not a regular file.`)
    if (realRoot !== undefined) await assertOpenedUnder(stat, realRoot, filePath)
    assertMediaSize(filePath, stat.size)
    return (await handle.readFile()).toString('base64')
  } finally {
    await handle.close()
  }
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

/** The one type a name must supply: an SVG is text, so the app's byte sniffing
 *  cannot recognise it, and untyped it stores as a generic file. */
export const mimeFromFilename = (filename: string): string | undefined =>
  filename.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : undefined
