import fs from 'node:fs/promises'
import {MEDIA_BRIDGE_MAX_BYTES} from './protocol.js'

/** A local file as `add-media` carries it. Checks what the path is before reading
 *  it: a FIFO would block the read forever, and an oversize file would be read
 *  whole only to be refused. */
export const readMediaFileBase64 = async (filePath: string): Promise<string> => {
  const stat = await fs.stat(filePath)
  if (!stat.isFile()) throw new Error(`add-media: ${filePath} is not a regular file.`)
  if (stat.size > MEDIA_BRIDGE_MAX_BYTES) {
    throw new Error(`add-media: ${filePath} is ${stat.size} bytes; add-media carries at most ${MEDIA_BRIDGE_MAX_BYTES}.`)
  }
  return (await fs.readFile(filePath)).toString('base64')
}
