/**
 * Persistent (cross-reload) compile cache for extension modules.
 *
 * Issue #167: `@babel/standalone` (~0.85 MB gz) is needed *only* to
 * transpile an extension block's TS/JSX source into runnable JS. The
 * in-memory cache in `compileExtensionModule.ts` is empty on every cold
 * start, so the current fleet — where every user has ≥1 enabled
 * extension — re-runs Babel on every boot. Persisting the transpiled JS
 * lets a warm boot rebuild the module from the cached string via the
 * blob-URL path WITHOUT loading Babel at all; Babel is then fetched only
 * on a genuine cache miss (first-ever compile or the source changed).
 *
 * Storage shape — one self-contained row per block — is deliberately the
 * Phase-2 "approval record" shape running in implicit auto-approve mode:
 * issue #67 layers a device-local trust gate on top of the same row
 * (binding execution to an approved `sourceHash`). Keying by `blockId`
 * (a globally-unique id) means each LIVE extension occupies exactly one
 * row (overwritten when its source changes). Deleting a block leaves its
 * row orphaned — there is no production `delete`/evict caller yet (that's
 * Phase 2) — so the row count tracks cumulative blockId churn, not the
 * current extension count. The lock & wipe path empties the whole store
 * (`clearCompiledModuleCache`), which is the only thing that bounds it
 * today.
 *
 * Mirrors the interface + in-memory-fallback + IndexedDB pattern of
 * `sync/keys/keyStore.ts`. Unlike that store — which holds a
 * non-cloneable `CryptoKey` and therefore can't run under Node's
 * `structuredClone` — our records are plain JSON, so the IndexedDB path
 * is exercised directly in tests via `fake-indexeddb`.
 */

export interface CompiledRecord {
  /** Pure SHA-256 of the block's source. NOT salted by compiler version
   *  (that lives in `compilerVersion`) — Phase 2 reuses this exact hash
   *  as the content the user approves, and a compiler bump must not look
   *  like a source change. */
  sourceHash: string
  /** Transpiled JS string (Babel output) ready for blob-URL import. */
  compiled: string
  /** The `COMPILER_VERSION` the `compiled` string was produced under. A
   *  bump invalidates the row (forces recompile) while leaving
   *  `sourceHash` — and therefore any Phase-2 approval — intact. */
  compilerVersion: string
}

/** A device-local store of transpiled extension modules, keyed by block
 *  id. All operations are async (IndexedDB) and must tolerate being
 *  called when persistence is unavailable — see the in-memory fallback. */
export interface CompiledModuleCache {
  read(blockId: string): Promise<CompiledRecord | undefined>
  write(blockId: string, record: CompiledRecord): Promise<void>
  delete(blockId: string): Promise<void>
  /** Empty the whole store. Used by §6 lock & wipe's boot-time half to
   *  drop plaintext-derived extension source that lives OUTSIDE the
   *  per-user SQLite file. Clearing through a transaction (rather than
   *  `deleteDatabase`) is deliberate: a delete is BLOCKED by any
   *  concurrent connection — a sibling tab mid-reload during the wipe is
   *  exactly that — whereas a readwrite `clear()` is not. Coarse (no
   *  per-user/workspace dimension), but over-clearing only costs a
   *  recompile, never a lockout. */
  clear(): Promise<void>
}

/** In-memory store. Used in tests and as the fallback when IndexedDB is
 *  unavailable (private-mode, SSR, etc.) — persistence then degrades to
 *  "per page lifetime", which just means the next cold start recompiles
 *  via Babel, exactly the pre-#167 behavior. */
export class InMemoryCompiledModuleCache implements CompiledModuleCache {
  private readonly rows = new Map<string, CompiledRecord>()

  async read(blockId: string): Promise<CompiledRecord | undefined> {
    return this.rows.get(blockId)
  }

  async write(blockId: string, record: CompiledRecord): Promise<void> {
    this.rows.set(blockId, record)
  }

  async delete(blockId: string): Promise<void> {
    this.rows.delete(blockId)
  }

  async clear(): Promise<void> {
    this.rows.clear()
  }
}

export const DB_NAME = 'km-extension-compiled'
export const STORE_NAME = 'compiled_modules'
const DB_VERSION = 1

const promisifyRequest = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

/** IndexedDB-backed store. The values are plain JSON, so unlike
 *  `keyStore.ts` this path runs fine under `fake-indexeddb` in tests. */
export class IndexedDbCompiledModuleCache implements CompiledModuleCache {
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
        // Don't cache a rejected open: a transient failure (storage
        // pressure, a racing version upgrade) would otherwise wedge every
        // later read/write on this instance. Clear the handle so the next
        // call retries a fresh open — a missed read just recompiles.
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
    const transaction = db.transaction(STORE_NAME, mode)
    // Resolve on the transaction commit (`oncomplete`), not just the
    // request's `onsuccess` — a write is only durable once the tx
    // commits, and the cross-reload read in our tests depends on that
    // durability. Register handlers synchronously so a commit that fires
    // before we await can't be missed.
    const committed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('IndexedDB transaction error'))
    })
    const store = transaction.objectStore(STORE_NAME)
    const result = await promisifyRequest(run(store))
    await committed
    return result
  }

  async read(blockId: string): Promise<CompiledRecord | undefined> {
    const result = await this.tx<CompiledRecord | undefined>('readonly', store =>
      store.get(blockId),
    )
    return result ?? undefined
  }

  async write(blockId: string, record: CompiledRecord): Promise<void> {
    await this.tx('readwrite', store => store.put(record, blockId))
  }

  async delete(blockId: string): Promise<void> {
    await this.tx('readwrite', store => store.delete(blockId))
  }

  async clear(): Promise<void> {
    await this.tx('readwrite', store => store.clear())
  }
}

/** Pick the IndexedDB store when available, else the in-memory fallback. */
export const createCompiledModuleCache = (): CompiledModuleCache => {
  try {
    if (typeof indexedDB !== 'undefined') {
      return new IndexedDbCompiledModuleCache()
    }
  } catch {
    // fall through to in-memory
  }
  return new InMemoryCompiledModuleCache()
}

// Process-wide singleton shared by the loader. Tests inject their own
// instance and never touch this.
let sharedCache: CompiledModuleCache | null = null
export const getCompiledModuleCache = (): CompiledModuleCache =>
  (sharedCache ??= createCompiledModuleCache())

/**
 * Empty the compiled-module store, best-effort and never-rejecting. Used
 * by §6 lock & wipe's boot-time half (`consumePendingWipe`) to remove
 * plaintext-derived extension source that lives OUTSIDE the per-user
 * SQLite file the wipe deletes.
 *
 * Goes through the cache's `clear()` (a readwrite transaction) rather than
 * `indexedDB.deleteDatabase`: a database delete is blocked by any
 * concurrent connection — a sibling tab still mid-reload during the wipe
 * is exactly that — and could silently no-op, whereas a `clear()` tx
 * isn't blocked by other connections. Swallows any error: a derived cache
 * must never strand the boot or the wipe (the load-bearing plaintext
 * removal is the SQLite file delete).
 */
export const clearCompiledModuleCache = async (): Promise<void> => {
  try {
    await getCompiledModuleCache().clear()
  } catch (error) {
    console.warn('Failed to clear compiled-extension cache', error)
  }
}
