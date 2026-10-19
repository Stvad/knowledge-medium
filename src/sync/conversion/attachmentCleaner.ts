/**
 * The attachment cleaner (docs/workspace-e2ee-conversion.md §6.3 step 8): one
 * idempotent pass that leaves an e2ee workspace's Storage folder holding only
 * keyed objects, then proves it. The conversion flow runs it in its `cleaning`
 * phase with the recovery bundle; the owner's **Clean up attachments** gesture
 * runs it with none, for a raw object an older client uploaded later.
 *
 * Every object is classified by content ({@link classifyStoredObject}):
 *   - raw     → seal, upload to its keyed name, verify that upload, and only then
 *               delete the raw object, which is often the server's only copy;
 *   - keyed   → keep;
 *   - neither → delete only when the bundle archived it and its archived entry,
 *               re-read just before the delete, holds the same bytes. Otherwise
 *               leave it and report it. It never stops the pass.
 * Nothing is deleted on what an earlier listing showed: a name is kept without a
 * download only when it is the keyed name of a media block's hash.
 *
 * The pass keeps no state across runs, so resuming after a crash is running it
 * again. It assumes the single-client contract: nothing else writes the folder.
 */

import { encodeBytes, fitsObjectLimit, verifyObjectBytes } from '../byteTransform.js'
import { validateCanary } from '../crypto/canary.js'
import { CONTENT_HASH_PREFIX, verifyContentHash } from '../crypto/contentHash.js'
import {
  classifyStoredObject,
  deriveContentKey,
  indexKeyedNames,
  type KeyedNames,
  type WorkspaceObjectKeys,
} from '../crypto/contentKey.js'

/** A path is relative to the workspace's folder: `<hex>` for an object at the
 *  app's flat address, `dir/<hex>` for a nested one. */
export type ObjectPath = string

export type ObjectWrite =
  | {readonly kind: 'written' | 'exists'}
  /** A permanent refusal, such as a 413 for an object over the upload limit. */
  | {readonly kind: 'refused'; readonly status?: number}

/** The workspace's Storage folder and this device's copies, as the cleaner
 *  needs them. Every method throws on a transient failure. */
export interface AttachmentCleanerIO {
  /** Every object in the folder, completely: paged by name, recursing into the
   *  folder entries Storage returns for nested paths. */
  listObjects(): Promise<readonly ObjectPath[]>
  /** The object's bytes, or null when it is absent. */
  readObject(path: ObjectPath): Promise<Uint8Array<ArrayBuffer> | null>
  /** Upload without overwriting: `exists` when the name is occupied. */
  writeObject(path: ObjectPath, bytes: Uint8Array<ArrayBuffer>): Promise<ObjectWrite>
  deleteObject(path: ObjectPath): Promise<void>
  /** Every media block of the workspace, soft-deleted ones included. */
  mediaBlocks(): Promise<readonly {readonly blockId: string; readonly contentHash: string}[]>
  /** This device's local plaintext for `contentHash`, or null. Hash-checked
   *  again before use. */
  localBytes(contentHash: string): Promise<Uint8Array<ArrayBuffer> | null>
}

/**
 * The conversion's recovery bundle, as the cleaner reads it. The flow
 * implements it over the bundle folder and its bundle record; a standalone run
 * has none. Both reads re-open the folder, return null for a missing entry, and
 * throw when the folder can't be read.
 */
export interface ConversionBundle {
  /** The paths the bundle archived under `other-objects/`, from the bundle record. */
  readonly archivedPaths: ReadonlySet<ObjectPath>
  /** The `other-objects/` entry archived for `path`. */
  readArchivedObject(path: ObjectPath): Promise<Uint8Array<ArrayBuffer> | null>
  /** The `attachments/<hex>` entry for `contentHash`. */
  readAttachment(contentHash: string): Promise<Uint8Array<ArrayBuffer> | null>
}

export interface CleanAttachmentsInput {
  readonly workspaceId: string
  readonly io: AttachmentCleanerIO
  /** The workspace key and its `K_id`, read from one key record. The pass
   *  refuses to start unless the key opens `canary`: under a wrong key every
   *  genuine keyed object fails verification, and the pass would replace it with
   *  one no other device can open. */
  readonly keys: WorkspaceObjectKeys
  /** The workspace's `wk_canary`, as the server holds it now. */
  readonly canary: string
  readonly bundle: ConversionBundle | null
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: CleanerProgress) => void
}

export type CleanerProgress =
  | {readonly phase: 'listing'; readonly pass: number}
  | {readonly phase: 'cleaning'; readonly pass: number; readonly done: number; readonly total: number}
  | {readonly phase: 'proving'; readonly done: number; readonly total: number}

/** Why a neither object was left in place. */
export type LeftReason =
  /** No bundle archived it: a standalone run, or an object the bundle never saw. */
  | 'not-archived'
  /** The bundle folder could not be read. */
  | 'bundle-unreadable'
  /** The archived entry is missing or holds other bytes. */
  | 'archive-mismatch'

export interface UnrecoverableMedia {
  readonly contentHash: string
  readonly blockIds: readonly string[]
}

export type CleanerProof =
  | {
      readonly kind: 'passed'
      /** Media whose bytes exist nowhere: no keyed object, no local copy, no
       *  bundle entry. The flow shows them before `finish_conversion`. */
      readonly unrecoverable: readonly UnrecoverableMedia[]
    }
  | {
      readonly kind: 'not-passed'
      /** Raw objects still in the folder, and objects this run could not
       *  finish reading or handling, which may be raw. `finish_conversion`
       *  waits for them. */
      readonly rawRemaining: readonly ObjectPath[]
      /** Media hashes whose keyed object is missing or fails verification, and
       *  could not be rebuilt this run. */
      readonly unverified: readonly string[]
      /** The listing kept changing, which breaks the single-client contract. */
      readonly unsettled: boolean
    }

export interface CleanerReport {
  /** Raw objects sealed, uploaded, verified and then deleted, and gone from
   *  the last listing. */
  readonly converted: readonly ObjectPath[]
  /** Raw objects whose sealed upload Storage refused; still in place. */
  readonly refused: readonly {
    readonly path: ObjectPath
    readonly status?: number
    /** Too large to seal within the bucket's original limit: the remedy is to
     *  raise the project's upload limit and run again. */
    readonly oversized: boolean
  }[]
  /** Neither objects deleted because the bundle archived them byte for byte,
   *  and gone from the last listing. */
  readonly deleted: readonly ObjectPath[]
  readonly left: readonly {readonly path: ObjectPath; readonly reason: LeftReason}[]
  /** Media keyed objects that were missing or failed verification, and were
   *  uploaded again from a verified source. */
  readonly rebuilt: readonly string[]
  /** Work a transient failure interrupted, or a delete the last listing shows
   *  did not take; running again finishes it. */
  readonly errors: readonly {readonly path: ObjectPath; readonly message: string}[]
  readonly proof: CleanerProof
}

/** A pass that keeps finding something to delete after this many listings is
 *  racing another writer. */
const MAX_PASSES = 8

/** What this run decided about one listed path. A run never revisits a path it
 *  settled, so an object that stays (left, refused) costs one download a run. */
type Settled =
  | {readonly kind: 'kept'}
  | {readonly kind: 'placed'}
  | {readonly kind: 'converted' | 'refused'; readonly contentHash: string}
  | {readonly kind: 'deleted'}
  | {readonly kind: 'left'}
  /** `contentHash` when the object was known to be raw. */
  | {readonly kind: 'error'; readonly contentHash?: string}

/** Settled kinds whose path, still listed at the end, is a raw object or may be. */
const MAYBE_RAW = new Set<Settled['kind']>(['converted', 'refused', 'error'])

type Placement = {readonly kind: 'verified'} | {readonly kind: 'refused'; readonly status?: number} | {readonly kind: 'unverified'}

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export class CleanerKeyRefusal extends Error {
  constructor() {
    super('attachment cleaner: the key does not open the workspace canary')
    this.name = 'CleanerKeyRefusal'
  }
}

/** The candidate hash a path's last segment would be, were it a raw name. */
const hashNamedBy = (path: ObjectPath): string => CONTENT_HASH_PREFIX + path.slice(path.lastIndexOf('/') + 1)

export const cleanAttachments = async (input: CleanAttachmentsInput): Promise<CleanerReport> => {
  const {workspaceId, io, keys, bundle, signal, onProgress} = input
  if (!(await validateCanary(keys.cek, input.canary, workspaceId))) throw new CleanerKeyRefusal()
  const getCek = async () => keys.cek
  const keyedNameOf = (contentHash: string) =>
    deriveContentKey({contentHash, mode: 'e2ee', contentKeyHmac: keys.contentKeyHmac})
  const verifyKeyed = async (bytes: Uint8Array<ArrayBuffer>, contentHash: string) =>
    (await verifyObjectBytes(bytes, 'e2ee', getCek, {contentHash, workspaceId})).ok

  const settled = new Map<ObjectPath, Settled>()
  const converted: ObjectPath[] = []
  const refused: CleanerReport['refused'][number][] = []
  const deleted: ObjectPath[] = []
  const left: CleanerReport['left'][number][] = []
  const rebuilt: string[] = []
  const errors: CleanerReport['errors'][number][] = []

  /**
   * Put `plaintext` (verified to hash to `contentHash`) at its keyed name and
   * prove it is there. An occupant that fails verification is a poisoned or
   * wrong-key copy of bytes this pass holds verified, so it is deleted and the
   * upload repeated once.
   */
  const placeKeyed = async (contentHash: string, plaintext: Uint8Array<ArrayBuffer>): Promise<Placement> => {
    const name = await keyedNameOf(contentHash)
    const sealed = await encodeBytes(plaintext, 'e2ee', getCek, {contentHash, workspaceId})
    for (let attempt = 0; ; attempt++) {
      const write = await io.writeObject(name, sealed)
      if (write.kind === 'refused') return {kind: 'refused', status: write.status}
      const stored = await io.readObject(name)
      if (stored && (await verifyKeyed(stored, contentHash))) {
        settled.set(name, {kind: 'placed'})
        return {kind: 'verified'}
      }
      if (attempt > 0) return {kind: 'unverified'}
      if (stored) await io.deleteObject(name)
    }
  }

  const convertRaw = async (path: ObjectPath, plaintext: Uint8Array<ArrayBuffer>, contentHash: string) => {
    const placement = await placeKeyed(contentHash, plaintext)
    if (placement.kind === 'refused') {
      refused.push({path, status: placement.status, oversized: !fitsObjectLimit(plaintext.length, 'e2ee')})
      return settled.set(path, {kind: 'refused', contentHash})
    }
    if (placement.kind === 'unverified') {
      errors.push({path, message: 'its keyed copy did not verify after upload'})
      return settled.set(path, {kind: 'error', contentHash})
    }
    settled.set(path, {kind: 'error', contentHash}) // until the delete returns
    await io.deleteObject(path)
    converted.push(path)
    settled.set(path, {kind: 'converted', contentHash})
  }

  const handleNeither = async (path: ObjectPath, bytes: Uint8Array<ArrayBuffer>) => {
    const leave = (reason: LeftReason) => {
      left.push({path, reason})
      settled.set(path, {kind: 'left'})
    }
    if (!bundle?.archivedPaths.has(path)) return leave('not-archived')
    let archived: Uint8Array<ArrayBuffer> | null
    try {
      archived = await bundle.readArchivedObject(path)
    } catch {
      return leave('bundle-unreadable')
    }
    if (!archived || !bytesEqual(archived, bytes)) return leave('archive-mismatch')
    await io.deleteObject(path)
    deleted.push(path)
    settled.set(path, {kind: 'deleted'})
  }

  const handle = async (path: ObjectPath, keyed: KeyedNames): Promise<void> => {
    const bytes = await io.readObject(path)
    if (!bytes) {
      // Gone since the listing, or unreadable; either way not known to be clean.
      errors.push({path, message: 'listed, but could not be read'})
      settled.set(path, {kind: 'error'})
      return
    }
    const cls = await classifyStoredObject({workspaceId, name: path, bytes, keyed})
    if (cls.kind === 'keyed') settled.set(path, {kind: 'kept'})
    else if (cls.kind === 'raw') await convertRaw(path, bytes, cls.contentHash)
    else await handleNeither(path, bytes)
  }

  // ── Repeat until a complete listing needs no action ──────────────────────
  let listing: readonly ObjectPath[] = []
  let media: Awaited<ReturnType<AttachmentCleanerIO['mediaBlocks']>> = []
  let mediaNames = new Set<string>()
  let unsettled = true
  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    signal?.throwIfAborted()
    onProgress?.({phase: 'listing', pass})
    listing = await io.listObjects()
    media = await io.mediaBlocks()
    const mediaHashes = new Set(media.map(m => m.contentHash))
    mediaNames = new Set((await indexKeyedNames(mediaHashes, keys)).hashByName.keys())
    const candidates = new Set([
      ...mediaHashes,
      ...listing.map(hashNamedBy),
      ...[...(bundle?.archivedPaths ?? [])].map(hashNamedBy),
    ])
    const keyed = await indexKeyedNames(candidates, keys)

    const todo = listing.filter(path => !mediaNames.has(path) && !settled.has(path))
    const before = converted.length + deleted.length
    for (const [i, path] of todo.entries()) {
      signal?.throwIfAborted()
      onProgress?.({phase: 'cleaning', pass, done: i, total: todo.length})
      // Re-checked per object: a raw object this pass converted may sit later in
      // the listing as the keyed copy it just placed.
      if (settled.has(path)) continue
      try {
        await handle(path, keyed)
      } catch (err) {
        errors.push({path, message: messageOf(err)})
        if (settled.get(path)?.kind !== 'error') settled.set(path, {kind: 'error'})
      }
    }
    if (converted.length + deleted.length === before) {
      unsettled = false
      break
    }
  }

  // ── The proof, over the last listing, which needed no action ────────────
  const listed = new Set(listing)
  const rawRemaining = unsettled
    ? []
    : listing.filter(path => MAYBE_RAW.has(settled.get(path)?.kind ?? 'kept'))
  /** Hashes whose raw object is still listed: their bytes exist, so they are
   *  never unrecoverable, and a later run converts them. */
  const rawHashes = new Set(
    rawRemaining.flatMap(path => {
      const s = settled.get(path)
      return s && 'contentHash' in s && s.contentHash ? [s.contentHash] : []
    }),
  )
  const blocksByHash = new Map<string, string[]>()
  for (const {blockId, contentHash} of media) {
    blocksByHash.set(contentHash, [...(blocksByHash.get(contentHash) ?? []), blockId])
  }
  const unrecoverable: UnrecoverableMedia[] = []
  const unverified: string[] = []

  /** A verified plaintext for `contentHash` from outside Storage, or null. */
  const outsideCopy = async (contentHash: string): Promise<Uint8Array<ArrayBuffer> | null> => {
    const sources = [() => io.localBytes(contentHash), () => bundle?.readAttachment(contentHash) ?? null]
    for (const source of sources) {
      try {
        const bytes = await source()
        if (bytes && (await verifyContentHash(bytes, contentHash))) return bytes
      } catch {
        // an unreadable source is one fewer source
      }
    }
    return null
  }

  const hashes = [...blocksByHash.keys()]
  for (const [i, contentHash] of hashes.entries()) {
    signal?.throwIfAborted()
    onProgress?.({phase: 'proving', done: i, total: hashes.length})
    try {
      const name = await keyedNameOf(contentHash).catch(() => null)
      if (name === null) {
        // A malformed hash names no object, so no bytes can be found for it.
        unrecoverable.push({contentHash, blockIds: blocksByHash.get(contentHash) ?? []})
        continue
      }
      if (settled.get(name)?.kind === 'placed') continue // verified after this run uploaded it
      if (listed.has(name)) {
        const stored = await io.readObject(name)
        if (stored && (await verifyKeyed(stored, contentHash))) continue
      }
      if (rawHashes.has(contentHash)) {
        unverified.push(contentHash)
        continue
      }
      const copy = await outsideCopy(contentHash)
      if (!copy) {
        unrecoverable.push({contentHash, blockIds: blocksByHash.get(contentHash) ?? []})
        continue
      }
      const placement = await placeKeyed(contentHash, copy)
      if (placement.kind === 'verified') rebuilt.push(contentHash)
      else unverified.push(contentHash)
    } catch (err) {
      errors.push({path: contentHash, message: messageOf(err)})
      unverified.push(contentHash)
    }
  }

  const proof: CleanerProof =
    !unsettled && rawRemaining.length === 0 && unverified.length === 0
      ? {kind: 'passed', unrecoverable}
      : {kind: 'not-passed', rawRemaining, unverified, unsettled}
  for (const path of [...converted, ...deleted]) {
    if (listed.has(path)) errors.push({path, message: 'deleted, but still listed'})
  }
  return {
    converted: converted.filter(path => !listed.has(path)),
    refused,
    deleted: deleted.filter(path => !listed.has(path)),
    left,
    rebuilt,
    errors,
    proof,
  }
}
