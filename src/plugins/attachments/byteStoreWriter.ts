/*
 * The byte store's WORKER write path — an OPFS file write through a sync access
 * handle, for engines whose `FileSystemFileHandle` has no `createWritable`.
 *
 * WebKit before Safari 26 (every iOS 18 browser — all of them are WKWebView) ships
 * OPFS with `createSyncAccessHandle` only, and only inside a Worker; the main
 * thread can create files but cannot write them. So the main thread posts the
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
 * The caller (`OpfsByteStore.put`) holds the object's Web Lock for the whole
 * request, so nothing here coordinates with other writers. What this path does
 * own: a sync handle truncates IN PLACE, so a write that fails or is abandoned
 * leaves a partial file where the stream path would have left the old one —
 * {@link removeUnlessComplete} drops it.
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

/** Drop the entry at `path` unless its size is `expectedSize`. The path is
 *  content-addressed, so an entry of the right size is kept as a complete copy (a
 *  reader hashes it anyway); anything else is what a cut-short write left. Never
 *  creates anything, and an entry that is absent or can't be removed is left as is. */
export const removeUnlessComplete = async (
  root: FileSystemDirectoryHandle,
  path: readonly string[],
  expectedSize: number,
): Promise<void> => {
  try {
    let dir = root
    for (const name of path.slice(0, -1)) dir = await dir.getDirectoryHandle(name)
    const name = path[path.length - 1]
    const size = (await (await dir.getFileHandle(name)).getFile()).size
    if (size !== expectedSize) await dir.removeEntry(name)
  } catch {
    // absent, or held open by a writer outside the lock
  }
}

/** Write `bytes` to `path` under `root` (directories created) through a sync access
 *  handle. Resolves once the bytes are flushed and the handle closed. */
export const writeFileViaSyncHandle = async (
  root: FileSystemDirectoryHandle,
  path: readonly string[],
  bytes: Uint8Array,
): Promise<void> => {
  if (path.length === 0) throw new Error('byte-store write: empty path')
  let dir = root
  for (const name of path.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create: true })
  const handle = await dir.getFileHandle(path[path.length - 1], { create: true })
  try {
    const access = await (handle as unknown as SyncCapableFileHandle).createSyncAccessHandle()
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
    await removeUnlessComplete(root, path, bytes.byteLength)
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
   *  the bytes flushed, rejects when it can't. */
  write(path: readonly string[], bytes: Uint8Array): Promise<void>
}

export interface WorkerFileWriterOptions {
  /** A write the worker never answers would hold the object's lock and the
   *  resolver's demand render with it — bound it. */
  readonly timeoutMs?: number
  /** Called for each write a dropped worker had pending: it may have been killed
   *  mid-write, and only the main thread can still reach the file. */
  readonly onAbandoned?: (path: readonly string[], byteLength: number) => Promise<void>
}

const WRITE_TIMEOUT_MS = 60_000

/**
 * The main-thread client: one worker per store, spawned on the first write and
 * kept for the page's lifetime. A worker that errors or times out is dropped
 * (its pending writes cleaned up, then rejected) and the next write spawns a
 * fresh one.
 */
export const createWorkerFileWriter = (
  spawn: () => WriterWorkerLike,
  options: WorkerFileWriterOptions = {},
): WorkerFileWriter => {
  const timeoutMs = options.timeoutMs ?? WRITE_TIMEOUT_MS
  let worker: WriterWorkerLike | null = null
  let nextId = 1
  interface Pending {
    readonly path: readonly string[]
    readonly byteLength: number
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
    const abandoned = [...pending]
    worker?.terminate()
    worker = null
    const { onAbandoned } = options
    const cleanup = onAbandoned
      ? Promise.all(abandoned.map(([, p]) => onAbandoned(p.path, p.byteLength).catch(() => {})))
      : Promise.resolve()
    void cleanup.then(() => {
      for (const [id] of abandoned) settle(id, new Error(reason))
    })
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
          if (pending.has(id)) dropWorker(`byte-store write timed out after ${timeoutMs}ms`)
        }, timeoutMs)
        pending.set(id, { path, byteLength: bytes.byteLength, resolve, reject, timer })
        try {
          ensureWorker().postMessage({ id, path, bytes: copy }, [copy])
        } catch (err) {
          settle(id, err instanceof Error ? err : new Error(String(err)))
        }
      }),
  }
}
