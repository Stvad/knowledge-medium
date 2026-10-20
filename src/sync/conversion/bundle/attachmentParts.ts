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

import { BINARY_ENVELOPE_OVERHEAD_BYTES } from '../../crypto/binaryEnvelope.js'
import { CONTENT_HASH_PREFIX, verifyContentHash } from '../../crypto/contentHash.js'
import { fitsObjectLimit } from '../../byteTransform.js'
import type { AttachmentCleanerIO, ObjectPath, UnrecoverableMedia } from '../attachmentCleaner.js'
import { sha256Hex, writeBytesPart, type BundleFolder } from './bundleParts.js'

export const ATTACHMENTS_DIR = 'attachments'
export const OTHER_OBJECTS_DIR = 'other-objects'

/** What the bundle reads attachments through: the attachments plugin's view of
 *  Storage and of this device's byte store. */
export type AttachmentSource = Pick<
  AttachmentCleanerIO,
  'listObjects' | 'readObject' | 'readLocal' | 'writeLocal' | 'mediaHashOf'
>

/** An `other-objects/` entry, as the manifest maps it back to its path. */
export interface OtherObjectEntry {
  /** `sha256Hex(path)`: the entry's file name. */
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

export interface AttachmentSurvey {
  /** Media hashes with a hash-verified copy, and that copy's size. */
  readonly verified: ReadonlyMap<string, number>
  /** Media hashes with no hash-verified copy anywhere. */
  readonly noVerifiedSource: readonly string[]
  /** Every listed object that isn't a media hash's raw name. */
  readonly otherObjects: readonly ObjectPath[]
  readonly oversized: readonly OversizedObject[]
  /** The media bytes the bundle will hold. */
  readonly mediaBytes: number
  /** The other objects' bytes; counted only before the flip. */
  readonly otherBytes: number
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

/** This device's copy, or the raw Storage object, whichever hashes to
 *  `contentHash`; null when neither does. A verified Storage copy is kept on
 *  this device when `keep`, so a later change to Storage can't take it away. */
export const verifiedCopy = async (
  source: AttachmentSource,
  contentHash: string,
  {keep = false}: {keep?: boolean} = {},
): Promise<Uint8Array<ArrayBuffer> | null> => {
  const name = rawNameOf(contentHash)
  const local = await source.readLocal(name)
  if (local && (await verifyContentHash(local, contentHash))) return local
  const remote = await source.readObject(name)
  if (!remote || !(await verifyContentHash(remote, contentHash))) return null
  if (keep) await source.writeLocal(name, remote)
  return remote
}

const sealedSize = (bytes: number): number => bytes + BINARY_ENVELOPE_OVERHEAD_BYTES

export const surveyAttachments = async ({
  source,
  mediaHashes,
  preflight,
  signal,
}: {
  readonly source: AttachmentSource
  readonly mediaHashes: ReadonlySet<string>
  /** Before the flip: keep verified Storage copies on this device, and read
   *  every other object for its size. */
  readonly preflight: boolean
  readonly signal?: AbortSignal
}): Promise<AttachmentSurvey> => {
  const keep = preflight
  const verified = new Map<string, number>()
  const noVerifiedSource: string[] = []
  const oversized: OversizedObject[] = []
  let mediaBytes = 0
  for (const hash of [...mediaHashes].sort()) {
    signal?.throwIfAborted()
    const bytes = await verifiedCopy(source, hash, {keep})
    if (!bytes) {
      noVerifiedSource.push(hash)
      continue
    }
    verified.set(hash, bytes.length)
    mediaBytes += bytes.length
    if (!fitsObjectLimit(bytes.length, 'e2ee')) oversized.push({what: hash, sealedBytes: sealedSize(bytes.length)})
  }

  // Accepted: an object at a media hash's raw name holding other bytes isn't
  // archived, so the cleaner keeps and reports it; telling it apart would
  // download every attachment again.
  const rawNames = new Set([...mediaHashes].map(rawNameOf))
  const otherObjects = (await source.listObjects(signal)).filter(path => !rawNames.has(path))
  // A raw orphan is sealed by the cleaner like any raw object, so its size
  // matters too; nothing else in the folder is ever sealed.
  let otherBytes = 0
  for (const path of preflight ? otherObjects : []) {
    signal?.throwIfAborted()
    const bytes = await source.readObject(path)
    if (!bytes) continue
    otherBytes += bytes.length
    if (sha256Hex(bytes) === path && !fitsObjectLimit(bytes.length, 'e2ee')) {
      oversized.push({what: path, sealedBytes: sealedSize(bytes.length)})
    }
  }
  return {verified, noVerifiedSource, otherObjects, oversized, mediaBytes, otherBytes}
}

export class MissingAttachment extends Error {
  constructor(readonly contentHash: string) {
    super(`the recovery bundle can't be taken: the bytes of attachment ${contentHash} are no longer anywhere this device can verify`)
    this.name = 'MissingAttachment'
  }
}

/** Writes both attachment parts into the bundle folder. Every media hash not
 *  in `noVerifiedSource` must still have a verified copy. */
export const writeAttachmentParts = async ({
  folder,
  source,
  mediaHashes,
  noVerifiedSource,
  otherObjects,
  signal,
  onProgress,
}: {
  readonly folder: BundleFolder
  readonly source: AttachmentSource
  readonly mediaHashes: ReadonlySet<string>
  readonly noVerifiedSource: ReadonlySet<string>
  readonly otherObjects: readonly ObjectPath[]
  readonly signal?: AbortSignal
  readonly onProgress?: (written: number) => void
}): Promise<readonly OtherObjectEntry[]> => {
  const attachments = await folder.getDirectoryHandle(ATTACHMENTS_DIR, {create: true})
  let written = 0
  for (const hash of [...mediaHashes].sort()) {
    if (noVerifiedSource.has(hash)) continue
    signal?.throwIfAborted()
    const bytes = await verifiedCopy(source, hash)
    if (!bytes) throw new MissingAttachment(hash)
    await writeBytesPart(attachments, rawNameOf(hash), bytes)
    onProgress?.(++written)
  }

  const others = await folder.getDirectoryHandle(OTHER_OBJECTS_DIR, {create: true})
  const entries: OtherObjectEntry[] = []
  for (const path of otherObjects) {
    signal?.throwIfAborted()
    const bytes = await source.readObject(path)
    // Gone since it was listed: nothing left for the cleaner to delete.
    if (!bytes) continue
    const name = sha256Hex(new TextEncoder().encode(path))
    const digest = await writeBytesPart(others, name, bytes)
    entries.push({name, path, ...digest})
    onProgress?.(++written)
  }
  return entries
}
