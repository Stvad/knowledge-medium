import { describe, expect, it } from 'vitest'
import { ASSETS_ROOT, InMemoryByteStore, OpfsByteStore, assetPathSegments, type ByteStore } from './byteStore.js'
import { createWorkerFileWriter, handleWriteRequest, type WriteRequest, type WriterWorkerLike } from './byteStoreWriter.js'

const U = 'user-1'
const WS = 'ws-A'
const KEY = 'deadbeef'
const bytes = (...vals: number[]) => new Uint8Array(vals)

// ── A minimal in-memory OPFS tree, just enough to back OpfsByteStore ──────────
//
// Two engine SHAPES, decided per tree: `stream` (Chromium / Firefox / Safari 26 —
// `createWritable` on the handle) and `sync-only` (WebKit before Safari 26 — no
// `createWritable` anywhere; `createSyncAccessHandle` in a worker). The real
// `getFileHandle(name, {create: true})` mints an EMPTY entry before any write —
// the fake does too, since that is the behaviour the store's invariants are about.
type Shape = 'stream' | 'sync-only'

interface Faults {
  /** Thrown from the first write of either path (a quota / IO failure mid-put). */
  failWrite: Error | null
}

class FakeFileHandle {
  kind = 'file' as const
  data = new Uint8Array(0)
  lastModified = Date.now()
  createWritable?: () => Promise<{ write(c: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>

  constructor(
    readonly name: string,
    private readonly faults: Faults,
    shape: Shape,
  ) {
    if (shape === 'stream') this.createWritable = () => this.streamWritable()
  }

  async getFile() {
    // A fresh copy each read, like a real File over OPFS.
    return { size: this.data.byteLength, lastModified: this.lastModified, arrayBuffer: async () => this.data.slice().buffer }
  }

  private async streamWritable() {
    const chunks: Uint8Array[] = []
    let aborted = false
    return {
      write: async (chunk: Uint8Array) => {
        if (this.faults.failWrite) throw this.faults.failWrite
        chunks.push(new Uint8Array(chunk))
      },
      abort: async () => {
        aborted = true
      },
      // Only close commits (swap-file semantics) — an aborted stream leaves the entry as it was.
      close: async () => {
        if (aborted) return
        this.data = concat(chunks)
        this.lastModified = Date.now()
      },
    }
  }

  /** The worker-side primitive (every engine has it in a worker; the fake worker runs in-thread). */
  async createSyncAccessHandle() {
    let closed = false
    return {
      truncate: (size: number) => {
        this.data = this.data.slice(0, size)
      },
      write: (chunk: Uint8Array, opts?: { at?: number }) => {
        if (closed) throw new DOMException('closed', 'InvalidStateError')
        if (this.faults.failWrite) throw this.faults.failWrite
        const at = opts?.at ?? 0
        const out = new Uint8Array(Math.max(this.data.byteLength, at + chunk.byteLength))
        out.set(this.data)
        out.set(chunk, at)
        this.data = out
        return chunk.byteLength
      },
      flush: () => {
        this.lastModified = Date.now()
      },
      close: () => {
        closed = true
      },
    }
  }
}

const concat = (chunks: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

class FakeDirHandle {
  kind = 'directory' as const
  readonly dirs = new Map<string, FakeDirHandle>()
  readonly files = new Map<string, FakeFileHandle>()

  constructor(
    readonly shape: Shape,
    readonly faults: Faults,
  ) {}

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDirHandle> {
    let d = this.dirs.get(name)
    if (!d) {
      if (!opts?.create) throw new DOMException(`no dir ${name}`, 'NotFoundError')
      d = new FakeDirHandle(this.shape, this.faults)
      this.dirs.set(name, d)
    }
    return d
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFileHandle> {
    let f = this.files.get(name)
    if (!f) {
      if (!opts?.create) throw new DOMException(`no file ${name}`, 'NotFoundError')
      f = new FakeFileHandle(name, this.faults, this.shape)
      this.files.set(name, f)
    }
    return f
  }

  async removeEntry(name: string): Promise<void> {
    // The store passes { recursive: true }; JS drops the extra arg. The fake
    // tree has no deep nesting under a workspace dir, so plain delete suffices.
    if (this.dirs.delete(name) || this.files.delete(name)) return
    throw new DOMException(`no entry ${name}`, 'NotFoundError')
  }

  // The FileSystemDirectoryHandle async-iterable surface listWorkspaceKeys walks.
  async *keys(): AsyncGenerator<string> {
    for (const name of this.files.keys()) yield name
    for (const name of this.dirs.keys()) yield name
  }
}

/** The writer worker, in-thread: runs the real worker handler against the fake tree
 *  and answers through `onmessage` like a Worker would. `crashOnPost` models a worker
 *  that dies (the `error` event) instead of answering. */
class FakeWriterWorker implements WriterWorkerLike {
  onmessage: WriterWorkerLike['onmessage'] = null
  onerror: WriterWorkerLike['onerror'] = null
  terminated = false
  readonly requests: WriteRequest[] = []

  constructor(
    private readonly root: FakeDirHandle,
    private readonly crashOnPost = false,
  ) {}

  postMessage(message: WriteRequest, transfer: Transferable[]): void {
    this.requests.push(message)
    expect(transfer).toEqual([message.bytes]) // the copy is TRANSFERRED, never shared
    if (this.crashOnPost) {
      queueMicrotask(() => this.onerror?.({ message: 'boom' } as ErrorEvent))
      return
    }
    void handleWriteRequest(this.root as unknown as FileSystemDirectoryHandle, message).then((reply) => {
      if (!this.terminated) this.onmessage?.(new MessageEvent('message', { data: reply }))
    })
  }

  terminate(): void {
    this.terminated = true
  }
}

const opfsWithRoot = (shape: Shape = 'stream') => {
  const faults: Faults = { failWrite: null }
  const root = new FakeDirHandle(shape, faults)
  const workers: FakeWriterWorker[] = []
  const store = new OpfsByteStore({
    getRoot: async () => root as unknown as FileSystemDirectoryHandle,
    hasWritableStream: () => shape === 'stream',
    spawnWriterWorker: () => {
      const w = new FakeWriterWorker(root)
      workers.push(w)
      return w
    },
  })
  return { store, root, faults, workers }
}

const wsDir = (root: FakeDirHandle, user = U, ws = WS) => root.dirs.get(ASSETS_ROOT)?.dirs.get(user)?.dirs.get(ws)

// ── The behavioral contract every implementation must satisfy ─────────────────
describe.each<[string, () => ByteStore]>([
  ['InMemoryByteStore', () => new InMemoryByteStore()],
  ['OpfsByteStore (createWritable engine)', () => opfsWithRoot('stream').store],
  ['OpfsByteStore (sync-access-handle-only engine — WebKit before Safari 26)', () => opfsWithRoot('sync-only').store],
])('ByteStore contract — %s', (_name, make) => {
  it('returns null on a miss', async () => {
    expect(await make().get(U, WS, KEY)).toBeNull()
    expect(await make().has(U, WS, KEY)).toBe(false)
  })

  it('round-trips bytes by (user, workspace, key)', async () => {
    const store = make()
    await store.put(U, WS, KEY, bytes(1, 2, 3))
    expect(await store.get(U, WS, KEY)).toEqual(bytes(1, 2, 3))
    expect(await store.has(U, WS, KEY)).toBe(true)
  })

  it('a re-put of the same key replaces the bytes (no stale tail from the previous length)', async () => {
    const store = make()
    await store.put(U, WS, KEY, bytes(1, 2, 3, 4, 5))
    await store.put(U, WS, KEY, bytes(9))
    expect(await store.get(U, WS, KEY)).toEqual(bytes(9))
  })

  it('isolates by user, workspace, and key', async () => {
    const store = make()
    await store.put(U, WS, KEY, bytes(1))
    expect(await store.get('other-user', WS, KEY)).toBeNull()
    expect(await store.get(U, 'other-ws', KEY)).toBeNull()
    expect(await store.get(U, WS, 'other-key')).toBeNull()
  })

  it('does not alias the stored buffer (a later mutation of the source is not reflected)', async () => {
    const store = make()
    const src = bytes(9, 9, 9)
    await store.put(U, WS, KEY, src)
    src[0] = 0 // mutate the caller's buffer after the put
    expect(await store.get(U, WS, KEY)).toEqual(bytes(9, 9, 9))
  })

  it('put leaves the caller’s buffer usable (the resolver serves the bytes it just stored)', async () => {
    const store = make()
    const src = bytes(4, 5, 6)
    await store.put(U, WS, KEY, src)
    expect(src.byteLength).toBe(3) // not detached by a transfer
    expect([...src]).toEqual([4, 5, 6])
  })

  it('purgeWorkspace drops only that workspace, leaving the user’s other workspaces', async () => {
    const store = make()
    await store.put(U, WS, KEY, bytes(1))
    await store.put(U, 'ws-B', KEY, bytes(2))
    await store.put('other-user', WS, KEY, bytes(3))

    await store.purgeWorkspace(U, WS)

    expect(await store.get(U, WS, KEY)).toBeNull() // purged
    expect(await store.get(U, 'ws-B', KEY)).toEqual(bytes(2)) // sibling ws survives
    expect(await store.get('other-user', WS, KEY)).toEqual(bytes(3)) // other account survives
  })

  it('purgeWorkspace is a no-op when nothing is stored', async () => {
    await expect(make().purgeWorkspace(U, WS)).resolves.toBeUndefined()
  })

  it('delete drops a single object, leaving siblings; no-op when absent', async () => {
    const store = make()
    await store.put(U, WS, KEY, bytes(1))
    await store.put(U, WS, 'other-key', bytes(2))

    await store.delete(U, WS, KEY)
    expect(await store.get(U, WS, KEY)).toBeNull() // deleted
    expect(await store.get(U, WS, 'other-key')).toEqual(bytes(2)) // sibling survives

    await expect(store.delete(U, WS, 'never-stored')).resolves.toBeUndefined() // no-op
  })

  it('listWorkspaceKeys returns the stored content-keys for one (user, workspace), scoped', async () => {
    const store = make()
    await store.put(U, WS, 'aaaa', bytes(1))
    await store.put(U, WS, 'bbbb', bytes(2))
    await store.put(U, 'ws-B', 'cccc', bytes(3)) // a sibling workspace
    await store.put('other-user', WS, 'dddd', bytes(4)) // another account

    expect(await store.listWorkspaceKeys(U, WS)).toEqual(new Set(['aaaa', 'bbbb']))
    expect(await store.listWorkspaceKeys(U, 'empty-ws')).toEqual(new Set()) // nothing stored
  })

  it('listWorkspaceKeys decodes filenames back to keys (round-trips a reserved char)', async () => {
    const store = make()
    await store.put(U, WS, 'a/b', bytes(1)) // '/' is escaped on disk, must decode back
    expect(await store.listWorkspaceKeys(U, WS)).toEqual(new Set(['a/b']))
  })

  it('sweepEmpty is a no-op on a workspace with nothing stored, and keeps non-empty entries', async () => {
    const store = make()
    expect(await store.sweepEmpty(U, WS, { minAgeMs: 0 })).toEqual({ scanned: 0, removed: 0 })
    await store.put(U, WS, KEY, bytes(1))
    expect(await store.sweepEmpty(U, WS, { minAgeMs: 0 })).toEqual({ scanned: 1, removed: 0 })
    expect(await store.get(U, WS, KEY)).toEqual(bytes(1))
  })
})

describe('assetPathSegments', () => {
  it('builds assets/<user>/<ws>/<key>, each segment URI-escaped', () => {
    expect(assetPathSegments(U, WS, KEY)).toEqual([ASSETS_ROOT, U, WS, KEY])
    // A '/' in an id is escaped so it cannot escape the tree or alias ids.
    expect(assetPathSegments('a/b', 'c/d', 'e')).toEqual([ASSETS_ROOT, 'a%2Fb', 'c%2Fd', 'e'])
  })

  it('remaps the OPFS-illegal . / .. / empty segments (a LOCAL account id is the typed username)', () => {
    // encodeURIComponent leaves these three unchanged and getDirectoryHandle rejects
    // them, so byteStore put/get would throw for a user named '.'/'..'/''. Each is
    // remapped to a distinct sentinel, and NONE of the produced segments is illegal.
    expect(assetPathSegments('.', WS, KEY)).toEqual([ASSETS_ROOT, '%2Edot', WS, KEY])
    expect(assetPathSegments('..', WS, KEY)).toEqual([ASSETS_ROOT, '%2Edotdot', WS, KEY])
    expect(assetPathSegments('', WS, KEY)).toEqual([ASSETS_ROOT, '%2Eempty', WS, KEY])
    for (const seg of assetPathSegments('..', '.', '')) expect(['', '.', '..']).not.toContain(seg)
  })

  it('leaves every NORMAL id byte-identical to encodeURIComponent (no migration of existing paths)', () => {
    // The remap fires ONLY for '.'/'..'/'' — every other id (incl. ones with reserved
    // chars) encodes exactly as before, so existing on-disk objects stay reachable.
    for (const id of ['u-1', 'deadbeef', 'a/b', 'c d', 'née.png', '..ok', 'x.']) {
      expect(assetPathSegments(id, id, id)).toEqual([
        ASSETS_ROOT, encodeURIComponent(id), encodeURIComponent(id), encodeURIComponent(id),
      ])
    }
  })
})

describe('OpfsByteStore — on-disk layout', () => {
  it('writes to assets/<enc user>/<enc ws>/<enc key> (escaped, no tree escape)', async () => {
    const { store, root } = opfsWithRoot()
    await store.put('u/x', 'w/y', 'k/z', bytes(7))

    const assets = root.dirs.get(ASSETS_ROOT)!
    const userDir = assets.dirs.get('u%2Fx')!
    const wsDir = userDir.dirs.get('w%2Fy')!
    expect(wsDir.files.has('k%2Fz')).toBe(true)
    // The escaped id is a SINGLE directory name — it did not create nested dirs.
    expect(userDir.dirs.size).toBe(1)
  })

  it('a read miss does not create the directory tree (no empty dirs from get/has)', async () => {
    const { store, root } = opfsWithRoot()
    expect(await store.get(U, WS, KEY)).toBeNull()
    expect(await store.has(U, WS, KEY)).toBe(false)
    expect(root.dirs.size).toBe(0) // nothing was created
  })

  it('purgeWorkspace removes the workspace subtree from disk', async () => {
    const { store, root } = opfsWithRoot()
    await store.put(U, WS, KEY, bytes(1))
    await store.purgeWorkspace(U, WS)
    const userDir = root.dirs.get(ASSETS_ROOT)!.dirs.get(U)!
    expect(userDir.dirs.has(WS)).toBe(false)
  })
})

describe('OpfsByteStore — the write path on an engine WITHOUT createWritable (WebKit before Safari 26)', () => {
  it('writes through the worker (path + transferred copy) and the bytes land; the worker is reused', async () => {
    const { store, root, workers } = opfsWithRoot('sync-only')
    await store.put(U, WS, KEY, bytes(1, 2, 3))
    await store.put(U, WS, 'other', bytes(4))

    expect(wsDir(root)!.files.get(KEY)!.data).toEqual(bytes(1, 2, 3))
    expect(await store.get(U, WS, 'other')).toEqual(bytes(4))
    expect(workers).toHaveLength(1) // one worker per store, spawned on the first write
    expect(workers[0].requests.map((r) => r.path)).toEqual([
      [ASSETS_ROOT, U, WS, KEY],
      [ASSETS_ROOT, U, WS, 'other'],
    ])
  })

  it('never touches createWritable (the handle has none) — the write path is decided by the engine, not by trying', async () => {
    const { store, root } = opfsWithRoot('sync-only')
    await store.put(U, WS, KEY, bytes(1))
    expect(wsDir(root)!.files.get(KEY)!.createWritable).toBeUndefined()
  })

  it('a write failure in the worker rejects the put AND leaves no entry (the entry was minted before the bytes)', async () => {
    const { store, root, faults } = opfsWithRoot('sync-only')
    faults.failWrite = new DOMException('quota', 'QuotaExceededError')
    await expect(store.put(U, WS, KEY, bytes(1, 2, 3))).rejects.toThrow('quota')

    expect(wsDir(root)!.files.has(KEY)).toBe(false) // no zero-byte file left behind
    expect(await store.has(U, WS, KEY)).toBe(false)
    expect(await store.get(U, WS, KEY)).toBeNull()
  })

  it('a worker that dies rejects the pending put and the next put spawns a fresh worker', async () => {
    const faults: Faults = { failWrite: null }
    const root = new FakeDirHandle('sync-only', faults)
    let crashNext = true
    const workers: FakeWriterWorker[] = []
    const store = new OpfsByteStore({
      getRoot: async () => root as unknown as FileSystemDirectoryHandle,
      hasWritableStream: () => false,
      spawnWriterWorker: () => {
        const w = new FakeWriterWorker(root, crashNext)
        crashNext = false
        workers.push(w)
        return w
      },
    })
    // put() retries once on failure (a stale ws-dir handle) — the crashed worker is
    // dropped on the first attempt, so the retry already lands on the fresh worker.
    await expect(store.put(U, WS, KEY, bytes(1))).resolves.toBeUndefined()
    expect(workers).toHaveLength(2)
    expect(workers[0].terminated).toBe(true)
    expect(await store.get(U, WS, KEY)).toEqual(bytes(1))
  })
})

describe('OpfsByteStore — the write path on an engine WITH createWritable', () => {
  it('a write failure rejects the put AND leaves no entry', async () => {
    const { store, root, faults, workers } = opfsWithRoot('stream')
    faults.failWrite = new DOMException('quota', 'QuotaExceededError')
    await expect(store.put(U, WS, KEY, bytes(1, 2, 3))).rejects.toThrow('quota')

    expect(wsDir(root)!.files.has(KEY)).toBe(false)
    expect(await store.has(U, WS, KEY)).toBe(false)
    expect(workers).toHaveLength(0) // the worker path is never built on this engine
  })
})

describe('OpfsByteStore — a poisoned store (empty entries an older build left behind)', () => {
  /** Mint an entry the way the broken write did: created, never written. */
  const poison = async (root: FakeDirHandle, key: string, ageMs: number) => {
    const dir = await (await (await root.getDirectoryHandle(ASSETS_ROOT, { create: true })).getDirectoryHandle(U, { create: true })).getDirectoryHandle(WS, { create: true })
    const f = await dir.getFileHandle(key, { create: true })
    f.lastModified = Date.now() - ageMs
    return f
  }

  it('has() is false for an empty entry (nothing was replicated into it), though the file exists', async () => {
    const { store, root } = opfsWithRoot()
    await poison(root, KEY, 0)
    expect(wsDir(root)!.files.has(KEY)).toBe(true)
    expect(await store.has(U, WS, KEY)).toBe(false)
  })

  it('sweepEmpty removes empty entries older than the floor, spares a young one (a put in flight) and every non-empty one', async () => {
    const { store, root } = opfsWithRoot()
    await poison(root, 'old-empty', 120_000)
    await poison(root, 'young-empty', 1_000)
    await store.put(U, WS, 'real', bytes(1, 2))

    expect(await store.sweepEmpty(U, WS, { minAgeMs: 60_000 })).toEqual({ scanned: 3, removed: 1 })
    expect([...wsDir(root)!.files.keys()].sort()).toEqual(['real', 'young-empty'])
    expect(await store.get(U, WS, 'real')).toEqual(bytes(1, 2))

    // Idempotent: a second sweep finds nothing more to do.
    expect(await store.sweepEmpty(U, WS, { minAgeMs: 60_000 })).toEqual({ scanned: 2, removed: 0 })
  })

  it('sweepEmpty is scoped to the (user, workspace) — a sibling workspace’s empties are left alone', async () => {
    const { store, root } = opfsWithRoot()
    await poison(root, 'old-empty', 120_000)
    const other = await (await (await root.getDirectoryHandle(ASSETS_ROOT)).getDirectoryHandle(U)).getDirectoryHandle('ws-B', { create: true })
    ;(await other.getFileHandle('also-empty', { create: true })).lastModified = 0

    await store.sweepEmpty(U, WS, { minAgeMs: 60_000 })
    expect(other.files.has('also-empty')).toBe(true)
  })

  it('sweepEmpty measures age against the injected clock', async () => {
    const { store, root } = opfsWithRoot()
    const f = await poison(root, KEY, 0)
    f.lastModified = 1_000
    expect(await store.sweepEmpty(U, WS, { minAgeMs: 100, now: () => 1_050 })).toEqual({ scanned: 1, removed: 0 })
    expect(await store.sweepEmpty(U, WS, { minAgeMs: 100, now: () => 1_200 })).toEqual({ scanned: 1, removed: 1 })
  })
})

describe('createWorkerFileWriter — the main-thread client', () => {
  it('a write the worker never answers times out, rejects, and drops the worker', async () => {
    const worker: WriterWorkerLike & { terminated: boolean } = {
      onmessage: null,
      onerror: null,
      terminated: false,
      postMessage: () => {},
      terminate() {
        this.terminated = true
      },
    }
    const writer = createWorkerFileWriter(() => worker, 20)
    await expect(writer.write(['a'], bytes(1))).rejects.toThrow(/timed out/)
    expect(worker.terminated).toBe(true)
  })
})
