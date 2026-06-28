import { describe, expect, it } from 'vitest'
import { ASSETS_ROOT, InMemoryByteStore, OpfsByteStore, assetPathSegments } from './byteStore.js'

const U = 'user-1'
const WS = 'ws-A'
const KEY = 'deadbeef'
const bytes = (...vals: number[]) => new Uint8Array(vals)

// ── A minimal in-memory OPFS tree, just enough to back OpfsByteStore ──────────
class FakeFileHandle {
  kind = 'file' as const
  data = new Uint8Array(0)
  async getFile() {
    // A fresh copy each read, like a real File over OPFS.
    return { arrayBuffer: async () => this.data.slice().buffer }
  }
  async createWritable() {
    const chunks: Uint8Array[] = []
    return {
      write: async (chunk: Uint8Array) => void chunks.push(new Uint8Array(chunk)),
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
}

const opfsWithRoot = () => {
  const root = new FakeDirHandle()
  const store = new OpfsByteStore({ getRoot: async () => root as unknown as FileSystemDirectoryHandle })
  return { store, root }
}

// ── The behavioral contract both implementations must satisfy ─────────────────
describe.each([
  ['InMemoryByteStore', () => new InMemoryByteStore()],
  ['OpfsByteStore', () => opfsWithRoot().store],
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
