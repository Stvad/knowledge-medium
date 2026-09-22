/*
 * The byte store's WORKER write path — an OPFS file write through a sync access
 * handle, for engines whose `FileSystemFileHandle` has no `createWritable`.
 *
 * WebKit before Safari 26 (every iOS 18 browser — all of them are WKWebView) ships
 * OPFS with `createSyncAccessHandle` only, and only inside a Worker; the main
 * thread can create files but cannot write them. The store's stream path
 * (`createWritable`) therefore has this sibling: the main thread posts the
 * file's PATH + the bytes (a handle can't be structured-cloned to a worker on
 * that engine), and the worker re-walks the path and writes.
 *
 * Two halves, one module so they can't drift on the protocol:
 *   - worker side — {@link handleWriteRequest} / {@link writeFileViaSyncHandle},
 *     pure over an injected root (the `.worker.ts` entry binds the real one; the
 *     tests bind a fake tree);
 *   - main side — {@link createWorkerFileWriter}, the request/reply client over
 *     one lazily-spawned worker.
 *
 * The invariant both paths of the store keep: A FAILED WRITE LEAVES NO ENTRY.
 * `getFileHandle(name, {create: true})` mints an EMPTY file before a single byte
 * lands, and a sync handle truncates in place — so any failure after the entry
 * exists removes it (a pre-existing entry at the key held the same
 * content-addressed bytes; losing that cache copy costs a re-fetch, never data).
 * The resolver additionally verifies every local read, so a partial file a
 * killed worker leaves behind is caught there.
 */

export interface WriteRequest {
  readonly id: number
  /** Already-encoded path segments from the OPFS root (`assets/<user>/<ws>/<key>`). */
  readonly path: readonly string[]
  /** The bytes to write — TRANSFERRED to the worker, so always a private copy. */
  readonly bytes: ArrayBuffer
}

export type WriteReply =
  | { readonly id: number; readonly ok: true }
  | { readonly id: number; readonly ok: false; readonly error: string }

/** The slice of `FileSystemSyncAccessHandle` the write uses — a standalone shape
 *  (not an extension of `FileSystemFileHandle`) because the DOM lib differs between
 *  the tsconfigs this file compiles under; same reason as writeAheadVfsProbe.worker.ts. */
interface SyncAccessHandle {
  write(buffer: Uint8Array, options?: { at?: number }): number
  truncate(size: number): void
  flush(): void
  close(): void
}

interface SyncCapableFileHandle {
  createSyncAccessHandle(): Promise<SyncAccessHandle>
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Write `bytes` to `path` under `root` (directories created), through a sync
 * access handle. Resolves once the bytes are flushed and the handle closed.
 * On ANY failure after the entry exists, the entry is removed before rethrowing.
 */
export const writeFileViaSyncHandle = async (
  root: FileSystemDirectoryHandle,
  path: readonly string[],
  bytes: Uint8Array,
): Promise<void> => {
  if (path.length === 0) throw new Error('byte-store write: empty path')
  let dir = root
  for (const name of path.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create: true })
  const name = path[path.length - 1]
  const handle = (await dir.getFileHandle(name, { create: true })) as unknown as SyncCapableFileHandle
  try {
    const access = await handle.createSyncAccessHandle()
    try {
      access.truncate(0)
      let at = 0
      while (at < bytes.byteLength) {
        const written = access.write(bytes.subarray(at), { at })
        if (written <= 0) throw new Error('byte-store write: sync access handle wrote 0 bytes')
        at += written
      }
      access.flush()
    } finally {
      access.close()
    }
  } catch (err) {
    await dir.removeEntry(name).catch(() => {}) // the entry may be gone already — the invariant holds either way
    throw err
  }
}

/** The worker's per-message handler: never throws, always answers `id`. */
export const handleWriteRequest = async (
  root: FileSystemDirectoryHandle,
  request: WriteRequest,
): Promise<WriteReply> => {
  try {
    await writeFileViaSyncHandle(root, request.path, new Uint8Array(request.bytes))
    return { id: request.id, ok: true }
  } catch (err) {
    return { id: request.id, ok: false, error: errorMessage(err) }
  }
}

/** The slice of `Worker` the client touches — so a test can hand in a fake that
 *  runs {@link handleWriteRequest} against its own tree. */
export interface WriterWorkerLike {
  onmessage: ((event: MessageEvent<WriteReply>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  postMessage(message: WriteRequest, transfer: Transferable[]): void
  terminate(): void
}

export interface WorkerFileWriter {
  /** Write a PRIVATE COPY of `bytes` to `path`; resolves once the worker reports
   *  the bytes flushed. Rejects (and leaves no entry) when the worker can't. */
  write(path: readonly string[], bytes: Uint8Array): Promise<void>
}

/** A write the worker never answers is a hung `put`, which would hold the
 *  resolver's demand render — bound it; a killed worker's partial file is caught
 *  by the read-side verification. */
export const WRITE_TIMEOUT_MS = 60_000

/**
 * The main-thread client: one worker per store, spawned on the first write and
 * kept for the page's lifetime. A worker that errors or times out is dropped
 * (its pending writes rejected) and the next write spawns a fresh one.
 */
export const createWorkerFileWriter = (
  spawn: () => WriterWorkerLike,
  timeoutMs: number = WRITE_TIMEOUT_MS,
): WorkerFileWriter => {
  let worker: WriterWorkerLike | null = null
  let nextId = 1
  const pending = new Map<number, { resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  const settle = (id: number, err: Error | null): void => {
    const waiter = pending.get(id)
    if (!waiter) return
    pending.delete(id)
    clearTimeout(waiter.timer)
    if (err) waiter.reject(err)
    else waiter.resolve()
  }

  const dropWorker = (reason: string): void => {
    const failed = [...pending.keys()]
    worker?.terminate()
    worker = null
    for (const id of failed) settle(id, new Error(reason))
  }

  const ensureWorker = (): WriterWorkerLike => {
    if (worker) return worker
    const spawned = spawn()
    spawned.onmessage = (event) => {
      const reply = event.data
      settle(reply.id, reply.ok ? null : new Error(reply.error))
    }
    spawned.onerror = (event) => dropWorker(`byte-store writer worker failed: ${event.message ?? 'unknown error'}`)
    worker = spawned
    return spawned
  }

  return {
    write: (path, bytes) =>
      new Promise<void>((resolve, reject) => {
        const id = nextId++
        // A private copy: the buffer is transferred (detached) and the caller keeps
        // using its own array (the resolver serves the same bytes it just stored).
        const copy = bytes.slice().buffer as ArrayBuffer
        const timer = setTimeout(() => {
          if (!pending.has(id)) return
          dropWorker(`byte-store write timed out after ${timeoutMs}ms`)
        }, timeoutMs)
        pending.set(id, { resolve, reject, timer })
        try {
          ensureWorker().postMessage({ id, path, bytes: copy }, [copy])
        } catch (err) {
          settle(id, err instanceof Error ? err : new Error(String(err)))
        }
      }),
  }
}
