/**
 * Shared scaffolding for the app's keyed, single-object-store IndexedDB stores.
 *
 * Several stores follow the same shape: one named DB holding one object store,
 * values addressed by a string key, with a cached connection and commit-durable
 * writes. Each used to hand-roll the same glue — `promisifyRequest`, a cached
 * `openDb` that clears its handle on a rejected open, and a `tx` that resolves
 * on the transaction's `oncomplete` (durability) rather than the request's
 * `onsuccess`. Every IndexedDB-durability fix then had to be applied in each
 * copy or they silently diverged. This module is the single copy. Consumers:
 *   - `src/extensions/compiledModuleCache.ts` (approved/compiled extensions)
 *   - `src/sync/keys/keyStore.ts` (per-device workspace keys — browser-only path)
 *   - `src/attachments/uploadStore.ts` (the byte-upload staging queue; adopts
 *     this when #265 lands — see that file)
 *
 * Records are stored under an opaque string key; {@link idbRecordId} builds a
 * collision-free `(owner, id)` composite for the stores that namespace records
 * per account.
 *
 * TRANSACTION ACTIVENESS (load-bearing): an IndexedDB transaction is only
 * "active" within the task that created it and its request callbacks — it
 * auto-commits once control returns to the event loop with no outstanding
 * request. {@link tx} and {@link openTransaction} therefore issue (or hand back
 * a store ready to issue) the FIRST request in the same task that created the
 * transaction: every `await` between creating the tx and issuing its first
 * request resolves via a microtask within that same task (the awaited promises
 * are either already-settled or settle on the IDB open event), so the tx is
 * still active. A caller of {@link openTransaction} MUST likewise issue its
 * first request synchronously after the await, before yielding to a later task.
 */

/** Promisify a single `IDBRequest` — resolve on success, reject on error. */
export const promisifyRequest = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

/** Resolve when the transaction COMMITS (`oncomplete`), reject on abort/error.
 *  A readwrite write is only durable once the tx commits — `onsuccess` fires
 *  earlier, while the tx is still open — so a caller that navigates/reloads
 *  right after a write can have an un-committed tx rolled back. Handlers are
 *  registered synchronously by the caller (before any await) so an `oncomplete`
 *  that fires before we start awaiting can't be missed. */
const txCommitted = (transaction: IDBTransaction): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction error'))
  })

/** Record-id prefix for all of an owner's records. The trailing `:` plus
 *  `encodeURIComponent` (which escapes any literal `:` to `%3A`) makes this an
 *  unambiguous, collision-free prefix — `enc("ab"):` is never a prefix of
 *  `enc("abc"):…`, so a `startsWith(prefix)` scan can't match a sibling owner. */
export const idbKeyPrefix = (owner: string): string =>
  `${encodeURIComponent(owner)}:`

/** Composite record id. Each segment is encoded so a delimiter inside an id
 *  can't make two distinct `(owner, id)` pairs collide. */
export const idbRecordId = (owner: string, id: string): string =>
  `${idbKeyPrefix(owner)}${encodeURIComponent(id)}`

/**
 * A cached connection to one named DB + one object store, with commit-durable
 * transactions. Each instance owns its own connection handle, so constructing a
 * fresh instance against the same DB models a page reload (a new tab/handle
 * reopening persisted data) — which is exactly how the consumers' tests verify
 * durability.
 */
export class IdbKeyedStore {
  private dbPromise: Promise<IDBDatabase> | null = null

  constructor(
    private readonly dbName: string,
    private readonly storeName: string,
    private readonly version: number = 1,
  ) {}

  private openDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(this.dbName, this.version)
        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains(this.storeName)) {
            db.createObjectStore(this.storeName)
          }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      }).catch((err: unknown) => {
        // Don't cache a rejected open: a transient failure (storage pressure, a
        // racing version upgrade) would otherwise wedge every later op on this
        // instance forever. Clear the handle so the next call retries a fresh
        // open.
        this.dbPromise = null
        throw err
      })
    }
    return this.dbPromise
  }

  /**
   * Open a transaction and return its object store plus a commit fence. Low-level
   * escape hatch — prefer {@link runTransaction} / {@link tx} / {@link deleteByPrefix},
   * which manage the fence for you. The caller MUST issue its first request
   * synchronously after awaiting (see the activeness note in the file header) and
   * MUST observe `committed` on EVERY path — `await` it after the last request, and
   * on an error path `.catch` it — or a tx abort surfaces as an unhandled rejection.
   */
  async openTransaction(
    mode: IDBTransactionMode,
  ): Promise<{store: IDBObjectStore; committed: Promise<void>}> {
    const db = await this.openDb()
    const transaction = db.transaction(this.storeName, mode)
    // Register the commit fence synchronously, before any further await.
    const committed = txCommitted(transaction)
    const store = transaction.objectStore(this.storeName)
    return {store, committed}
  }

  /**
   * Run `body` against the store within one transaction and resolve on the
   * transaction COMMIT (durability), not a request's `onsuccess`. `body` MUST
   * issue its first request synchronously — it is invoked in the same task that
   * created the tx (see the file header on activeness). If `body` rejects (or the
   * commit fence does), the fence's rejection is observed here so it can't surface
   * as an unhandled rejection, and the original error propagates. Use for cursor
   * scans / read-modify-write; single-request ops use {@link tx}.
   */
  async runTransaction<T>(
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    const {store, committed} = await this.openTransaction(mode)
    try {
      const result = await body(store)
      await committed
      return result
    } catch (err) {
      // body — or the awaited fence — rejected; the tx aborts. Attach a handler so
      // the fence's (possibly still-pending) rejection is observed, then rethrow.
      committed.catch(() => {})
      throw err
    }
  }

  /**
   * Run a single request against the store, resolving on the transaction COMMIT
   * (durability). The common case; multi-request / cursor work uses
   * {@link runTransaction}.
   */
  async tx<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    return this.runTransaction(mode, store => promisifyRequest(run(store)))
  }

  /**
   * Delete every record whose key starts with `prefix` (the per-owner namespace
   * from {@link idbKeyPrefix}), in one commit-durable readwrite transaction. A
   * plain `startsWith` over the (small) store avoids IDBKeyRange string-bound
   * subtleties; the `:`-delimited prefix is collision-free across owners.
   */
  async deleteByPrefix(prefix: string): Promise<void> {
    await this.runTransaction(
      'readwrite',
      store =>
        new Promise<void>((resolve, reject) => {
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
        }),
    )
  }
}
