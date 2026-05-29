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
 * NOT under Node's `structuredClone`, so the IndexedDB implementation
 * below can only be exercised in a real browser. Its keying logic is
 * factored into the pure {@link keyStoreRecordId} (unit-tested); the
 * IndexedDB glue itself is covered by the browser-validated flows in §8.
 */

export interface WorkspaceKeyStore {
  get(userId: string, workspaceId: string): Promise<CryptoKey | null>
  put(userId: string, workspaceId: string, key: CryptoKey): Promise<void>
  delete(userId: string, workspaceId: string): Promise<void>
  /** Drop every stored WK on this device — the key-material half of a §6
   *  Lock & wipe. (The mode pins live elsewhere and deliberately survive.) */
  clearAll(): Promise<void>
}

/** Composite record id. Encoded so a delimiter inside an id can't make
 *  two distinct (user, workspace) pairs collide. */
export const keyStoreRecordId = (userId: string, workspaceId: string): string =>
  `${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId)}`

/** In-memory store. Used in tests and as the fallback when IndexedDB is
 *  unavailable (the WK then lives only for the page's lifetime, which the
 *  backup-required model tolerates). */
export class InMemoryWorkspaceKeyStore implements WorkspaceKeyStore {
  private readonly keys = new Map<string, CryptoKey>()

  async get(userId: string, workspaceId: string): Promise<CryptoKey | null> {
    return this.keys.get(keyStoreRecordId(userId, workspaceId)) ?? null
  }

  async put(userId: string, workspaceId: string, key: CryptoKey): Promise<void> {
    this.keys.set(keyStoreRecordId(userId, workspaceId), key)
  }

  async delete(userId: string, workspaceId: string): Promise<void> {
    this.keys.delete(keyStoreRecordId(userId, workspaceId))
  }

  async clearAll(): Promise<void> {
    this.keys.clear()
  }
}

const DB_NAME = 'km-e2ee-keys'
const STORE_NAME = 'workspace_keys'
const DB_VERSION = 1

const promisifyRequest = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

/** IndexedDB-backed store (browser-only — see file header on testing). */
export class IndexedDbWorkspaceKeyStore implements WorkspaceKeyStore {
  private dbPromise: Promise<IDBDatabase> | null = null

  private openDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION)
        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME)
          }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      }).catch((err: unknown) => {
        // Don't cache a rejected open: a transient failure (storage pressure, a
        // racing version upgrade) would otherwise wedge every later get/put on
        // this instance forever. Clear the handle so the next call retries a
        // fresh open; the backup-required model tolerates a missed read.
        this.dbPromise = null
        throw err
      })
    }
    return this.dbPromise
  }

  private async tx<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.openDb()
    const store = db.transaction(STORE_NAME, mode).objectStore(STORE_NAME)
    return promisifyRequest(run(store))
  }

  async get(userId: string, workspaceId: string): Promise<CryptoKey | null> {
    const result = await this.tx<CryptoKey | undefined>('readonly', store =>
      store.get(keyStoreRecordId(userId, workspaceId)),
    )
    return result ?? null
  }

  async put(userId: string, workspaceId: string, key: CryptoKey): Promise<void> {
    await this.tx('readwrite', store =>
      store.put(key, keyStoreRecordId(userId, workspaceId)),
    )
  }

  async delete(userId: string, workspaceId: string): Promise<void> {
    await this.tx('readwrite', store =>
      store.delete(keyStoreRecordId(userId, workspaceId)),
    )
  }

  async clearAll(): Promise<void> {
    await this.tx('readwrite', store => store.clear())
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
