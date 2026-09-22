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
 * The invariants both paths of the store keep:
 *   - A FAILED WRITE LEAVES NO INCOMPLETE ENTRY. `getFileHandle(name, {create: true})`
 *     mints an EMPTY file before a single byte lands, and a sync handle truncates in
 *     place — so a failure after the entry exists removes it, UNLESS its size already
 *     equals the bytes being written: the path is content-addressed, so a complete
 *     entry at it is the same bytes, written by a peer (another tab, the home-screen
 *     PWA, or this page's other resolver) — never delete a peer's complete copy.
 *   - A PEER'S OPEN HANDLE IS WAITED FOR, NOT TREATED AS A FAILURE. A sync access
 *     handle is exclusive per file; a second opener is refused (`NoModificationAllowedError`,
 *     `InvalidStateError`). The peer is writing the same bytes, in milliseconds: back
 *     off, and succeed once the file's size equals ours (its write landed), or give up
 *     after {@link LOCK_WAIT_MS} — leaving the entry alone either way.
 *   - SAME-PATH WRITES ARE SERIALIZED, on both sides: the client coalesces in-flight
 *     writes to one path (one request), and the worker chains requests per path, so
 *     this page never races itself for the lock.
 * The resolver additionally verifies every local read, so a partial file a killed
 * worker leaves behind is caught there.
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

/** How long a write waits for a peer's exclusive handle on the same file. A peer's
 *  write of the same content-addressed bytes takes milliseconds; the bound only
 *  matters for a peer that died holding the lock (the engine releases it with the
 *  context). */
export const LOCK_WAIT_MS = 5_000

export interface SyncWriteOptions {
  readonly lockWaitMs?: number
  /** Injectable for tests. */
  readonly sleep?: (ms: number) => Promise<void>
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The engine refused the handle because another context holds one on the file. */
const isLockRefusal = (err: unknown): boolean =>
  err instanceof DOMException && (err.name === 'NoModificationAllowedError' || err.name === 'InvalidStateError')

/** The entry's size, or `null` while it can't be read (a peer holds the handle). */
const sizeOf = async (handle: FileSystemFileHandle): Promise<number | null> => {
  try {
    return (await handle.getFile()).size
  } catch {
    return null
  }
}

/** The failure clean-up: drop the entry unless it is already a complete copy (see the
 *  module header). A remove refused by a peer's open handle is fine — that peer is
 *  writing the complete copy. */
export const removeUnlessComplete = async (
  dir: FileSystemDirectoryHandle,
  name: string,
  handle: FileSystemFileHandle,
  expectedSize: number,
): Promise<void> => {
  if ((await sizeOf(handle)) === expectedSize) return
  await dir.removeEntry(name).catch(() => {})
}

/**
 * Write `bytes` to `path` under `root` (directories created), through a sync
 * access handle. Resolves once the bytes are flushed and the handle closed — or
 * once a peer holding the file has written the same bytes (size match).
 */
export const writeFileViaSyncHandle = async (
  root: FileSystemDirectoryHandle,
  path: readonly string[],
  bytes: Uint8Array,
  opts: SyncWriteOptions = {},
): Promise<void> => {
  if (path.length === 0) throw new Error('byte-store write: empty path')
  const sleep = opts.sleep ?? defaultSleep
  const lockWaitMs = opts.lockWaitMs ?? LOCK_WAIT_MS
  let dir = root
  for (const name of path.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create: true })
  const name = path[path.length - 1]
  const handle = await dir.getFileHandle(name, { create: true })

  const deadline = Date.now() + lockWaitMs
  let delay = 10
  let peerSeen = false
  for (;;) {
    // After a refusal, a peer's finished write of these same bytes is ours too — take
    // it rather than re-opening the file and writing the identical bytes again.
    if (peerSeen && (await sizeOf(handle)) === bytes.byteLength) return
    let access: SyncAccessHandle
    try {
      access = await (handle as unknown as SyncCapableFileHandle).createSyncAccessHandle()
    } catch (err) {
      if (!isLockRefusal(err)) {
        await removeUnlessComplete(dir, name, handle, bytes.byteLength)
        throw err
      }
      // A peer holds the file — it is writing these same bytes. Wait, and never touch
      // its entry.
      peerSeen = true
      if (Date.now() >= deadline) throw err
      await sleep(delay)
      delay = Math.min(delay * 2, 500)
      continue
    }
    try {
      access.truncate(0)
      let at = 0
      while (at < bytes.byteLength) {
        const written = access.write(bytes.subarray(at), { at })
        if (written <= 0) throw new Error('byte-store write: sync access handle wrote 0 bytes')
        at += written
      }
      access.flush()
    } catch (err) {
      access.close()
      await removeUnlessComplete(dir, name, handle, bytes.byteLength)
      throw err
    }
    access.close()
    return
  }
}

/** Per-path chain, so two requests for one file never race each other for its lock. */
const inFlightByPath = new Map<string, Promise<void>>()

/** The worker's per-message handler: never throws, always answers `id`. The root is
 *  opened per request (a request arrives seconds or hours apart, the handle is cheap). */
export const handleWriteRequest = async (
  getRoot: () => Promise<FileSystemDirectoryHandle>,
  request: WriteRequest,
  opts: SyncWriteOptions = {},
): Promise<WriteReply> => {
  const key = request.path.join('/')
  const previous = inFlightByPath.get(key) ?? Promise.resolve()
  const run = previous
    .catch(() => {})
    .then(async () => writeFileViaSyncHandle(await getRoot(), request.path, new Uint8Array(request.bytes), opts))
  inFlightByPath.set(key, run)
  try {
    await run
    return { id: request.id, ok: true }
  } catch (err) {
    return { id: request.id, ok: false, error: errorMessage(err) }
  } finally {
    if (inFlightByPath.get(key) === run) inFlightByPath.delete(key)
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
   *  the bytes flushed. Rejects when the worker can't. A write to a path one is
   *  already in flight for shares that write (same path = same bytes). */
  write(path: readonly string[], bytes: Uint8Array): Promise<void>
}

export interface WorkerFileWriterOptions {
  /** A write the worker never answers is a hung `put`, which would hold the
   *  resolver's demand render — bound it. */
  readonly timeoutMs?: number
  /** Called for each write abandoned by a timeout: the killed worker may have left
   *  a partial file, and only the store can reach it (the worker is gone). */
  readonly onAbandoned?: (path: readonly string[], byteLength: number) => Promise<void>
}

const WRITE_TIMEOUT_MS = 60_000

/**
 * The main-thread client: one worker per store, spawned on the first write and
 * kept for the page's lifetime. A worker that errors or times out is dropped
 * (its pending writes rejected) and the next write spawns a fresh one.
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
  const inFlightByPath = new Map<string, Promise<void>>()

  const settle = (id: number, err: Error | null): void => {
    const waiter = pending.get(id)
    if (!waiter) return
    pending.delete(id)
    clearTimeout(waiter.timer)
    if (err) waiter.reject(err)
    else waiter.resolve()
  }

  /** Drop the worker and fail every pending write. `abandoned` = the worker may have
   *  been mid-write (a timeout kill), so each pending path gets the partial clean-up. */
  const dropWorker = (reason: string, abandoned: boolean): void => {
    const failed = [...pending.values()]
    const ids = [...pending.keys()]
    worker?.terminate()
    worker = null
    const cleanup = abandoned && options.onAbandoned
      ? Promise.all(failed.map((p) => options.onAbandoned!(p.path, p.byteLength).catch(() => {})))
      : Promise.resolve()
    void cleanup.then(() => {
      for (const id of ids) settle(id, new Error(reason))
    })
  }

  const ensureWorker = (): WriterWorkerLike => {
    if (worker) return worker
    const spawned = spawn()
    spawned.onmessage = (event) => {
      const reply = event.data
      settle(reply.id, reply.ok ? null : new Error(reply.error))
    }
    spawned.onerror = (event) => dropWorker(`byte-store writer worker failed: ${event.message ?? 'unknown error'}`, true)
    worker = spawned
    return spawned
  }

  const post = (path: readonly string[], bytes: Uint8Array): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const id = nextId++
      // A private copy: the buffer is transferred (detached) and the caller keeps
      // using its own array (the resolver serves the same bytes it just stored).
      const copy = bytes.slice().buffer as ArrayBuffer
      const timer = setTimeout(() => {
        if (!pending.has(id)) return
        dropWorker(`byte-store write timed out after ${timeoutMs}ms`, true)
      }, timeoutMs)
      pending.set(id, { path, byteLength: bytes.byteLength, resolve, reject, timer })
      try {
        ensureWorker().postMessage({ id, path, bytes: copy }, [copy])
      } catch (err) {
        settle(id, err instanceof Error ? err : new Error(String(err)))
      }
    })

  return {
    write: (path, bytes) => {
      const key = path.join('/')
      const existing = inFlightByPath.get(key)
      if (existing) return existing
      const run = post(path, bytes).finally(() => {
        if (inFlightByPath.get(key) === run) inFlightByPath.delete(key)
      })
      inFlightByPath.set(key, run)
      return run
    },
  }
}
