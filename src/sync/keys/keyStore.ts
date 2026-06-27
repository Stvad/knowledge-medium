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
 * NOT under Node's `structuredClone`, so the `CryptoKey`-storing path below
 * can only be exercised in a real browser. Its keying logic is factored into
 * the pure {@link keyStoreRecordId} (unit-tested), and the IndexedDB plumbing
 * now lives in the shared {@link IdbKeyedStore} (Node-tested via fake-indexeddb).
 * What remains browser-only is this store's wiring of that plumbing to a
 * `CryptoKey` value — browser-validated via the §8 flows (unlock → reload →
 * still unlocked).
 */

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

export interface WorkspaceKeyStore {
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

/** IndexedDB-backed store. Stores a `CryptoKey`-bearing record, so the
 *  round-trip can only run in a real browser (see the file header on testing);
 *  the cached connection + commit-durable `tx` come from {@link IdbKeyedStore}. */
export class IndexedDbWorkspaceKeyStore implements WorkspaceKeyStore {
  private readonly idb = new IdbKeyedStore(DB_NAME, STORE_NAME)

  async get(userId: string, workspaceId: string): Promise<WorkspaceKeyRecord | null> {
    // A value written before the K_id feature is a bare CryptoKey; normalize it
    // to the record shape (with no K_id) so legacy devices read back cleanly.
    const result = await this.idb.tx<unknown>('readonly', store =>
      store.get(keyStoreRecordId(userId, workspaceId)),
    )
    return normalizeKeyRecord(result)
  }

  async put(userId: string, workspaceId: string, record: WorkspaceKeyRecord): Promise<void> {
    await this.idb.tx('readwrite', store =>
      store.put(record, keyStoreRecordId(userId, workspaceId)),
    )
  }

  async delete(userId: string, workspaceId: string): Promise<void> {
    await this.idb.tx('readwrite', store =>
      store.delete(keyStoreRecordId(userId, workspaceId)),
    )
  }

  async clearForUser(userId: string): Promise<void> {
    const prefix = keyStoreUserPrefix(userId)
    const {store, committed} = await this.idb.openTransaction('readwrite')
    // Cursor over the (small) store, deleting only this user's records. A plain
    // startsWith check avoids any IDBKeyRange string-bound subtlety; the store
    // holds at most a handful of keys (one per workspace per account). The commit
    // fence (durability) matters: a caller may navigate/reload right after this.
    await new Promise<void>((resolve, reject) => {
      const request = store.openCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) {
          resolve()
          return
        }
        if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) {
          cursor.delete()
        }
        cursor.continue()
      }
      request.onerror = () => reject(request.error)
    })
    await committed
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
// session. Tests inject their own store and never touch this singleton.
let sharedKeyStore: WorkspaceKeyStore | null = null
export const getWorkspaceKeyStore = (): WorkspaceKeyStore =>
  (sharedKeyStore ??= createWorkspaceKeyStore())
