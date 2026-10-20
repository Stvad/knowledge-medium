/**
 * Reading and writing the parts of a recovery bundle folder
 * (docs/workspace-e2ee-conversion.md §6.3 step 3): one file per part, each
 * hashed as it streams, since a part can be larger than memory.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '../../crypto/hex.js'

/** The part of a File System Access directory the bundle uses, so tests can
 *  hand in an in-memory folder. A `FileSystemDirectoryHandle` is one. */
export interface BundleFolder {
  readonly name: string
  getFileHandle(name: string, options?: {create?: boolean}): Promise<BundleFile>
  getDirectoryHandle(name: string, options?: {create?: boolean}): Promise<BundleFolder>
  removeEntry(name: string, options?: {recursive?: boolean}): Promise<void>
}

export interface BundleFile {
  getFile(): Promise<Blob>
  createWritable(): Promise<BundleWritable>
}

export interface BundleWritable {
  write(data: Uint8Array<ArrayBuffer>): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}

export interface PartDigest {
  /** Lowercase hex. */
  readonly sha256: string
  readonly bytes: number
}

export interface JsonlDigest extends PartDigest {
  readonly lines: number
}

/** A digest built up as bytes go past. */
export const createPartHasher = () => {
  const hash = sha256.create()
  let bytes = 0
  return {
    update(chunk: Uint8Array): void {
      hash.update(chunk)
      bytes += chunk.length
    },
    digest(): PartDigest {
      return {sha256: bytesToHex(hash.digest()), bytes}
    },
  }
}

const encoder = new TextEncoder()

/** One `.jsonl` line, exactly as a part holds it. */
export const encodeJsonlLine = (row: unknown): Uint8Array<ArrayBuffer> => encoder.encode(`${JSON.stringify(row)}\n`)

/** Bytes buffered before each write, so a part of millions of short lines
 *  isn't millions of writes. */
const WRITE_CHUNK_BYTES = 1 << 20

/** A step that ends with `signal`'s reason as soon as it aborts. */
const untilStopped = <R>(step: Promise<R>, signal: AbortSignal | undefined): Promise<R> => {
  if (!signal) return step
  if (signal.aborted) {
    step.catch(() => {})
    return Promise.reject(signal.reason)
  }
  let onAbort = () => {}
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, {once: true})
  })
  return Promise.race([step, stopped]).finally(() => signal.removeEventListener('abort', onAbort))
}

/** Writes one part through `write`, replacing the file only if it finishes:
 *  an unfinished part is discarded, never left looking whole. A Stop ends it
 *  even while the destination is slow to take a write. */
const writePart = async <T>(
  folder: BundleFolder,
  name: string,
  write: (writable: BundleWritable) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  signal?.throwIfAborted()
  const writable = await (await folder.getFileHandle(name, {create: true})).createWritable()
  const stoppable: BundleWritable = {
    write: data => untilStopped(writable.write(data), signal),
    close: () => untilStopped(writable.close(), signal),
    abort: () => writable.abort(),
  }
  try {
    const result = await write(stoppable)
    await stoppable.close()
    return result
  } catch (error) {
    // Not awaited after a Stop: a destination that hangs would hang it too.
    const discarded = writable.abort().catch(() => {})
    if (!signal?.aborted) await discarded
    throw error
  }
}

/** Writes a `.jsonl` part: one JSON value per line, `\n`-terminated. */
export const writeJsonlPart = (
  folder: BundleFolder,
  name: string,
  write: (writeRow: (row: unknown) => Promise<void>) => Promise<void>,
  signal?: AbortSignal,
): Promise<JsonlDigest> =>
  writePart(folder, name, async writable => {
    const hasher = createPartHasher()
    const pending: Uint8Array[] = []
    let pendingBytes = 0
    let lines = 0
    const flush = async () => {
      if (pendingBytes === 0) return
      const chunk = new Uint8Array(pendingBytes)
      let offset = 0
      for (const piece of pending) {
        chunk.set(piece, offset)
        offset += piece.length
      }
      pending.length = 0
      pendingBytes = 0
      await writable.write(chunk)
    }
    await write(async row => {
      const line = encodeJsonlLine(row)
      hasher.update(line)
      pending.push(line)
      pendingBytes += line.length
      lines++
      if (pendingBytes >= WRITE_CHUNK_BYTES) await flush()
    })
    await flush()
    return {...hasher.digest(), lines}
  }, signal)

export const writeBytesPart = (
  folder: BundleFolder,
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
  signal?: AbortSignal,
): Promise<PartDigest> =>
  writePart(folder, name, async writable => {
    await writable.write(bytes)
    return {sha256: sha256Hex(bytes), bytes: bytes.length}
  }, signal)

/**
 * Stream a part once: its digest, and, for a `.jsonl` part, each line in
 * order. A line split across chunks is joined before it is handed on; a part
 * whose last line has no `\n` passes it on too, so a truncated part can't
 * hide its last line from the caller's count.
 */
export const scanPart = async (
  blob: Blob,
  onLine?: (line: string) => void,
  signal?: AbortSignal,
): Promise<PartDigest> => {
  const hasher = createPartHasher()
  const decoder = new TextDecoder('utf-8', {fatal: true})
  // The unfinished line, in pieces: joined only once its end arrives, so a
  // very long line costs one join rather than one per chunk.
  const partial: string[] = []
  const reader = blob.stream().getReader()
  try {
    for (;;) {
      // A read from a drive that stopped answering never settles on its own.
      const {done, value} = await untilStopped(reader.read(), signal)
      if (done) break
      hasher.update(value)
      if (!onLine) continue
      const text = decoder.decode(value, {stream: true})
      let start = 0
      for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', start)) {
        partial.push(text.slice(start, end))
        onLine(partial.join(''))
        partial.length = 0
        start = end + 1
      }
      if (start < text.length) partial.push(text.slice(start))
    }
  } finally {
    if (signal?.aborted) void reader.cancel(signal.reason).catch(() => {})
    else reader.releaseLock()
  }
  if (onLine) {
    partial.push(decoder.decode())
    const last = partial.join('')
    if (last !== '') onLine(last)
  }
  return hasher.digest()
}

/** The bundle's own folder, when the user picked the one it was made in. */
export const bundleFolderIn = async (picked: BundleFolder, name: string): Promise<BundleFolder> => {
  try {
    return await picked.getDirectoryHandle(name)
  } catch {
    return picked
  }
}

export const sha256Hex = (bytes: Uint8Array): string => bytesToHex(sha256(bytes))
