/*
 * The byte store's WORKER write path: an OPFS file write through a sync access
 * handle, for engines whose `FileSystemFileHandle` has no `createWritable`
 * (byteStore.ts: `engineHasWritableStream`). The main thread posts the file's
 * PATH and the bytes — a handle can't be cloned to a worker on those engines —
 * and the worker walks the path and writes.
 *
 * The caller (`OpfsByteStore.put`) holds the object's Web Lock for the whole
 * request, so nothing here coordinates with other writers.
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
  /** `name` is the DOMException name, when the failure was one: callers tell a
   *  full disk (`QuotaExceededError`) from other failures by it. */
  | { readonly id: number; readonly ok: false; readonly error: string; readonly name?: string }

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
const isNotFound = (err: unknown): boolean => err instanceof DOMException && err.name === 'NotFoundError'

/**
 * Write `bytes` to `path` under `root` (directories created) through a sync access
 * handle; resolves once they are flushed and the handle closed.
 *
 * The handle writes IN PLACE, and the entry may already be a complete copy that
 * exists nowhere else (a capture not yet uploaded). So the bytes go in from
 * offset 0 and the file is cut to length LAST: the path is content-addressed, so
 * over a good copy every byte written is the byte already there, and a write cut
 * short leaves it good. A failed write removes only an entry it created.
 */
export const writeFileViaSyncHandle = async (
  root: FileSystemDirectoryHandle,
  path: readonly string[],
  bytes: Uint8Array,
): Promise<void> => {
  let dir = root
  for (const name of path.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create: true })
  const name = path[path.length - 1]
  let created = false
  const handle = await dir.getFileHandle(name).catch((err: unknown) => {
    if (!isNotFound(err)) throw err
    created = true
    return dir.getFileHandle(name, { create: true })
  })
  try {
    const access = await (handle as unknown as SyncCapableFileHandle).createSyncAccessHandle()
    try {
      let at = 0
      while (at < bytes.byteLength) {
        const written = access.write(bytes.subarray(at), { at })
        if (written <= 0) throw new Error('byte-store write: sync access handle wrote 0 bytes')
        at += written
      }
      access.truncate(bytes.byteLength)
      access.flush()
    } finally {
      access.close()
    }
  } catch (err) {
    if (created) await dir.removeEntry(name).catch(() => {})
    throw err
  }
}

/** The worker's per-message handler: never throws, always answers `id`. */
export const handleWriteRequest = async (
  getRoot: () => Promise<FileSystemDirectoryHandle>,
  request: WriteRequest,
): Promise<WriteReply> => {
  try {
    await writeFileViaSyncHandle(await getRoot(), request.path, new Uint8Array(request.bytes))
    return { id: request.id, ok: true }
  } catch (err) {
    return { id: request.id, ok: false, error: errorMessage(err), name: err instanceof DOMException ? err.name : undefined }
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
   *  the bytes flushed, rejects when it can't. */
  write(path: readonly string[], bytes: Uint8Array): Promise<void>
}

/** A write the worker never answers would hold the object's lock, and the
 *  resolver's demand render with it. Dropping the worker can leave a partial
 *  file where the write created the entry: readers hash, so it is never served. */
const WRITE_TIMEOUT_MS = 60_000

/**
 * The main-thread client: one worker, spawned on the first write and kept for
 * the page's lifetime. A worker that errors or times out is dropped, its pending
 * writes rejected, and the next write spawns a fresh one.
 */
export const createWorkerFileWriter = (
  spawn: () => WriterWorkerLike,
  timeoutMs: number = WRITE_TIMEOUT_MS,
): WorkerFileWriter => {
  let worker: WriterWorkerLike | null = null
  let nextId = 1
  interface Pending {
    readonly resolve: () => void
    readonly reject: (err: Error) => void
    readonly timer: ReturnType<typeof setTimeout>
  }
  const pending = new Map<number, Pending>()

  const settle = (id: number, err: Error | null): void => {
    const waiter = pending.get(id)
    if (!waiter) return
    pending.delete(id)
    clearTimeout(waiter.timer)
    if (err) waiter.reject(err)
    else waiter.resolve()
  }

  const dropWorker = (reason: string): void => {
    worker?.terminate()
    worker = null
    for (const id of [...pending.keys()]) settle(id, new Error(reason))
  }

  const ensureWorker = (): WriterWorkerLike => {
    if (worker) return worker
    const spawned = spawn()
    spawned.onmessage = (event) => {
      const reply = event.data
      settle(reply.id, reply.ok ? null : reply.name ? new DOMException(reply.error, reply.name) : new Error(reply.error))
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
          if (pending.has(id)) dropWorker(`byte-store write timed out after ${timeoutMs}ms`)
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
