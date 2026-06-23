/**
 * Device-local approval store for extension modules (issue #67), which
 * doubles as the persistent compile cache (issue #167).
 *
 * Each row is a *trust grant*: its presence means "on THIS device, the
 * user has reviewed this block's source (hash `sourceHash`) and approved
 * it to run." A user-extension block executes only if such a row exists,
 * and it runs the row's PINNED `compiled` output — never the live
 * `block.content` — so a source change synced from elsewhere can't
 * silently execute new code (#67). The same pinned output is what lets a
 * warm boot rebuild the module without loading Babel (#167): the trust
 * record and the compile cache are one and the same row.
 *
 * Write discipline: rows are written ONLY by an explicit approval
 * (`approveExtension` in `compileExtensionModule.ts`), never as a
 * side-effect of loading/compiling. That is the line between Phase 1's
 * implicit auto-approve (every compile wrote a row) and Phase 2's
 * device-local trust gate.
 *
 * Keyed by `blockId` (globally-unique), so each block occupies exactly
 * one row, overwritten on re-approval (an explicit update). `delete`
 * revokes a single approval (disable / uninstall / remote-disable);
 * `clear` empties the whole store (§6 lock & wipe boot path).
 *
 * Mirrors the interface + in-memory-fallback + IndexedDB pattern of
 * `sync/keys/keyStore.ts`. Unlike that store — which holds a
 * non-cloneable `CryptoKey` and therefore can't run under Node's
 * `structuredClone` — our records are plain JSON, so the IndexedDB path
 * is exercised directly in tests via `fake-indexeddb`.
 */

export interface CompiledRecord {
  /** Pure SHA-256 of `approvedSource`. NOT salted by compiler version
   *  (that lives in `compilerVersion`): this is the exact content the
   *  user approved, so a compiler bump must invalidate the cached
   *  *output* without looking like a *source* change (which would
   *  require re-approval). The execution gate compares this against
   *  `sha256(live block.content)` to detect drift. */
  sourceHash: string
  /** The exact source the user approved. Kept (not just its hash) so a
   *  compiler-version bump can recompile the APPROVED source even when
   *  the live block content has since drifted — we must never silently
   *  recompile from the drifted (un-approved) live source. */
  approvedSource: string
  /** Transpiled JS string (Babel output) of `approvedSource`, ready for
   *  blob-URL import. This is what actually runs — the pinned output. */
  compiled: string
  /** The `COMPILER_VERSION` the `compiled` string was produced under. A
   *  bump invalidates the cached output (forces a recompile from
   *  `approvedSource`) while leaving `sourceHash` — and therefore the
   *  approval itself — intact. */
  compilerVersion: string
  /** Epoch ms the approval was granted/last updated. Display + debug
   *  only; not load-bearing for the trust decision. */
  approvedAt: number
}

/** A device-local store of approved/transpiled extension modules, keyed
 *  by block id. All operations are async (IndexedDB) and must tolerate
 *  being called when persistence is unavailable — see the in-memory
 *  fallback. */
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
