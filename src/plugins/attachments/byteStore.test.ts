import { describe, expect, it } from 'vitest'
import { ASSETS_ROOT, InMemoryByteStore, OpfsByteStore, assetPathSegments, type ByteStore } from './byteStore.js'
import { handleWriteRequest, type WriteReply, type WriteRequest, type WriterWorkerLike } from './byteStoreWriter.js'

const U = 'user-1'
const WS = 'ws-A'
const KEY = 'deadbeef'
const bytes = (...vals: number[]) => new Uint8Array(vals)

// ── A minimal in-memory OPFS tree, just enough to back OpfsByteStore ──────────
class FakeFileHandle {
  kind = 'file' as const
  data = new Uint8Array(0)
  /** Fails the next write, as a full disk does. */
  static failWrites: Error | null = null
  /** Fails the next writable's opening, as a full disk can. */
  static failOpens: Error | null = null
  /** What each next writable's write waits on first, in order: a hold, or a failure. */
  static nextWrites: Array<() => Promise<void>> = []
  async getFile() {
    // A fresh copy each read, like a real File over OPFS.
    return { size: this.data.length, arrayBuffer: async () => this.data.slice().buffer }
  }
  /** Fails a sync-handle write after this many bytes landed, as a full disk does. */
  static failSyncWriteAfter: number | null = null
  static openSyncHandles = 0
  /** The in-place write primitive: unlike a writable, what it wrote stays on failure. */
  async createSyncAccessHandle() {
    FakeFileHandle.openSyncHandles++
    return {
      truncate: (size: number) => { this.data = this.data.slice(0, size) },
      write: (chunk: Uint8Array, opts?: { at?: number }) => {
        const limit = FakeFileHandle.failSyncWriteAfter
        const taken = limit === null ? chunk : chunk.subarray(0, limit)
        const at = opts?.at ?? 0
        const out = new Uint8Array(Math.max(this.data.length, at + taken.length))
        out.set(this.data)
        out.set(taken, at)
        this.data = out
        if (limit !== null) throw new DOMException('full', 'QuotaExceededError')
        return taken.length
      },
      flush: () => {},
      close: () => { FakeFileHandle.openSyncHandles-- },
    }
  }
  async createWritable() {
    if (FakeFileHandle.failOpens) throw FakeFileHandle.failOpens
    const chunks: Uint8Array[] = []
    const before = FakeFileHandle.nextWrites.shift()
    return {
      write: async (chunk: Uint8Array) => {
        await before?.()
        if (FakeFileHandle.failWrites) throw FakeFileHandle.failWrites
        chunks.push(new Uint8Array(chunk))
      },
      abort: async () => {},
      close: async () => {
        const total = chunks.reduce((n, c) => n + c.length, 0)
        const out = new Uint8Array(total)
        let off = 0
        for (const c of chunks) {
          out.set(c, off)
          off += c.length
        }
        this.data = out
      },
    }
  }
}

class FakeDirHandle {
  kind = 'directory' as const
  readonly dirs = new Map<string, FakeDirHandle>()
  readonly files = new Map<string, FakeFileHandle>()

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDirHandle> {
    let d = this.dirs.get(name)
    if (!d) {
      if (!opts?.create) throw new DOMException(`no dir ${name}`, 'NotFoundError')
      d = new FakeDirHandle()
      this.dirs.set(name, d)
    }
    return d
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFileHandle> {
    let f = this.files.get(name)
    if (!f) {
      if (!opts?.create) throw new DOMException(`no file ${name}`, 'NotFoundError')
      f = new FakeFileHandle()
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

  async *entries(): AsyncGenerator<[string, FakeFileHandle | FakeDirHandle]> {
    yield* this.files
    yield* this.dirs
  }
}

const asRoot = (root: FakeDirHandle) => root as unknown as FileSystemDirectoryHandle

/** The writer worker, in-thread: the real handler over the fake tree. `hang` never
 *  answers (after `beforeHang` has had its way with the tree); `crash` fires onerror. */
class FakeWriterWorker implements WriterWorkerLike {
  static spawned = 0
  onmessage: ((event: MessageEvent<WriteReply>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  terminated = false
  constructor(
    private readonly root: FakeDirHandle,
    private readonly mode: 'ok' | 'hang' | 'crash',
    private readonly beforeHang?: (root: FakeDirHandle) => Promise<void>,
  ) {
    FakeWriterWorker.spawned++
  }
  postMessage(message: WriteRequest): void {
    if (this.mode === 'hang') return void this.beforeHang?.(this.root)
    if (this.mode === 'crash') return void Promise.resolve().then(() => this.onerror?.({ message: 'boom' } as ErrorEvent))
    void handleWriteRequest(async () => asRoot(this.root), message).then((reply) => {
      if (!this.terminated) this.onmessage?.({ data: reply } as MessageEvent<WriteReply>)
    })
  }
  terminate(): void {
    this.terminated = true
  }
}

const opfsWithRoot = () => {
  const root = new FakeDirHandle()
  const store = new OpfsByteStore({ getRoot: async () => asRoot(root), hasWritableStream: () => true })
  return { store, root }
}

/** A store on an engine without `createWritable`: every put goes through the worker. */
const workerOpfs = (over: { modes?: Array<'ok' | 'hang' | 'crash'>; beforeHang?: (root: FakeDirHandle) => Promise<void>; writeTimeoutMs?: number } = {}) => {
  const root = new FakeDirHandle()
  const modes = [...(over.modes ?? [])]
  const store = new OpfsByteStore({
    getRoot: async () => asRoot(root),
    hasWritableStream: () => false,
    spawnWriterWorker: () => new FakeWriterWorker(root, modes.shift() ?? 'ok', over.beforeHang),
    writeTimeoutMs: over.writeTimeoutMs,
  })
  return { store, root }
}

const fileAt = (root: FakeDirHandle, key = KEY) => root.dirs.get(ASSETS_ROOT)?.dirs.get(U)?.dirs.get(WS)?.files.get(key)

// ── The behavioral contract both implementations must satisfy ─────────────────
describe.each<[string, () => ByteStore]>([
  ['InMemoryByteStore', () => new InMemoryByteStore()],
  ['OpfsByteStore (createWritable)', () => opfsWithRoot().store],
  ['OpfsByteStore (worker + sync access handle)', () => workerOpfs().store],
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

  it('a re-put replaces the bytes, leaving no tail of a longer previous copy', async () => {
    const store = make()
    await store.put(U, WS, KEY, bytes(1, 2, 3, 4))
    await store.put(U, WS, KEY, bytes(9))
    expect(await store.get(U, WS, KEY)).toEqual(bytes(9))
  })

  it('put leaves the caller’s buffer usable (the resolver serves the bytes it just stored)', async () => {
    const store = make()
    const src = bytes(5, 6, 7)
    await store.put(U, WS, KEY, src)
    expect(src).toEqual(bytes(5, 6, 7))
  })

  it('an empty entry is neither present nor listed, and a put over it stores the bytes', async () => {
    const store = make()
    await store.put(U, WS, KEY, bytes())
    expect(await store.has(U, WS, KEY)).toBe(false)
    expect(await store.listWorkspaceKeys(U, WS)).toEqual(new Set())

    await store.put(U, WS, KEY, bytes(1))
    expect(await store.has(U, WS, KEY)).toBe(true)
    expect(await store.listWorkspaceKeys(U, WS)).toEqual(new Set([KEY]))
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

  it('a failed write surfaces its own error and leaves no empty entry to read back', async () => {
    const { store } = opfsWithRoot()
    await store.put(U, WS, 'kept', bytes(1))
    FakeFileHandle.failWrites = new DOMException('full', 'QuotaExceededError')
    try {
      await expect(store.put(U, WS, KEY, bytes(1, 2))).rejects.toMatchObject({name: 'QuotaExceededError'})
      // An existing entry is kept as it was.
      await expect(store.put(U, WS, 'kept', bytes(9))).rejects.toMatchObject({name: 'QuotaExceededError'})
    } finally {
      FakeFileHandle.failWrites = null
    }
    expect(await store.get(U, WS, KEY)).toBeNull()
    expect(await store.get(U, WS, 'kept')).toEqual(bytes(1))
  })

  it('a writer that fails to open leaves no empty entry to read back or list', async () => {
    const { store } = opfsWithRoot()
    FakeFileHandle.failOpens = new DOMException('full', 'QuotaExceededError')
    try {
      await expect(store.put(U, WS, KEY, bytes(1, 2))).rejects.toMatchObject({name: 'QuotaExceededError'})
    } finally {
      FakeFileHandle.failOpens = null
    }
    expect(await store.has(U, WS, KEY)).toBe(false)
    expect([...(await store.listWorkspaceKeys(U, WS))]).toEqual([])
  })

  it('a failed write never removes the bytes a concurrent put of the same key stored', async () => {
    const { store } = opfsWithRoot()
    let failSecond!: () => void
    const secondFails = new Promise<void>(resolve => { failSecond = resolve })
    const full = async () => { throw new DOMException('full', 'QuotaExceededError') }
    // The first put succeeds; the second, started alongside it, fails once
    // the first has finished, and so does its retry.
    FakeFileHandle.nextWrites = [async () => {}, () => secondFails.then(full), full]
    try {
      const first = store.put(U, WS, KEY, bytes(1, 2))
      const second = store.put(U, WS, KEY, bytes(1, 2))
      const secondRejects = expect(second).rejects.toMatchObject({name: 'QuotaExceededError'})
      await first
      failSecond()
      await secondRejects
    } finally {
      FakeFileHandle.nextWrites = []
    }
    expect(await store.get(U, WS, KEY)).toEqual(bytes(1, 2))
  })

  it('purgeWorkspace removes the workspace subtree from disk', async () => {
    const { store, root } = opfsWithRoot()
    await store.put(U, WS, KEY, bytes(1))
    await store.purgeWorkspace(U, WS)
    const userDir = root.dirs.get(ASSETS_ROOT)!.dirs.get(U)!
    expect(userDir.dirs.has(WS)).toBe(false)
  })
})

describe('OpfsByteStore — writing where the engine has no createWritable (WebKit before Safari 26)', () => {
  it('writes through one worker, reused across puts, and closes each handle', async () => {
    const before = FakeWriterWorker.spawned
    const { store, root } = workerOpfs()
    await store.put(U, WS, KEY, bytes(1, 2, 3))
    await store.put(U, WS, 'other', bytes(4))

    expect(fileAt(root)?.data).toEqual(bytes(1, 2, 3))
    expect(FakeWriterWorker.spawned - before).toBe(1)
    expect(FakeFileHandle.openSyncHandles).toBe(0)
  })

  it('a write that fails part-way rejects and leaves no partial entry', async () => {
    const { store, root } = workerOpfs()
    FakeFileHandle.failSyncWriteAfter = 2
    try {
      await expect(store.put(U, WS, KEY, bytes(1, 2, 3, 4))).rejects.toThrow(/full/)
    } finally {
      FakeFileHandle.failSyncWriteAfter = null
    }
    expect(fileAt(root)).toBeUndefined()
    expect(FakeFileHandle.openSyncHandles).toBe(0)
  })

  it('a write the worker never answers times out, its partial file is removed, and the next put uses a fresh worker', async () => {
    const { store, root } = workerOpfs({
      modes: ['hang'],
      writeTimeoutMs: 20,
      // What a worker killed mid-write leaves: the entry, with some of the bytes.
      beforeHang: async (tree) => {
        let dir = tree
        for (const name of [ASSETS_ROOT, U, WS]) dir = await dir.getDirectoryHandle(name, { create: true })
        ;(await dir.getFileHandle(KEY, { create: true })).data = bytes(1, 2)
      },
    })

    await expect(store.put(U, WS, KEY, bytes(1, 2, 3, 4))).rejects.toThrow(/timed out/)
    expect(fileAt(root)).toBeUndefined()

    await store.put(U, WS, KEY, bytes(1, 2, 3, 4))
    expect(await store.get(U, WS, KEY)).toEqual(bytes(1, 2, 3, 4))
  })

  it('an abandoned write keeps an entry that is already the complete copy', async () => {
    // It may be the only copy of a capture not yet uploaded.
    const { store, root } = workerOpfs()
    await store.put(U, WS, KEY, bytes(1, 2, 3))
    const hung = new OpfsByteStore({
      getRoot: async () => asRoot(root),
      hasWritableStream: () => false,
      spawnWriterWorker: () => new FakeWriterWorker(root, 'hang'),
      writeTimeoutMs: 20,
    })

    await expect(hung.put(U, WS, KEY, bytes(1, 2, 3))).rejects.toThrow(/timed out/)
    expect(await store.get(U, WS, KEY)).toEqual(bytes(1, 2, 3))
  })

  it('a worker that dies rejects the pending put, and the next put spawns another', async () => {
    const { store } = workerOpfs({ modes: ['crash'] })
    await expect(store.put(U, WS, KEY, bytes(1))).rejects.toThrow(/worker failed/)
    await store.put(U, WS, KEY, bytes(1))
    expect(await store.get(U, WS, KEY)).toEqual(bytes(1))
  })
})
