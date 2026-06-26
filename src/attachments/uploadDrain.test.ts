import { beforeEach, describe, expect, it } from 'vitest'
import { decodeBytes } from '../sync/byteTransform.js'
import type { GetCek, GetMaterializability, Materializability } from '../sync/transform.js'
import { BlobPutError, type BlobStore } from './blobStore.js'
import { InMemoryByteStore } from './byteStore.js'
import { drainUploads } from './uploadDrain.js'
import { InMemoryByteUploadStore, type StageInput } from './uploadStore.js'

const USER = 'u1'
const WS = 'ws1'
const HASH = 'sha256:deadbeef'
const KEY = 'ck-deadbeef'
const BLOCK = 'media:ck-deadbeef'

const bytes = (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => i & 0xff)) as Uint8Array<ArrayBuffer>

const stageInput = (over: Partial<StageInput> = {}): StageInput => ({
  userId: USER,
  assetBlockId: BLOCK,
  workspaceId: WS,
  contentHash: HASH,
  contentKey: KEY,
  generation: 1,
  ...over,
})

// A controllable BlobStore: records every put, optionally throws a scripted error.
class FakeBlobStore implements BlobStore {
  puts: Array<{ workspaceId: string; contentKey: string; bytes: Uint8Array<ArrayBuffer> }> = []
  fail: (() => never) | null = null
  async put(workspaceId: string, contentKey: string, b: Uint8Array<ArrayBuffer>): Promise<void> {
    if (this.fail) this.fail()
    this.puts.push({ workspaceId, contentKey, bytes: b })
  }
  async get(): Promise<Uint8Array<ArrayBuffer>> {
    throw new Error('not used in drain tests')
  }
  async delete(): Promise<void> {}
}

const aesKey = () =>
  crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])

// Typed materializability stub — an inline `async () => 'copy'` widens to
// Promise<string>, which isn't assignable to GetMaterializability under tsc.
const mat = (m: Materializability): GetMaterializability => async () => m

describe('drainUploads (Phase 5b — the up-lane)', () => {
  let store: InMemoryByteUploadStore
  let byteStore: InMemoryByteStore
  let blobStore: FakeBlobStore
  let clock: number
  const matCopy = mat('copy')
  const noCek: GetCek = async () => null

  beforeEach(() => {
    clock = 1000
    store = new InMemoryByteUploadStore(() => clock)
    byteStore = new InMemoryByteStore()
    blobStore = new FakeBlobStore()
  })

  const deps = (over: Partial<Parameters<typeof drainUploads>[1]> = {}) => ({
    store,
    byteStore,
    blobStore,
    getMaterializability: matCopy,
    getCek: noCek,
    now: () => clock,
    ...over,
  })

  it('uploads a pending plaintext asset and deletes the record on success', async () => {
    await store.stage(stageInput())
    await store.promote(USER, BLOCK)
    await byteStore.put(USER, WS, KEY, bytes(32))

    const summary = await drainUploads(USER, deps())

    expect(summary).toMatchObject({ uploaded: 1, failed: 0, deferred: 0, retried: 0 })
    expect(blobStore.puts).toHaveLength(1)
    expect(blobStore.puts[0]).toMatchObject({ workspaceId: WS, contentKey: KEY })
    // plaintext mode is identity — the uploaded bytes equal the stored plaintext
    expect([...blobStore.puts[0].bytes]).toEqual([...bytes(32)])
    expect(await store.get(USER, BLOCK)).toBeNull()
  })

  it('does NOT drain a staged (not-yet-promoted) record', async () => {
    await store.stage(stageInput()) // staged, never promoted
    await byteStore.put(USER, WS, KEY, bytes(8))

    const summary = await drainUploads(USER, deps())

    expect(summary.uploaded).toBe(0)
    expect(blobStore.puts).toHaveLength(0)
    expect((await store.get(USER, BLOCK))?.status).toBe('staged')
  })

  it('encode-at-drain SEALS e2ee bytes — the upload is ciphertext that round-trips', async () => {
    const key = await aesKey()
    const matDecrypt = mat('decrypt')
    const getCek: GetCek = async () => key
    await store.stage(stageInput())
    await store.promote(USER, BLOCK)
    const plain = bytes(40)
    await byteStore.put(USER, WS, KEY, plain)

    await drainUploads(USER, deps({ getMaterializability: matDecrypt, getCek }))

    const uploaded = blobStore.puts[0].bytes
    expect([...uploaded]).not.toEqual([...plain]) // sealed, not raw
    const opened = await decodeBytes(uploaded, 'e2ee', getCek, { contentHash: HASH, workspaceId: WS })
    expect([...opened]).toEqual([...plain]) // and it opens back to the plaintext
    expect(await store.get(USER, BLOCK)).toBeNull()
  })

  it('defers (leaves pending, no upload) when the workspace is not materializable', async () => {
    const matDefer = mat('defer')
    await store.stage(stageInput())
    await store.promote(USER, BLOCK)
    await byteStore.put(USER, WS, KEY, bytes(8))

    const summary = await drainUploads(USER, deps({ getMaterializability: matDefer }))

    expect(summary).toMatchObject({ uploaded: 0, deferred: 1 })
    expect(blobStore.puts).toHaveLength(0)
    expect((await store.get(USER, BLOCK))?.status).toBe('pending')
  })

  it('quarantines (→failed) on a PERMANENT upload rejection', async () => {
    await store.stage(stageInput())
    await store.promote(USER, BLOCK)
    await byteStore.put(USER, WS, KEY, bytes(8))
    blobStore.fail = () => {
      throw new BlobPutError('forbidden', true, 403, 'AccessDenied')
    }

    const summary = await drainUploads(USER, deps())

    expect(summary).toMatchObject({ failed: 1, uploaded: 0 })
    expect((await store.get(USER, BLOCK))?.status).toBe('failed')
  })

  it('retries (bumps attempts, stays pending) on a TRANSIENT rejection below the bound', async () => {
    await store.stage(stageInput())
    await store.promote(USER, BLOCK)
    await byteStore.put(USER, WS, KEY, bytes(8))
    blobStore.fail = () => {
      throw new BlobPutError('offline', false, 0, 'network')
    }

    const summary = await drainUploads(USER, deps({ maxAttempts: 5 }))

    expect(summary).toMatchObject({ retried: 1, failed: 0 })
    const rec = await store.get(USER, BLOCK)
    expect(rec).toMatchObject({ status: 'pending', attempts: 1 })
  })

  it('a transient failure that exhausts the attempt bound is quarantined', async () => {
    await store.stage(stageInput())
    await store.promote(USER, BLOCK)
    await byteStore.put(USER, WS, KEY, bytes(8))
    blobStore.fail = () => {
      throw new BlobPutError('offline', false, 0, 'network')
    }

    // maxAttempts=2: drain #1 → attempts 1 (retried), drain #2 → bound reached → failed
    await drainUploads(USER, deps({ maxAttempts: 2 }))
    expect((await store.get(USER, BLOCK))?.status).toBe('pending')
    const second = await drainUploads(USER, deps({ maxAttempts: 2 }))
    expect(second).toMatchObject({ failed: 1 })
    expect((await store.get(USER, BLOCK))?.status).toBe('failed')
  })

  it('a transient failure past the age bound is quarantined regardless of attempts', async () => {
    await store.stage(stageInput()) // stagedAt = 1000
    await store.promote(USER, BLOCK)
    await byteStore.put(USER, WS, KEY, bytes(8))
    blobStore.fail = () => {
      throw new BlobPutError('5xx', false, 503, 'network')
    }
    clock = 1000 + 10_000

    const summary = await drainUploads(USER, deps({ maxAttempts: 100, maxAgeMs: 5_000 }))

    expect(summary).toMatchObject({ failed: 1 })
    expect((await store.get(USER, BLOCK))?.status).toBe('failed')
  })

  it('quarantines (→failed) when the local bytes are gone (OPFS eviction before upload)', async () => {
    await store.stage(stageInput())
    await store.promote(USER, BLOCK)
    // intentionally do NOT put bytes into byteStore

    const summary = await drainUploads(USER, deps())

    expect(summary).toMatchObject({ failed: 1 })
    expect(blobStore.puts).toHaveLength(0)
    expect((await store.get(USER, BLOCK))?.status).toBe('failed')
  })

  it('drains only the active user’s pending records', async () => {
    await store.stage(stageInput({ userId: 'u1', assetBlockId: 'media:a', contentKey: 'a' }))
    await store.promote('u1', 'media:a')
    await byteStore.put('u1', WS, 'a', bytes(4))
    await store.stage(stageInput({ userId: 'u2', assetBlockId: 'media:b', contentKey: 'b' }))
    await store.promote('u2', 'media:b')
    await byteStore.put('u2', WS, 'b', bytes(4))

    await drainUploads('u1', deps())

    expect(blobStore.puts.map(p => p.contentKey)).toEqual(['a'])
    expect(await store.get('u1', 'media:a')).toBeNull() // uploaded
    expect((await store.get('u2', 'media:b'))?.status).toBe('pending') // untouched
  })
})
