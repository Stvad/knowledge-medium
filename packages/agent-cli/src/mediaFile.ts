import {constants as fsConstants} from 'node:fs'
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

/** macOS's open(2) flag refusing a link anywhere on the path, not only at its end;
 *  Node passes it through but does not export it. */
const O_NOFOLLOW_ANY = 0x20000000

const READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NONBLOCK

/** Opens `realPath` only if no component of it is a link at the moment of the open. A
 *  check-then-open on a pathname can be raced by swapping a directory on it for a link;
 *  this check happens inside the open. macOS only. */
export const openWithoutLinks = (realPath: string) => {
  if (process.platform !== 'darwin') throw new Error('add-media: a root needs macOS (O_NOFOLLOW_ANY).')
  return fs.open(realPath, READ_FLAGS | O_NOFOLLOW_ANY)
}

/** A local file as `add-media` carries it, optionally only from under `realRoot`. Checks
 *  what the path is before reading it: a FIFO would block the read forever (hence
 *  the non-blocking open), and an oversize file would be read whole only to be refused. */
export const readMediaFileBase64 = async (filePath: string, realRoot?: string): Promise<string> => {
  const handle = realRoot === undefined
    ? await fs.open(filePath, READ_FLAGS)
    : await openWithoutLinks(await resolveUnder(realRoot, filePath))
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error(`add-media: ${filePath} is not a regular file.`)
    // A second name may be outside the root.
    if (realRoot !== undefined && stat.nlink > 1) throw new Error(`add-media: ${filePath} has another name, which may be outside ${realRoot}.`)
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

/** Help for the `mime` option of every `add-media` sender; {@link addMediaMime} is the default it names. */
export const ADD_MEDIA_MIME_HELP = 'MIME type, for bytes that are no recognised image or PDF (those are typed by their bytes). '
  + 'Default: image/svg+xml for a .svg filename, else application/octet-stream, which shows as a download'

/** The `mime` every `add-media` sender puts on the wire: the caller's own, else the
 *  one type a name must supply. An SVG is text, so the app's byte sniffing cannot
 *  recognise it, and untyped it stores as a generic file. */
export const addMediaMime = (filename: string, mime: string | undefined): string | undefined =>
  mime ?? (filename.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : undefined)
