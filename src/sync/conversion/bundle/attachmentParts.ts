/**
 * The recovery bundle's attachment parts (docs/workspace-e2ee-conversion.md
 * §6.3 steps 0 and 3), for a workspace whose Storage still holds raw objects:
 *
 *   - `attachments/<hex>`: each media block's plaintext, from this device's byte
 *     store or the raw Storage object, whichever hashes to the block's content
 *     hash. Storage is untrusted, so nothing is taken unverified;
 *   - `other-objects/<hex sha256 of the path>`: every other object in the
 *     workspace's folder, byte for byte, so the cleaner may later delete it.
 *     A path's digest is a name every filesystem takes.
 */

import { encodedSize, fitsObjectLimit, MAX_OBJECT_BYTES } from '../../byteTransform.js'
import { CONTENT_HASH_PREFIX, verifyContentHash } from '../../crypto/contentHash.js'
import { abortableSleep } from '@/utils/abortableSleep.js'
import { isAddressable, type ObjectPath, type UnrecoverableMedia } from '../attachmentCleaner.js'
import type { ConversionAttachmentsIO } from '../conversionAttachments.js'
import { sha256Hex, writeBytesPart, type BundleFolder } from './bundleParts.js'

export const ATTACHMENTS_DIR = 'attachments'
export const OTHER_OBJECTS_DIR = 'other-objects'

/** What the bundle reads attachments through. */
export type AttachmentSource = Pick<
  ConversionAttachmentsIO,
  'listObjects' | 'readObject' | 'readLocal' | 'writeLocal' | 'mediaHashOf'
>

/** An `other-objects/` entry, as the manifest maps it back to its path. */
export interface OtherObjectEntry {
  /** {@link otherObjectNameOf} the path: the entry's file name. */
  readonly name: string
  readonly path: ObjectPath
  readonly sha256: string
  readonly bytes: number
}

/** An object the cleaner would seal whose sealed size passes the attachments
 *  limit: its upload would be refused until the limits are raised. */
export interface OversizedObject {
  /** A media hash, or the path of a raw object no media block names. */
  readonly what: string
  readonly sealedBytes: number
}

/** Each media hash the server's block rows carry, soft-deleted rows
 *  included, with the ids of the rows that carry it. */
export class MediaBlocks {
  private readonly byHash = new Map<string, string[]>()

  constructor(private readonly mediaHashOf: AttachmentSource['mediaHashOf']) {}

  add(row: {readonly id: string; readonly properties_json: string}): void {
    const hash = this.mediaHashOf(row.properties_json)
    if (!hash) return
    const ids = this.byHash.get(hash)
    if (ids) ids.push(row.id)
    else this.byHash.set(hash, [row.id])
  }

  hashes(): ReadonlySet<string> {
    return new Set(this.byHash.keys())
  }

  /** `hashes` with the blocks that carry them, for the user to see. */
  blocksOf(hashes: readonly string[]): UnrecoverableMedia[] {
    return hashes.map(contentHash => ({contentHash, blockIds: this.byHash.get(contentHash) ?? []}))
  }
}

/** A plaintext workspace stores a media hash's bytes under its bare hex digest. */
export const rawNameOf = (contentHash: string): string => contentHash.slice(CONTENT_HASH_PREFIX.length)

const encoder = new TextEncoder()

/** The `other-objects/` entry name for a Storage path. */
export const otherObjectNameOf = (path: ObjectPath): string => sha256Hex(encoder.encode(path))

/** Tries per Storage read: one download among thousands failing for a moment
 *  shouldn't end the step. */
const READ_ATTEMPTS = 3
const READ_RETRY_MS = 1_000

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

interface ReadOptions {
  readonly signal?: AbortSignal
  readonly sleep?: Sleep
}

const readObject = async (
  source: Pick<AttachmentSource, 'readObject'>,
  path: ObjectPath,
  {signal, sleep = abortableSleep}: ReadOptions,
): Promise<Uint8Array<ArrayBuffer> | null> => {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted()
    try {
      return await source.readObject(path)
    } catch (error) {
      if (attempt >= READ_ATTEMPTS) throw error
      await sleep(READ_RETRY_MS * attempt, signal)
    }
  }
}

export interface VerifiedCopy {
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly from: 'local' | 'storage'
}

/** This device's copy, or the raw Storage object, whichever hashes to
 *  `contentHash`; null when neither does. Storage is read only when `listed`
 *  holds the raw name. */
export const verifiedCopy = async (
  source: Pick<AttachmentSource, 'readLocal' | 'readObject'>,
  contentHash: string,
  listed: ReadonlySet<ObjectPath>,
  options: ReadOptions = {},
): Promise<VerifiedCopy | null> => {
  const name = rawNameOf(contentHash)
  const local = await source.readLocal(name)
  if (local && (await verifyContentHash(local, contentHash))) return {bytes: local, from: 'local'}
  if (!listed.has(name)) return null
  const remote = await readListed(source, name, options)
  if (!(await verifyContentHash(remote, contentHash))) return null
  return {bytes: remote, from: 'storage'}
}

/** The listing, and in it every object the bundle archives: not a media hash's
 *  raw name, and one the cleaner can address. An unaddressable one is never
 *  read (the read would fetch another object) and the cleaner keeps and reports
 *  it; archived, it would hold the proof back for good. Accepted: an object at a
 *  media hash's raw name holding other bytes isn't archived either, so the
 *  cleaner keeps and reports it; telling it apart would download every
 *  attachment again. */
const listFolder = async (source: Pick<AttachmentSource, 'listObjects'>, hashes: readonly string[], signal?: AbortSignal) => {
  const listed = new Set(await source.listObjects(signal))
  const rawNames = new Set(hashes.map(rawNameOf))
  return {listed, otherObjects: [...listed].filter(path => !rawNames.has(path) && isAddressable(path))}
}

/** A listed object read as absent: after the flip nothing writes the folder,
 *  so the read, not the listing, is what failed (an RLS-filtered read answers
 *  404). The step is run again rather than taken without it. */
export class ListedObjectUnreadable extends Error {
  constructor(readonly path: ObjectPath) {
    super(`attachments: ${path} is in the workspace's Storage listing but reads as absent; run this again`)
    this.name = 'ListedObjectUnreadable'
  }
}

const readListed = async (source: Pick<AttachmentSource, 'readObject'>, path: ObjectPath, options: ReadOptions) => {
  const bytes = await readObject(source, path, options)
  if (!bytes) throw new ListedObjectUnreadable(path)
  return bytes
}

export interface AttachmentSurvey {
  /** Media hashes with no hash-verified copy anywhere. */
  readonly noVerifiedSource: readonly string[]
  readonly oversized: readonly OversizedObject[]
  /** What `attachments/` and `other-objects/` will hold. */
  readonly bundleBytes: number
  /** Storage-only copies this device had no room to keep. */
  readonly unkeptBytes: number
}

export interface SurveyProgress {
  readonly checked: number
  readonly total: number
}

/** False when the store is full: the survey then counts what it couldn't keep. */
const keptLocally = async (source: Pick<AttachmentSource, 'writeLocal'>, hash: string, bytes: Uint8Array<ArrayBuffer>) => {
  try {
    await source.writeLocal(rawNameOf(hash), bytes)
    return true
  } catch (error) {
    if (error instanceof DOMException && error.name === 'QuotaExceededError') return false
    throw error
  }
}

/**
 * Preflight's survey: every media hash's verified copy, with each one only
 * Storage holds kept on this device, so an object deleted or replaced on the
 * server after the flip can't break the bundle then; and every other object
 * read for its size. A copy is kept only while `keepBudget` lasts; past it the
 * survey goes on measuring, so the user learns the whole shortfall at once.
 */
export const surveyAttachments = async ({
  source,
  mediaHashes,
  keepBudget,
  limit = MAX_OBJECT_BYTES,
  signal,
  sleep,
  onProgress,
}: ReadOptions & {
  readonly source: AttachmentSource
  readonly mediaHashes: ReadonlySet<string>
  /** Bytes this device may keep; null when it can't tell. */
  readonly keepBudget: number | null
  readonly limit?: number
  readonly onProgress?: (progress: SurveyProgress) => void
}): Promise<AttachmentSurvey> => {
  const hashes = [...mediaHashes].sort()
  const {listed, otherObjects} = await listFolder(source, hashes, signal)
  const noVerifiedSource: string[] = []
  const oversized: OversizedObject[] = []
  let bundleBytes = 0
  let budget = keepBudget ?? Infinity
  let unkeptBytes = 0
  const progress = {checked: 0, total: hashes.length + otherObjects.length}
  const tick = () => onProgress?.({...progress, checked: ++progress.checked})
  const measure = (what: string, bytes: number) => {
    bundleBytes += bytes
    if (!fitsObjectLimit(bytes, 'e2ee', limit)) oversized.push({what, sealedBytes: encodedSize(bytes, 'e2ee')})
  }

  for (const hash of hashes) {
    const copy = await verifiedCopy(source, hash, listed, {signal, sleep})
    tick()
    if (!copy) {
      noVerifiedSource.push(hash)
      continue
    }
    measure(hash, copy.bytes.length)
    if (copy.from === 'local') continue
    if (copy.bytes.length <= budget && (await keptLocally(source, hash, copy.bytes))) {
      budget -= copy.bytes.length
    } else {
      budget = 0
      unkeptBytes += copy.bytes.length
    }
  }

  for (const path of otherObjects) {
    const bytes = await readListed(source, path, {signal, sleep})
    tick()
    // A raw orphan is sealed by the cleaner like any raw object, so its size
    // matters too; nothing else in the folder is ever sealed.
    if (sha256Hex(bytes) === path) measure(path, bytes.length)
    else bundleBytes += bytes.length
  }
  return {noVerifiedSource, oversized, bundleBytes, unkeptBytes}
}

export interface AttachmentParts {
  /** Media hashes with no verified copy now: the bundle holds no bytes for them. */
  readonly missing: readonly string[]
  readonly otherObjects: readonly OtherObjectEntry[]
}

/** Writes both attachment parts into the bundle folder, reading each object once. */
export const writeAttachmentParts = async ({
  folder,
  source,
  mediaHashes,
  signal,
  sleep,
  onProgress,
}: ReadOptions & {
  readonly folder: BundleFolder
  readonly source: AttachmentSource
  readonly mediaHashes: ReadonlySet<string>
  readonly onProgress?: (written: number) => void
}): Promise<AttachmentParts> => {
  const hashes = [...mediaHashes].sort()
  const {listed, otherObjects: paths} = await listFolder(source, hashes, signal)
  const attachments = await folder.getDirectoryHandle(ATTACHMENTS_DIR, {create: true})
  const missing: string[] = []
  let written = 0
  for (const hash of hashes) {
    signal?.throwIfAborted()
    const copy = await verifiedCopy(source, hash, listed, {signal, sleep})
    if (!copy) {
      missing.push(hash)
      continue
    }
    await writeBytesPart(attachments, rawNameOf(hash), copy.bytes)
    onProgress?.(++written)
  }

  const others = await folder.getDirectoryHandle(OTHER_OBJECTS_DIR, {create: true})
  const otherObjects: OtherObjectEntry[] = []
  for (const path of paths) {
    const bytes = await readListed(source, path, {signal, sleep})
    const name = otherObjectNameOf(path)
    const digest = await writeBytesPart(others, name, bytes)
    otherObjects.push({name, path, ...digest})
    onProgress?.(++written)
  }
  return {missing, otherObjects}
}
