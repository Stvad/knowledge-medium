/**
 * Durable byte-upload staging store (design §9/§11 — the up-lane's queue).
 *
 * Bytes ride a parallel lane to Supabase Storage (NOT PowerSync), so they need
 * their OWN durable queue — `ps_crud` carries block metadata only. This store is
 * that queue: one record per un-uploaded asset, surviving reload, that the
 * up-lane drains.
 *
 * Lifecycle (one persisted `status` field):
 *   staged  — written BEFORE the block tx, NOT drainable. Closes the orphan-upload
 *             window: if the tx never commits (crash), the boot reconciler reaps a
 *             `staged` record whose block is absent past the settled checkpoint, so
 *             we never upload bytes for a block that doesn't exist.
 *   pending — flipped from `staged` AFTER the tx commits (`promote`). Drainable.
 *   failed  — a permanent upload rejection, or retries exhausted (§9 recovery can
 *             requeue it). A confirmed upload DELETES the record (no terminal
 *             "cleared" value is retained).
 *
 * Keyed by `(user_id, asset_block_id)` — `user_id` is load-bearing: the OPFS byte
 * store and this queue are shared across the browser profile's accounts but drain
 * per-user under the active session, so every op is namespaced by the user.
 *
 * The production backing is IndexedDB (commit-durable — see {@link
 * IndexedDbByteUploadStore.tx}); tests and the no-IndexedDB fallback use
 * {@link InMemoryByteUploadStore}. Records are plain JSON, so unlike the keyStore
 * the IndexedDB implementation IS exercisable under Node (fake-indexeddb).
 */

export type ByteUploadStatus = 'staged' | 'pending' | 'failed'

/** A queue record. Carries everything the drain needs to encode + upload without
 *  reading the block back (the bytes themselves live in the OPFS byte store,
 *  keyed by `contentKey`). */
export interface ByteUploadRecord {
  readonly userId: string
  /** The deterministic asset block id (a UUIDv5 of workspace + content-key). */
  readonly assetBlockId: string
  readonly workspaceId: string
  /** `sha256:<hex>` of the PLAINTEXT bytes — the encode AAD + read-side verify. */
  readonly contentHash: string
  /** The Storage path segment + OPFS byte-store key (raw sha256 / keyed-HMAC). */
  readonly contentKey: string
  readonly status: ByteUploadStatus
  /** Drain retry counter — bumped on a transient failure, bounds the retries. */
  readonly attempts: number
  /** ms epoch when (re-)staged — `stage` re-stamps it on every re-arm. Doubles as
   *  the age-based retry bound AND the optimistic-concurrency stamp a drain passes to
   *  {@link ByteUploadStore.markFailed}/{@link ByteUploadStore.recordAttempt} so a
   *  stale terminal decision can't bury a concurrent re-paste (see those methods). */
  readonly stagedAt: number
}

/** What the caller supplies to {@link ByteUploadStore.stage}; the store stamps
 *  `status: 'staged'`, `attempts: 0`, and `stagedAt` from its clock. */
export type StageInput = Pick<
  ByteUploadRecord,
  'userId' | 'assetBlockId' | 'workspaceId' | 'contentHash' | 'contentKey'
>

export interface ByteUploadStore {
  /** Upsert a `staged` record. Idempotent: a re-paste of the same content (same
   *  `assetBlockId`) re-arms — status→staged, attempts→0, fresh stagedAt. */
  stage(input: StageInput): Promise<void>
  get(userId: string, assetBlockId: string): Promise<ByteUploadRecord | null>
  /** All of the user's records in the given status (drain reads `pending`, the
   *  reconciler reads `staged`). Scoped to `userId`. */
  listByStatus(userId: string, status: ByteUploadStatus): Promise<ByteUploadRecord[]>
  /** staged → pending (the post-commit flip). No-op if the record is absent. */
  promote(userId: string, assetBlockId: string): Promise<void>
  /** attempts += 1, status unchanged. No-op if absent — or, when `expectedStagedAt`
   *  is given and the live record's `stagedAt` has advanced (a re-paste re-armed it
   *  since the drain snapshotted it), a no-op: a stale drain decision must not touch a
   *  freshly re-armed record. */
  recordAttempt(userId: string, assetBlockId: string, expectedStagedAt?: number): Promise<void>
  /** → failed. No-op if absent, or if the record was re-armed since `expectedStagedAt`
   *  (see {@link recordAttempt}) — otherwise a stale drain buries a live re-paste in
   *  `failed`, which nothing re-drains. */
  markFailed(userId: string, assetBlockId: string, expectedStagedAt?: number): Promise<void>
  /** Remove the record (a confirmed upload). */
  delete(userId: string, assetBlockId: string): Promise<void>
  /** Drop every record FOR THIS USER (account isolation — the store is shared
   *  across the profile's accounts). */
  clearForUser(userId: string): Promise<void>
}

/** Record-id prefix for all of a user's records. Trailing `:` + `encodeURIComponent`
 *  (which escapes any literal `:`) makes it an unambiguous, collision-free prefix. */
export const uploadUserPrefix = (userId: string): string => `${encodeURIComponent(userId)}:`

/** Composite record id; encoded so a delimiter inside an id can't make two
 *  distinct (user, asset) pairs collide. */
export const uploadRecordId = (userId: string, assetBlockId: string): string =>
  `${uploadUserPrefix(userId)}${encodeURIComponent(assetBlockId)}`

const stagedRecord = (input: StageInput, stagedAt: number): ByteUploadRecord => ({
  ...input,
  status: 'staged',
  attempts: 0,
  stagedAt,
})

/** Optimistic-concurrency guard for the drain's terminal/attempt writes. The drain
 *  reads a `pending` snapshot, then does a SLOW upload before deciding to fail/retry
 *  it — but capture is lock-free, so a re-paste of the same content can re-arm that
 *  record (`stage` bumps `stagedAt`) during the upload. A re-arm supersedes the
 *  drain's stale decision; `markFailed`/`recordAttempt` pass the snapshot's
 *  `stagedAt` and skip the write when the live stamp has moved. */
const supersededByReArm = (r: ByteUploadRecord, expectedStagedAt: number | undefined): boolean =>
  expectedStagedAt !== undefined && r.stagedAt !== expectedStagedAt

/** In-memory store. Tests + the fallback when IndexedDB is unavailable (the queue
 *  then lives only for the page's lifetime — a reload loses un-uploaded intents,
 *  the same failure class IndexedDB eviction already allows, recovered by re-paste). */
export class InMemoryByteUploadStore implements ByteUploadStore {
  private readonly records = new Map<string, ByteUploadRecord>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  async stage(input: StageInput): Promise<void> {
    this.records.set(uploadRecordId(input.userId, input.assetBlockId), stagedRecord(input, this.now()))
  }

  async get(userId: string, assetBlockId: string): Promise<ByteUploadRecord | null> {
    return this.records.get(uploadRecordId(userId, assetBlockId)) ?? null
  }

  async listByStatus(userId: string, status: ByteUploadStatus): Promise<ByteUploadRecord[]> {
    const prefix = uploadUserPrefix(userId)
    return [...this.records.entries()]
      .filter(([id, r]) => id.startsWith(prefix) && r.status === status)
      .map(([, r]) => r)
  }

  private mutate(
    userId: string,
    assetBlockId: string,
    fn: (r: ByteUploadRecord) => ByteUploadRecord,
  ): void {
    const id = uploadRecordId(userId, assetBlockId)
    const existing = this.records.get(id)
    if (existing) this.records.set(id, fn(existing))
  }

  async promote(userId: string, assetBlockId: string): Promise<void> {
    this.mutate(userId, assetBlockId, r => ({ ...r, status: 'pending' }))
  }

  async recordAttempt(userId: string, assetBlockId: string, expectedStagedAt?: number): Promise<void> {
    this.mutate(userId, assetBlockId, r =>
      supersededByReArm(r, expectedStagedAt) ? r : { ...r, attempts: r.attempts + 1 },
    )
  }

  async markFailed(userId: string, assetBlockId: string, expectedStagedAt?: number): Promise<void> {
    this.mutate(userId, assetBlockId, r =>
      supersededByReArm(r, expectedStagedAt) ? r : { ...r, status: 'failed' },
    )
  }

  async delete(userId: string, assetBlockId: string): Promise<void> {
    this.records.delete(uploadRecordId(userId, assetBlockId))
  }

  async clearForUser(userId: string): Promise<void> {
    const prefix = uploadUserPrefix(userId)
    for (const id of [...this.records.keys()]) {
      if (id.startsWith(prefix)) this.records.delete(id)
    }
  }
}

export const UPLOAD_STORE_DB_NAME = 'km-byte-uploads'
const STORE_NAME = 'uploads'
const DB_VERSION = 1

const promisifyRequest = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

/** IndexedDB-backed store. Writes resolve on the TRANSACTION commit (`oncomplete`),
 *  not the request's `onsuccess`, so a capture's `stage` is genuinely durable
 *  before we proceed to the block tx (the whole point of staging-before-commit). */
export class IndexedDbByteUploadStore implements ByteUploadStore {
  private dbPromise: Promise<IDBDatabase> | null = null

  constructor(private readonly now: () => number = () => Date.now()) {}

  private openDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(UPLOAD_STORE_DB_NAME, DB_VERSION)
        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      }).catch((err: unknown) => {
        // Don't cache a rejected open — clear the handle so the next call retries.
        this.dbPromise = null
        throw err
      })
    }
    return this.dbPromise
  }

  /** Run `run` against the store and resolve on the tx COMMIT (durability). */
  private async tx<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.openDb()
    const transaction = db.transaction(STORE_NAME, mode)
    const committed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB tx aborted'))
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB tx error'))
    })
    const store = transaction.objectStore(STORE_NAME)
    const result = await promisifyRequest(run(store))
    await committed
    return result
  }

  async stage(input: StageInput): Promise<void> {
    const record = stagedRecord(input, this.now())
    await this.tx('readwrite', store =>
      store.put(record, uploadRecordId(input.userId, input.assetBlockId)),
    )
  }

  async get(userId: string, assetBlockId: string): Promise<ByteUploadRecord | null> {
    const result = await this.tx<ByteUploadRecord | undefined>('readonly', store =>
      store.get(uploadRecordId(userId, assetBlockId)),
    )
    return result ?? null
  }

  async listByStatus(userId: string, status: ByteUploadStatus): Promise<ByteUploadRecord[]> {
    const prefix = uploadUserPrefix(userId)
    const db = await this.openDb()
    const transaction = db.transaction(STORE_NAME, 'readonly')
    const store = transaction.objectStore(STORE_NAME)
    return new Promise<ByteUploadRecord[]>((resolve, reject) => {
      const out: ByteUploadRecord[] = []
      const request = store.openCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) {
          resolve(out)
          return
        }
        const record = cursor.value as ByteUploadRecord
        if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix) && record.status === status) {
          out.push(record)
        }
        cursor.continue()
      }
      request.onerror = () => reject(request.error)
    })
  }

  /** Read-modify-write a single record inside one readwrite tx. A missing record
   *  is a no-op (a reaped/never-staged id mustn't crash the post-commit flip). */
  private async mutate(
    userId: string,
    assetBlockId: string,
    fn: (r: ByteUploadRecord) => ByteUploadRecord,
  ): Promise<void> {
    const id = uploadRecordId(userId, assetBlockId)
    const db = await this.openDb()
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    const committed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB tx aborted'))
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB tx error'))
    })
    const store = transaction.objectStore(STORE_NAME)
    const existing = await promisifyRequest(store.get(id) as IDBRequest<ByteUploadRecord | undefined>)
    if (existing) await promisifyRequest(store.put(fn(existing), id))
    await committed
  }

  async promote(userId: string, assetBlockId: string): Promise<void> {
    await this.mutate(userId, assetBlockId, r => ({ ...r, status: 'pending' }))
  }

  async recordAttempt(userId: string, assetBlockId: string, expectedStagedAt?: number): Promise<void> {
    await this.mutate(userId, assetBlockId, r =>
      supersededByReArm(r, expectedStagedAt) ? r : { ...r, attempts: r.attempts + 1 },
    )
  }

  async markFailed(userId: string, assetBlockId: string, expectedStagedAt?: number): Promise<void> {
    await this.mutate(userId, assetBlockId, r =>
      supersededByReArm(r, expectedStagedAt) ? r : { ...r, status: 'failed' },
    )
  }

  async delete(userId: string, assetBlockId: string): Promise<void> {
    await this.tx('readwrite', store => store.delete(uploadRecordId(userId, assetBlockId)))
  }

  async clearForUser(userId: string): Promise<void> {
    const prefix = uploadUserPrefix(userId)
    const db = await this.openDb()
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    const committed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB tx aborted'))
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB tx error'))
    })
    const store = transaction.objectStore(STORE_NAME)
    await new Promise<void>((resolve, reject) => {
      const request = store.openCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) {
          resolve()
          return
        }
        if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) cursor.delete()
        cursor.continue()
      }
      request.onerror = () => reject(request.error)
    })
    await committed
  }
}

/** Pick the production store when IndexedDB exists, else the in-memory fallback. */
export const createByteUploadStore = (): ByteUploadStore => {
  try {
    if (typeof indexedDB !== 'undefined') return new IndexedDbByteUploadStore()
  } catch {
    // fall through
  }
  return new InMemoryByteUploadStore()
}

// Process-wide singleton — the capture path, the up-lane drain, and the boot
// reconciler must share ONE store (an IndexedDB instance is shared storage, but a
// single instance also keeps the in-memory fallback coherent within a session).
// Tests inject their own store and never touch this.
let sharedStore: ByteUploadStore | null = null
export const getByteUploadStore = (): ByteUploadStore => (sharedStore ??= createByteUploadStore())
