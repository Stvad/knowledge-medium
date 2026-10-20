/**
 * The attachment cleaner (docs/workspace-e2ee-conversion.md §6.3 step 8): one
 * idempotent pass that leaves an e2ee workspace's Storage folder holding only
 * keyed objects, then proves it. The conversion flow runs it in its `cleaning`
 * phase with the recovery bundle; the owner's **Clean up attachments** gesture
 * runs it with none, for a raw object an older client uploaded later.
 *
 * Every object is classified by content ({@link classifyStoredObject}):
 *   - raw     → seal, upload to its keyed name, verify that upload, and only then
 *               delete the raw object, which is often the server's only copy. A
 *               refused upload leaves it in place;
 *   - keyed   → keep;
 *   - neither → delete only when the bundle archived it and its archived entry,
 *               re-read just before the delete, holds the same bytes. Otherwise
 *               leave it and report it. It never stops the pass.
 * Nothing is deleted on what an earlier listing showed: a name is kept without a
 * download only when it is the keyed name of a media block's hash.
 *
 * The pass keeps no state across runs, so resuming after a crash is running it
 * again. It assumes the single-client contract: nothing else writes the folder,
 * and the proof fails if the folder changes in a way the run did not cause.
 */

import { encodeBytes, encodedSize, verifyObjectBytes } from '../byteTransform.js'
import { validateCanary } from '../crypto/canary.js'
import { CONTENT_HASH_PREFIX, verifyContentHash } from '../crypto/contentHash.js'
import { classifyStoredObject, deriveContentKey, indexKeyedNames, type WorkspaceObjectKeys } from '../crypto/contentKey.js'
import { ConversionRefusal } from './sealing.js'

/** A path is relative to the workspace's folder: `<hex>` for an object at the
 *  app's flat address, `dir/<hex>` for a nested one. */
export type ObjectPath = string

export interface MediaRef {
  readonly blockId: string
  readonly contentHash: string
}

export type ObjectWrite =
  | {readonly kind: 'written' | 'exists'}
  /** A permanent refusal, such as a 413 for an object over an upload limit. */
  | {readonly kind: 'refused'; readonly status?: number}

/** The workspace's Storage folder and this device's copies, as the cleaner
 *  needs them. Every method throws on a transient failure. */
export interface AttachmentCleanerIO {
  /** Every object in the folder, completely, as the signed-in user sees it:
   *  paged by name, recursing into folders. Throws rather than return a listing
   *  it can't vouch for: RLS filters a listing instead of refusing it, so one run
   *  under a lapsed session reads as an empty folder. */
  listObjects(signal?: AbortSignal): Promise<readonly ObjectPath[]>
  /** The object's bytes, or null when it is absent. */
  readObject(path: ObjectPath): Promise<Uint8Array<ArrayBuffer> | null>
  /** Upload without overwriting: `exists` when the name is occupied. */
  writeObject(path: ObjectPath, bytes: Uint8Array<ArrayBuffer>): Promise<ObjectWrite>
  /** Resolves only once Storage confirms the object is deleted. `signal`
   *  aborts the request itself: one only abandoned could still be sent after a
   *  later run has put the object back. */
  deleteObject(path: ObjectPath, signal: AbortSignal | undefined): Promise<void>
  /** Every media block of the workspace, soft-deleted ones included. Throws
   *  while this device's copy of the workspace is incomplete. */
  mediaBlocks(): Promise<readonly MediaRef[]>
  /** This device's local byte-store entry under `name`, or null. */
  readLocal(name: string): Promise<Uint8Array<ArrayBuffer> | null>
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
  /** The content hashes the manifest lists as having no verified source: the
   *  only ones with no `attachments/` entry. */
  readonly noVerifiedSource: ReadonlySet<string>
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

/** The Web Lock every run of the cleaner over one workspace holds, the
 *  conversion flow's and the owner gesture's alike. */
export const attachmentCleanerLockName = (userId: string, workspaceId: string): string =>
  `km-attachment-cleaner:${userId}:${workspaceId}`

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
  /** A name only a write from outside the app makes, which a read and a delete
   *  would address differently; see {@link isAddressable}. */
  | 'unaddressable'
  /** At a media block's keyed name, it neither opens to the block's bytes nor
   *  holds them, and no copy exists to replace it with. */
  | 'unverifiable'

/** How the recovery bundle let this run down, which another copy of the
 *  folder may fix: a read from it failed, or an entry it should hold is
 *  missing or holds other bytes. */
export type BundleFault = 'unreadable' | 'mismatch'

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
       *  finish reading or handling, which may be raw. */
      readonly rawRemaining: readonly ObjectPath[]
      /** Objects the bundle archived that are still in the folder: left
       *  because the bundle couldn't be read or didn't match, or a delete that
       *  did not take. The flow asks for the bundle folder again. */
      readonly archivedRemaining: readonly ObjectPath[]
      /** Media hashes whose keyed object is missing or fails verification, and
       *  could not be rebuilt this run. */
      readonly unverified: readonly string[]
      /** The folder changed in a way this run did not cause: it kept finding
       *  work, or an object it had seen vanished. That breaks the single-client
       *  contract, or the listing was not complete. */
      readonly unsettled: boolean
    }

export interface UnrecoverableMedia {
  readonly contentHash: string
  readonly blockIds: readonly string[]
}

export type CleanerError =
  | {readonly path: ObjectPath; readonly message: string}
  | {readonly contentHash: string; readonly message: string}

export interface CleanerReport {
  /** Raw objects sealed, uploaded, verified and then deleted, and gone from
   *  the final listing. */
  readonly converted: readonly ObjectPath[]
  /** Sealed uploads Storage refused: a raw object, still in place, or a media
   *  block's keyed copy that could not be rebuilt. For a 413 the remedy is to
   *  raise the project-wide upload limit, and the bucket's own limit if it is
   *  lower, to at least `sealedBytes`, then run again. */
  readonly refused: readonly {
    readonly path: ObjectPath
    readonly status?: number
    readonly sealedBytes: number
  }[]
  /** Neither objects deleted because the bundle archived them byte for byte,
   *  and gone from the final listing. */
  readonly deleted: readonly ObjectPath[]
  readonly left: readonly {readonly path: ObjectPath; readonly reason: LeftReason}[]
  /** Media keyed objects that were missing or failed verification, and were
   *  uploaded again from a verified source. */
  readonly rebuilt: readonly string[]
  /** Work a transient failure interrupted, or a change to the folder this run
   *  did not cause; running again finishes or re-checks it. */
  readonly errors: readonly CleanerError[]
  /** The first {@link BundleFault} of this run, whether it left an archived
   *  object or a media hash unverified; null when the bundle held everything
   *  asked of it, or there was no bundle. */
  readonly bundleFault: BundleFault | null
  readonly proof: CleanerProof
}

/** The sealed size the upload limits must reach for every refused-as-too-large
 *  upload (a 413), or null when none was refused for size. */
export const limitToRaise = (refused: CleanerReport['refused']): number | null => {
  const sizes = refused.filter(item => item.status === 413).map(item => item.sealedBytes)
  return sizes.length > 0 ? Math.max(...sizes) : null
}

/** A pass that keeps finding something to delete after this many listings is
 *  racing another writer. */
const MAX_PASSES = 8

/**
 * A path the cleaner may read or delete: every segment non-empty, not `.` or
 * `..`, and needing no URL escaping. storage-js sends a read's path as it is
 * while the delete escapes it, so for any other name (`x?y` reads `x`) the two
 * would address different objects, and a URL collapses dot segments onto some
 * other object entirely. The app only writes hex names.
 */
export const isAddressable = (path: ObjectPath): boolean =>
  path
    .split('/')
    .every(segment => segment !== '' && segment !== '.' && segment !== '..' && encodeURIComponent(segment) === segment)

/** What this run decided about a path it listed. A run never revisits a path
 *  it settled, so an object that stays (left, refused) costs one download a run. */
type Settled =
  /** Expected to stay listed: kept, left, or a keyed copy this run placed and
   *  verified (`placed`). */
  | {readonly kind: 'stays'; readonly placed?: true}
  /** Deleted by this run; `contentHash` when it was raw. */
  | {readonly kind: 'removed'; readonly contentHash?: string}
  /** Raw and not converted (refused, unverified, delete unconfirmed), or not
   *  read at all: it may be raw. `contentHash` when known to be raw. */
  | {readonly kind: 'unfinished'; readonly contentHash?: string}

type Placement =
  | {readonly kind: 'verified'}
  | {readonly kind: 'refused'; readonly status?: number; readonly sealedBytes: number}
  | {readonly kind: 'unverified'}

/** A copy of an attachment from outside Storage. `unreadable`: a source failed
 *  to read, so absence is not established. */
type OutsideCopy =
  | {readonly kind: 'copy'; readonly bytes: Uint8Array<ArrayBuffer>}
  | {readonly kind: 'none'}
  | {readonly kind: 'unreadable'}

type MediaVerdict = 'kept' | 'rebuilt' | 'unverified' | 'unrecoverable'

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The hash a path's last segment names, were it a raw name: a candidate for
 *  the keyed copy of each raw object this pass converts. */
const hashNamedBy = (path: ObjectPath): string => CONTENT_HASH_PREFIX + path.slice(path.lastIndexOf('/') + 1)

export const cleanAttachments = async (input: CleanAttachmentsInput): Promise<CleanerReport> => {
  const {workspaceId, io, keys, bundle, signal, onProgress} = input
  if (!(await validateCanary(keys.cek, input.canary, workspaceId))) throw new ConversionRefusal('wrong-key')
  const getCek = async () => keys.cek
  const verifyKeyed = async (bytes: Uint8Array<ArrayBuffer>, contentHash: string) =>
    (await verifyObjectBytes(bytes, 'e2ee', getCek, {contentHash, workspaceId})).ok

  const settled = new Map<ObjectPath, Settled>()
  const converted: ObjectPath[] = []
  const refused: CleanerReport['refused'][number][] = []
  const deleted: ObjectPath[] = []
  const left: CleanerReport['left'][number][] = []
  let bundleFault: BundleFault | null = null
  const faultBundle = (fault: BundleFault) => { bundleFault ??= fault }
  const rebuilt: string[] = []
  const errors: CleanerError[] = []
  /** Paths whose current occupant this run proved a genuine keyed object. */
  const provenKeyed = new Set<ObjectPath>()
  /** Every write and delete this run makes, so the proof can tell whether the
   *  folder changed after the listing it judged. */
  let changes = 0
  const writeStored = (path: ObjectPath, bytes: Uint8Array<ArrayBuffer>) => {
    changes++
    return io.writeObject(path, bytes)
  }
  const removeStored = (path: ObjectPath) => {
    changes++
    return io.deleteObject(path, signal)
  }

  /** A listed object's bytes. A read that finds nothing at a path a listing just
   *  showed is not absence: Storage answers a read it denies as absent. */
  const readListed = async (path: ObjectPath): Promise<Uint8Array<ArrayBuffer>> => {
    const bytes = await io.readObject(path)
    if (!bytes) throw new Error('listed, but could not be read')
    return bytes
  }

  /**
   * Put `plaintext` (verified to hash to `contentHash`) at `name`, its keyed
   * name, and prove it is there. An occupant that fails verification is a
   * poisoned or wrong-key copy of bytes this pass holds verified, so it is
   * deleted and the upload repeated once. A refused upload is reported under
   * `reportAs`, the object it was for.
   */
  const placeKeyed = async (
    name: string,
    contentHash: string,
    plaintext: Uint8Array<ArrayBuffer>,
    reportAs: ObjectPath,
  ): Promise<Placement> => {
    const sealed = await encodeBytes(plaintext, 'e2ee', getCek, {contentHash, workspaceId})
    const writeAndCheck = async (): Promise<Placement | {readonly kind: 'occupied-by-other'}> => {
      const write = await writeStored(name, sealed)
      if (write.kind === 'refused') return {kind: 'refused', status: write.status, sealedBytes: sealed.length}
      const stored = await io.readObject(name)
      if (!stored) return {kind: 'unverified'}
      return (await verifyKeyed(stored, contentHash)) ? {kind: 'verified'} : {kind: 'occupied-by-other'}
    }
    let result = await writeAndCheck()
    if (result.kind !== 'verified' && result.kind !== 'refused') {
      // Two cleaners on one folder could each delete the copy the other just
      // verified here. The Web Lock serializes them within a browser; two
      // devices at once are outside the single-client contract.
      if (result.kind === 'occupied-by-other') await removeStored(name)
      result = await writeAndCheck()
    }
    if (result.kind === 'verified') {
      settled.set(name, {kind: 'stays', placed: true})
      provenKeyed.add(name)
      return result
    }
    if (result.kind === 'refused') {
      refused.push({path: reportAs, status: result.status, sealedBytes: result.sealedBytes})
      return result
    }
    return {kind: 'unverified'}
  }

  const convertRaw = async (path: ObjectPath, plaintext: Uint8Array<ArrayBuffer>, contentHash: string, keyedName: string) => {
    settled.set(path, {kind: 'unfinished', contentHash})
    const placement = await placeKeyed(keyedName, contentHash, plaintext, path)
    if (placement.kind === 'refused') return
    if (placement.kind === 'unverified') {
      errors.push({path, message: 'its keyed copy did not verify after upload'})
      return
    }
    await removeStored(path)
    converted.push(path)
    settled.set(path, {kind: 'removed', contentHash})
  }

  const handleNeither = async (path: ObjectPath, bytes: Uint8Array<ArrayBuffer>) => {
    const leave = (reason: LeftReason) => {
      left.push({path, reason})
      settled.set(path, {kind: 'stays'})
    }
    if (!bundle?.archivedPaths.has(path)) return leave('not-archived')
    let archived: Uint8Array<ArrayBuffer> | null
    try {
      archived = await bundle.readArchivedObject(path)
    } catch {
      faultBundle('unreadable')
      return leave('bundle-unreadable')
    }
    if (!archived || !bytesEqual(archived, bytes)) {
      faultBundle('mismatch')
      return leave('archive-mismatch')
    }
    settled.set(path, {kind: 'stays'}) // until the delete is confirmed
    await removeStored(path)
    deleted.push(path)
    settled.set(path, {kind: 'removed'})
  }

  const handle = async (path: ObjectPath, keyedNames: Awaited<ReturnType<typeof indexKeyedNames>>) => {
    if (!isAddressable(path)) {
      // Never read; and never raw or keyed, both of which are hex names.
      left.push({path, reason: 'unaddressable'})
      settled.set(path, {kind: 'stays'})
      return
    }
    settled.set(path, {kind: 'unfinished'})
    const bytes = await readListed(path)
    const cls = await classifyStoredObject({workspaceId, name: path, bytes, keyed: keyedNames})
    if (cls.kind === 'keyed') {
      settled.set(path, {kind: 'stays'})
      provenKeyed.add(path)
    } else if (cls.kind === 'raw') {
      const keyedName = await deriveContentKey({contentHash: cls.contentHash, mode: 'e2ee', contentKeyHmac: keys.contentKeyHmac})
      await convertRaw(path, bytes, cls.contentHash, keyedName)
    } else await handleNeither(path, bytes)
  }

  // ── Repeat until a complete listing needs no action ──────────────────────
  let media: readonly MediaRef[] = []
  /** Each media hash's keyed name; a malformed hash has none. */
  let mediaNameByHash = new Map<string, string>()
  let unsettled = true
  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    signal?.throwIfAborted()
    onProgress?.({phase: 'listing', pass})
    const listing = await io.listObjects(signal)
    media = await io.mediaBlocks()
    const mediaHashes = new Set(media.map(m => m.contentHash))
    const keyedNames = await indexKeyedNames(new Set([...mediaHashes, ...listing.map(hashNamedBy)]), keys)
    mediaNameByHash = new Map(
      [...keyedNames.hashByName].filter(([, hash]) => mediaHashes.has(hash)).map(([name, hash]) => [hash, name]),
    )
    const mediaNames = new Set(mediaNameByHash.values())

    const todo = listing.filter(path => !mediaNames.has(path) && !settled.has(path))
    const before = converted.length + deleted.length
    for (const [i, path] of todo.entries()) {
      signal?.throwIfAborted()
      onProgress?.({phase: 'cleaning', pass, done: i, total: todo.length})
      // Re-checked per object: a raw object this pass converted may sit later in
      // the listing as the keyed copy it just placed.
      if (settled.has(path)) continue
      try {
        await handle(path, keyedNames)
      } catch (err) {
        errors.push({path, message: messageOf(err)})
      }
    }
    if (converted.length + deleted.length === before) {
      unsettled = false
      break
    }
  }

  // ── The proof, over a final listing taken after every delete ─────────────
  const mediaNames = new Set(mediaNameByHash.values())
  /** A listed path that is raw, or may be: never settled (it appeared after the
   *  last pass), not converted, or deleted and still listed. */
  const maybeRaw = (path: ObjectPath): boolean => {
    if (mediaNames.has(path)) return false
    const s = settled.get(path)
    return s === undefined || s.kind === 'unfinished' || (s.kind === 'removed' && s.contentHash !== undefined)
  }
  /** What a listing says about the folder: what is listed, what this run saw
   *  that is gone without its delete, and what may be raw. */
  const assess = (listing: readonly ObjectPath[]) => {
    const listed = new Set(listing)
    const vanished = [...settled].filter(([path, s]) => s.kind !== 'removed' && !listed.has(path)).map(([path]) => path)
    return {listing, listed, vanished, rawRemaining: listing.filter(maybeRaw)}
  }
  signal?.throwIfAborted()
  let view = assess(await io.listObjects(signal))
  const vanishedBeforeProof = view.vanished
  const changesAtFinal = changes
  const listed = view.listed
  /** Hashes whose raw object is still listed: their bytes exist, so they are
   *  never unrecoverable, and a later run converts them. */
  const rawHashes = new Set(
    view.rawRemaining.flatMap(path => {
      const s = settled.get(path)
      return s && s.kind !== 'stays' && s.contentHash ? [s.contentHash] : []
    }),
  )

  /** A verified plaintext for `contentHash` from outside Storage. Absence is
   *  established only by sources that read cleanly; a bundle that should hold
   *  the hash but returns nothing has changed since it was verified. */
  const outsideCopy = async (contentHash: string, keyedName: string): Promise<OutsideCopy> => {
    let unreadable = false
    // Every local name: a damaged copy under one must not hide a good one under the other.
    const rawName = await deriveContentKey({contentHash, mode: 'none', contentKeyHmac: null})
    for (const name of [keyedName, rawName]) {
      try {
        const local = await io.readLocal(name)
        if (local && (await verifyContentHash(local, contentHash))) return {kind: 'copy', bytes: local}
      } catch (err) {
        errors.push({contentHash, message: `local copy unreadable: ${messageOf(err)}`})
        unreadable = true
      }
    }
    if (bundle) {
      try {
        const entry = await bundle.readAttachment(contentHash)
        if (entry && (await verifyContentHash(entry, contentHash))) return {kind: 'copy', bytes: entry}
        if (!bundle.noVerifiedSource.has(contentHash)) {
          faultBundle('mismatch')
          unreadable = true
        }
      } catch (err) {
        errors.push({contentHash, message: `bundle entry unreadable: ${messageOf(err)}`})
        faultBundle('unreadable')
        unreadable = true
      }
    }
    return unreadable ? {kind: 'unreadable'} : {kind: 'none'}
  }

  /**
   * Seal the only copy of a block's plaintext, found unsealed at its keyed
   * name. Replacing it there means deleting it first, so it is first written to
   * its raw name and read back verified, and then converted like any raw object:
   * a durable copy exists at every step.
   */
  const convertOccupant = async (contentHash: string, keyedName: string, plaintext: Uint8Array<ArrayBuffer>): Promise<MediaVerdict> => {
    const rawName = await deriveContentKey({contentHash, mode: 'none', contentKeyHmac: null})
    const write = await writeStored(rawName, plaintext)
    if (write.kind === 'refused') {
      // Its sealed upload would need at least as much: the same remedy covers both.
      const sealedBytes = encodedSize(plaintext.length, 'e2ee')
      refused.push({path: keyedName, status: write.status, sealedBytes})
      return 'unverified'
    }
    const staged = await io.readObject(rawName)
    if (!staged || !(await verifyContentHash(staged, contentHash))) {
      errors.push({path: keyedName, message: 'its plaintext could not be staged at its raw name to convert it'})
      return 'unverified'
    }
    await convertRaw(rawName, staged, contentHash, keyedName)
    return settled.get(rawName)?.kind === 'removed' ? 'rebuilt' : 'unverified'
  }

  const placedThisRun = (name: string): boolean => {
    const s = settled.get(name)
    return s?.kind === 'stays' && s.placed === true
  }

  const proveMedia = async (contentHash: string): Promise<MediaVerdict> => {
    const name = mediaNameByHash.get(contentHash)
    if (name === undefined) return 'unrecoverable' // a malformed hash names no object
    let occupant: Uint8Array<ArrayBuffer> | null = null
    if (listed.has(name)) {
      if (placedThisRun(name)) return 'kept' // verified after this run uploaded it
      occupant = await readListed(name)
      if (await verifyKeyed(occupant, contentHash)) {
        provenKeyed.add(name)
        return 'kept'
      }
    }
    if (rawHashes.has(contentHash)) return 'unverified'
    const copy = await outsideCopy(contentHash, name)
    if (copy.kind === 'unreadable') return 'unverified'
    // A durable copy outside Storage: replacing a failing occupant loses nothing.
    if (copy.kind === 'copy') {
      return (await placeKeyed(name, contentHash, copy.bytes, name)).kind === 'verified' ? 'rebuilt' : 'unverified'
    }
    // The block's own plaintext, unsealed at its keyed name, and its only copy.
    if (occupant && (await verifyContentHash(occupant, contentHash))) return convertOccupant(contentHash, name, occupant)
    // Nothing to replace it with. Like any neither object the bundle did not
    // archive, it is kept and reported rather than deleted without a copy.
    if (occupant) left.push({path: name, reason: 'unverifiable'})
    return 'unrecoverable'
  }

  const blocksByHash = new Map<string, string[]>()
  for (const {blockId, contentHash} of media) {
    blocksByHash.set(contentHash, [...(blocksByHash.get(contentHash) ?? []), blockId])
  }
  const unrecoverable: UnrecoverableMedia[] = []
  const unverified: string[] = []
  for (const [i, [contentHash, blockIds]] of [...blocksByHash].entries()) {
    signal?.throwIfAborted()
    onProgress?.({phase: 'proving', done: i, total: blocksByHash.size})
    let verdict: MediaVerdict
    try {
      verdict = await proveMedia(contentHash)
    } catch (err) {
      errors.push({contentHash, message: messageOf(err)})
      verdict = 'unverified'
    }
    if (verdict === 'rebuilt') rebuilt.push(contentHash)
    else if (verdict === 'unverified') unverified.push(contentHash)
    else if (verdict === 'unrecoverable') unrecoverable.push({contentHash, blockIds})
  }

  // The proof's own rebuilds write and delete after that listing; judge the
  // folder as they left it.
  if (changes !== changesAtFinal) {
    signal?.throwIfAborted()
    view = assess(await io.listObjects(signal))
  }
  // Either listing counts: a rebuild can put back what something else removed.
  const vanished = new Set([...vanishedBeforeProof, ...view.vanished])
  for (const path of vanished) errors.push({path, message: 'seen earlier in this run, missing from the final listing'})
  if (vanished.size > 0) unsettled = true
  for (const path of [...converted, ...deleted]) {
    if (view.listed.has(path)) errors.push({path, message: 'deleted, but still listed'})
  }
  const {rawRemaining} = view
  // Archived means the archived BYTES: a path whose occupant this run proved a
  // genuine keyed copy (a poisoned occupant replaced, say) no longer holds them.
  const archivedRemaining = view.listing.filter(path => bundle?.archivedPaths.has(path) && !provenKeyed.has(path))
  const proof: CleanerProof =
    !unsettled && rawRemaining.length === 0 && archivedRemaining.length === 0 && unverified.length === 0
      ? {kind: 'passed', unrecoverable}
      : {kind: 'not-passed', rawRemaining, archivedRemaining, unverified, unsettled}
  return {
    converted: converted.filter(path => !view.listed.has(path)),
    refused,
    deleted: deleted.filter(path => !view.listed.has(path)),
    left,
    rebuilt,
    errors,
    bundleFault,
    proof,
  }
}
