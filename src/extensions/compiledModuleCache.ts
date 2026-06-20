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
 * (a globally-unique id) keeps the store bounded by the number of
 * installed extensions — a row is overwritten when its source changes,
 * so there is nothing to evict.
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
  /** Drop every row. This is a derived cache of (potentially
   *  E2EE-workspace) extension *source*, so the §6 lock & wipe flow
   *  clears it to avoid leaving plaintext behind after the SQLite DB is
   *  wiped. The store has no per-user/per-workspace dimension (keyed only
   *  by the globally-unique blockId), so the clear is coarse — but
   *  over-clearing is harmless here: unlike workspace keys, a dropped
   *  compiled row only costs a one-time recompile, never a lockout. */
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
