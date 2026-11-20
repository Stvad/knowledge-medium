/**
 * Per-device workspace-key (WK) store (design doc §5).
 *
 * On a device the WK lives as a NON-EXTRACTABLE `CryptoKey`, keyed by
 * `(user_id, workspace_id)`. The production backing is IndexedDB:
 * localStorage holds strings only and can store neither a `CryptoKey`
 * nor raw key bytes safely, whereas IndexedDB structured-clones the
 * non-extractable handle so JS can *use* it (encrypt/decrypt) but never
 * read the bytes out. IndexedDB may be evicted under storage pressure —
 * acceptable, because the model already requires the user to keep a
 * backup of the WK (§5).
 *
 * The store is an interface so the coordinating layer (§8 flows, §9
 * sync seam) depends on a capability, not on IndexedDB. Tests and the
 * no-IndexedDB fallback use {@link InMemoryWorkspaceKeyStore}.
 *
 * NOTE on testing: a `CryptoKey` is structured-cloneable in browsers but
 * NOT under Node's `structuredClone`, so a `CryptoKey` round trip through the
 * store can only be exercised in a real browser — browser-validated via the
 * §8 flows (unlock → reload → still unlocked). Everything else about the
 * IndexedDB store is Node-tested over fake-indexeddb with plain-object records.
 */

import type {WorkspaceObjectKeys} from '../crypto/contentKey.js'
import {IdbKeyedStore, idbKeyPrefix, idbRecordId} from '@/utils/idbKeyedStore.js'

/**
 * One per-device record per `(user_id, workspace_id)`: the workspace key (WK)
 * and its derived content-key HMAC subkey (`K_id`, §10).
 *
 * They are CO-LOCATED in one record (not two) so they evict together: IndexedDB
 * is best-effort evictable, and losing only `K_id` while the WK handle survived
 * would silently fail-close media (text still working) — a confusing partial
 * state. One record means one atomic write/evict.
 *
 * `contentKeyHmac` is `null` for a LEGACY record written before this feature
 * (the WK was stored as a bare `CryptoKey`; the raw bytes K_id needs are long
 * since zeroed, and K_id can't be re-derived from the non-extractable WK). The
 * §6 gate ({@link resolveWorkspaceEntry}) treats a K_id-less record as LOCKED, so
 * an upgrading device is prompted to re-paste / re-unlock the WK once — which
 * co-derives K_id — rather than opening `ready` into permanently-broken media. (A
 * one-time re-unlock briefly gates text too; accepted as the simplest migration at
 * our scale.) `normalizeKeyRecord` maps the legacy shape to `{ wk, contentKeyHmac:
 * null }` on read.
 */
export interface WorkspaceKeyRecord {
  readonly wk: CryptoKey
  readonly contentKeyHmac: CryptoKey | null
}

/** The keys that seal and name a workspace's objects, or null for a record
 *  with no K_id yet (the legacy shape). */
export const objectKeysOf = (record: WorkspaceKeyRecord): WorkspaceObjectKeys | null =>
  record.contentKeyHmac ? {cek: record.wk, contentKeyHmac: record.contentKeyHmac} : null

/** Normalize a raw stored value to a {@link WorkspaceKeyRecord}: a new-shape
 *  record passes through; a LEGACY bare `CryptoKey` (pre-K_id) becomes
 *  `{ wk, contentKeyHmac: null }`; `null`/`undefined` stays `null`. Exported for
 *  direct unit testing — the IndexedDB read can't be exercised under Node. */
export const normalizeKeyRecord = (stored: unknown): WorkspaceKeyRecord | null => {
  if (stored == null) return null
  // The new shape is a plain object carrying `wk`; a legacy value is the bare
  // WK CryptoKey itself (no `wk` property).
  if (typeof stored === 'object' && 'wk' in stored) return stored as WorkspaceKeyRecord
  return { wk: stored as CryptoKey, contentKeyHmac: null }
}

/**
 * The stored record if it can open the workspace fully: a WK AND its K_id. A
 * LEGACY record (no K_id) can decrypt text but not media, and K_id can't be
 * re-derived from the stored non-extractable WK — only a re-paste repopulates
 * it — so it counts as no key: the gate prompts the re-paste instead of opening
 * into permanently-broken media. Throws when the store can't be read.
 */
export const getUsableKeyRecord = async (
  keyStore: WorkspaceKeyStore,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceKeyRecord | null> => {
  const record = await keyStore.get(userId, workspaceId)
  return record?.contentKeyHmac ? record : null
}

/** {@link getUsableKeyRecord}, reading an unreadable store (IndexedDB
 *  unavailable / corrupt / quota, a record the device cannot read) as "no key"
 *  — for callers that fail closed on absence and must not throw. The entry
 *  gate is one: it asks for the key rather than open a workspace it cannot
 *  decrypt. */
export const readUsableKeyRecord = async (
  keyStore: WorkspaceKeyStore,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceKeyRecord | null> => {
  try {
    return await getUsableKeyRecord(keyStore, userId, workspaceId)
  } catch (err) {
    console.warn(`[keyStore] key read failed for ${workspaceId}; treating as absent`, err)
    return null
  }
}

/** The record is stored but cannot be read right now: a locked iOS device
 *  reads a stored record as `null`, without an error. */
export class KeyRecordUnreadableError extends Error {
  constructor(workspaceId: string) {
    super(`the stored workspace key for ${workspaceId} cannot be read right now`)
    this.name = 'KeyRecordUnreadableError'
  }
}

export interface WorkspaceKeyStore {
  /** The stored record, or null when there is none. Throws when the store
   *  cannot say: an unreadable record is not an absent one. */
  get(userId: string, workspaceId: string): Promise<WorkspaceKeyRecord | null>
  put(userId: string, workspaceId: string, record: WorkspaceKeyRecord): Promise<void>
  delete(userId: string, workspaceId: string): Promise<void>
  /** Drop every stored WK FOR THIS USER. Scoped to `userId` (not the whole
   *  store) because the IndexedDB store is shared across all accounts in the
   *  browser profile, so clearing another account's keys would lock its e2ee
   *  workspaces. Currently unused in-app — the per-workspace lock-&-wipe flow
   *  that called this was removed (a full "clear site data" wipe drops the whole
   *  store); kept as a store primitive with its own tests. */
  clearForUser(userId: string): Promise<void>
}

/** IndexedDB record-id prefix for all of a user's keys — the shared
 *  collision-free `encodeURIComponent`-delimited prefix ({@link idbKeyPrefix}):
 *  `enc("ab"):` is never a prefix of `enc("abc"):…`. */
export const keyStoreUserPrefix = (userId: string): string => idbKeyPrefix(userId)

/** Composite record id. Encoded so a delimiter inside an id can't make
 *  two distinct (user, workspace) pairs collide ({@link idbRecordId}). */
export const keyStoreRecordId = (userId: string, workspaceId: string): string =>
  idbRecordId(userId, workspaceId)

/** In-memory store. Used in tests and as the fallback when IndexedDB is
 *  unavailable (the WK then lives only for the page's lifetime, which the
 *  backup-required model tolerates). */
export class InMemoryWorkspaceKeyStore implements WorkspaceKeyStore {
  private readonly keys = new Map<string, WorkspaceKeyRecord>()

  async get(userId: string, workspaceId: string): Promise<WorkspaceKeyRecord | null> {
    return normalizeKeyRecord(this.keys.get(keyStoreRecordId(userId, workspaceId)))
  }

  async put(userId: string, workspaceId: string, record: WorkspaceKeyRecord): Promise<void> {
    this.keys.set(keyStoreRecordId(userId, workspaceId), record)
  }

  async delete(userId: string, workspaceId: string): Promise<void> {
    this.keys.delete(keyStoreRecordId(userId, workspaceId))
  }

  async clearForUser(userId: string): Promise<void> {
    const prefix = keyStoreUserPrefix(userId)
    for (const key of [...this.keys.keys()]) {
      if (key.startsWith(prefix)) this.keys.delete(key)
    }
  }
}

const DB_NAME = 'km-e2ee-keys'
const STORE_NAME = 'workspace_keys'

/** IndexedDB-backed store; the cached connection + commit-durable `tx` come
 *  from {@link IdbKeyedStore}. See the file header on testing. */
export class IndexedDbWorkspaceKeyStore implements WorkspaceKeyStore {
  private readonly idb = new IdbKeyedStore(DB_NAME, STORE_NAME)
  /** The last record each id read or wrote, served while the store cannot be
   *  read. A page that outlives the screen lock (one playing audio) keeps
   *  syncing, and without this every key read under the lock would fail. A
   *  read that finds NO record clears it, so a real loss still shows. */
  private readonly held = new Map<string, WorkspaceKeyRecord>()

  async get(userId: string, workspaceId: string): Promise<WorkspaceKeyRecord | null> {
    const id = keyStoreRecordId(userId, workspaceId)
    let stored: unknown
    try {
      stored = await this.idb.tx<unknown>('readonly', store => store.get(id))
      // An absent record reads as `undefined`; `null` is never written.
      if (stored === null) throw new KeyRecordUnreadableError(workspaceId)
    } catch (err) {
      const held = this.held.get(id)
      if (held) return held
      throw err
    }
    // A value written before the K_id feature is a bare CryptoKey; normalize it
    // to the record shape (with no K_id) so legacy devices read back cleanly.
    const record = normalizeKeyRecord(stored)
    if (record) this.held.set(id, record)
    else this.held.delete(id)
    return record
  }

  async put(userId: string, workspaceId: string, record: WorkspaceKeyRecord): Promise<void> {
    const id = keyStoreRecordId(userId, workspaceId)
    await this.idb.tx('readwrite', store => store.put(record, id))
    this.held.set(id, record)
  }

  async delete(userId: string, workspaceId: string): Promise<void> {
    const id = keyStoreRecordId(userId, workspaceId)
    await this.idb.tx('readwrite', store => store.delete(id))
    this.held.delete(id)
  }

  async clearForUser(userId: string): Promise<void> {
    // Delete only this user's records (commit-durable — a caller may navigate/
    // reload right after). The store is shared across the profile's accounts, so
    // the prefix scoping is load-bearing: it must not touch another account.
    const prefix = keyStoreUserPrefix(userId)
    await this.idb.deleteByPrefix(prefix)
    for (const id of [...this.held.keys()]) {
      if (id.startsWith(prefix)) this.held.delete(id)
    }
  }
}

/** Pick the production store when IndexedDB exists, else the in-memory
 *  fallback. */
export const createWorkspaceKeyStore = (): WorkspaceKeyStore => {
  try {
    if (typeof indexedDB !== 'undefined') {
      return new IndexedDbWorkspaceKeyStore()
    }
  } catch {
    // fall through
  }
  return new InMemoryWorkspaceKeyStore()
}

// Process-wide WK store. The §8 key flows and the §9 sync seam must share ONE
// store so a WK pasted/minted in a flow is the same handle the observer and
// upload connector resolve — an IndexedDB-backed instance is shared storage,
// but a single instance also keeps the in-memory fallback coherent within a
// session.
let sharedKeyStore: WorkspaceKeyStore | null = null
export const getWorkspaceKeyStore = (): WorkspaceKeyStore =>
  (sharedKeyStore ??= createWorkspaceKeyStore())
