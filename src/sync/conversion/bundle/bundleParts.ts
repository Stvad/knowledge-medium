/**
 * Reading and writing the parts of a recovery bundle folder
 * (docs/workspace-e2ee-conversion.md §6.3 step 3): one file per part, each
 * hashed as it streams, since a part can be larger than memory.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

/** The part of a File System Access directory the bundle uses, so tests can
 *  hand in an in-memory folder. A `FileSystemDirectoryHandle` is one. */
export interface BundleFolder {
  readonly name: string
  getFileHandle(name: string, options?: {create?: boolean}): Promise<BundleFile>
  getDirectoryHandle(name: string, options?: {create?: boolean}): Promise<BundleFolder>
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

/** Bytes buffered before each write, so a part of millions of short lines
 *  isn't millions of writes. */
const WRITE_CHUNK_BYTES = 1 << 20

const encoder = new TextEncoder()

/** A `.jsonl` part: one JSON value per line, `\n`-terminated. */
export class JsonlPartWriter {
  private readonly hash = sha256.create()
  private readonly pending: Uint8Array[] = []
  private pendingBytes = 0
  private bytes = 0
  private lines = 0

  private constructor(private readonly writable: BundleWritable) {}

  static async create(folder: BundleFolder, name: string): Promise<JsonlPartWriter> {
    const file = await folder.getFileHandle(name, {create: true})
    return new JsonlPartWriter(await file.createWritable())
  }

  async writeRow(row: unknown): Promise<void> {
    const line = encoder.encode(`${JSON.stringify(row)}\n`)
    this.hash.update(line)
    this.pending.push(line)
    this.pendingBytes += line.length
    this.bytes += line.length
    this.lines++
    if (this.pendingBytes >= WRITE_CHUNK_BYTES) await this.flush()
  }

  async finish(): Promise<JsonlDigest> {
    await this.flush()
    await this.writable.close()
    return {sha256: bytesToHex(this.hash.digest()), bytes: this.bytes, lines: this.lines}
  }

  /** Discards what was written: an unfinished part never replaces a finished one. */
  async abort(): Promise<void> {
    await this.writable.abort()
  }

  private async flush(): Promise<void> {
    if (this.pendingBytes === 0) return
    const chunk = new Uint8Array(this.pendingBytes)
    let offset = 0
    for (const piece of this.pending) {
      chunk.set(piece, offset)
      offset += piece.length
    }
    this.pending.length = 0
    this.pendingBytes = 0
    await this.writable.write(chunk)
  }
}

/** Writes `rows` as a `.jsonl` part, discarding it if writing fails. */
export const writeJsonlPart = async (
  folder: BundleFolder,
  name: string,
  write: (writeRow: (row: unknown) => Promise<void>) => Promise<void>,
): Promise<JsonlDigest> => {
  const writer = await JsonlPartWriter.create(folder, name)
  try {
    await write(row => writer.writeRow(row))
  } catch (error) {
    await writer.abort().catch(() => {})
    throw error
  }
  return writer.finish()
}

export const writeBytesPart = async (folder: BundleFolder, name: string, bytes: Uint8Array<ArrayBuffer>): Promise<PartDigest> => {
  const writable = await (await folder.getFileHandle(name, {create: true})).createWritable()
  try {
    await writable.write(bytes)
  } catch (error) {
    await writable.abort().catch(() => {})
    throw error
  }
  await writable.close()
  return {sha256: bytesToHex(sha256(bytes)), bytes: bytes.length}
}

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
  const hash = sha256.create()
  const decoder = new TextDecoder('utf-8', {fatal: true})
  let bytes = 0
  let partial = ''
  const reader = blob.stream().getReader()
  try {
    for (;;) {
      signal?.throwIfAborted()
      const {done, value} = await reader.read()
      if (done) break
      hash.update(value)
      bytes += value.length
      if (!onLine) continue
      const text = partial + decoder.decode(value, {stream: true})
      const lines = text.split('\n')
      partial = lines.pop()!
      for (const line of lines) onLine(line)
    }
  } finally {
    reader.releaseLock()
  }
  if (onLine) {
    partial += decoder.decode()
    if (partial !== '') onLine(partial)
  }
  return {sha256: bytesToHex(hash.digest()), bytes}
}

export const sha256Hex = (bytes: Uint8Array): string => bytesToHex(sha256(bytes))
