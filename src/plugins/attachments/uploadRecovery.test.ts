import { beforeEach, describe, expect, it } from 'vitest'
import { encodeBytes } from '@/sync/byteTransform.js'
import { computeContentHash } from '@/sync/crypto/contentHash.js'
import type { GetCek, GetMaterializability, Materializability } from '@/sync/transform.js'
import type { BlobStore } from './blobStore.js'
import { recoverFailedUploads } from './uploadRecovery.js'
import { InMemoryByteUploadStore, type StageInput } from './uploadStore.js'

const USER = 'u1'
const WS = 'ws1'
const KEY = 'ck-deadbeef'
const BLOCK = 'media:ck-deadbeef'

const bytes = (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => i & 0xff)) as Uint8Array<ArrayBuffer>

const stageInput = (over: Partial<StageInput> = {}): StageInput => ({
  userId: USER,
  assetBlockId: BLOCK,
  workspaceId: WS,
  contentHash: 'sha256:placeholder',
  contentKey: KEY,
  ...over,
})

/** Stage → promote → markFailed, so the store holds a `failed` record for `hash`. */
const stageFailed = async (store: InMemoryByteUploadStore, over: Partial<StageInput> = {}) => {
  await store.stage(stageInput(over))
  await store.promote(over.userId ?? USER, over.assetBlockId ?? BLOCK)
  await store.markFailed(over.userId ?? USER, over.assetBlockId ?? BLOCK)
}

/** A BlobStore whose only real method is `probe`: returns `probeResult` (or throws
 *  `probeThrows`). put/get/delete are unused by the recovery pass and assert if hit. */
class FakeBlobStore implements BlobStore {
  probeResult: Uint8Array<ArrayBuffer> | null = null
  probeThrows: (() => never) | null = null
  probes = 0
  async probe(): Promise<Uint8Array<ArrayBuffer> | null> {
    this.probes += 1
    if (this.probeThrows) this.probeThrows()
    return this.probeResult
  }
  async put(): Promise<'written' | 'exists'> {
    throw new Error('recovery must never PUT — it re-drives only via the drain')
  }
  async get(): Promise<Uint8Array<ArrayBuffer>> {
    throw new Error('recovery uses probe(), not get()')
  }
  async delete(): Promise<void> {
    throw new Error('recovery never deletes the remote object')
  }
}

const mat = (m: Materializability): GetMaterializability => async () => m

describe('recoverFailedUploads (§9 failed-upload recovery actor)', () => {
  let store: InMemoryByteUploadStore
  let blobStore: FakeBlobStore
  const matCopy = mat('copy')
  const noCek: GetCek = async () => null

  beforeEach(() => {
    store = new InMemoryByteUploadStore(() => 1000)
    blobStore = new FakeBlobStore()
  })

  const deps = (over: Partial<Parameters<typeof recoverFailedUploads>[1]> = {}) => ({
    store,
    blobStore,
    getMaterializability: matCopy,
    getCek: noCek,
    ...over,
  })

  it('ABSENT path (404) → requeues failed → pending so the drain re-uploads', async () => {
    await stageFailed(store)
    blobStore.probeResult = null // the content path is free

    const summary = await recoverFailedUploads(USER, deps())

    expect(summary).toMatchObject({ requeued: 1, cleared: 0, poisoned: 0, exhausted: 0 })
    const rec = await store.get(USER, BLOCK)
    expect(rec).toMatchObject({ status: 'pending', attempts: 0, recoveryAttempts: 1 })
    expect(blobStore.probes).toBe(1)
  })

  it('PRESENT + hash-VERIFIES → deletes the record (already uploaded elsewhere), no re-upload', async () => {
    const plain = bytes(24)
    const realHash = await computeContentHash(plain)
    await stageFailed(store, { contentHash: realHash })
    blobStore.probeResult = plain // the path holds OUR exact (plaintext) content

    const summary = await recoverFailedUploads(USER, deps())

    expect(summary).toMatchObject({ cleared: 1, requeued: 0, poisoned: 0 })
    expect(await store.get(USER, BLOCK)).toBeNull() // cleared — the content is safely on the server
  })

  it('PRESENT + hash-MISMATCHES → stays failed (poisoned path, §17), never requeues or clears', async () => {
    const realHash = await computeContentHash(bytes(24))
    await stageFailed(store, { contentHash: realHash })
    blobStore.probeResult = bytes(99) // a DIFFERENT body occupies the content path

    const summary = await recoverFailedUploads(USER, deps())

    expect(summary).toMatchObject({ poisoned: 1, requeued: 0, cleared: 0 })
    expect((await store.get(USER, BLOCK))?.status).toBe('failed') // still surfaced for discard
  })

  it('PRESENT but UNDECODABLE (e2ee, wrong/absent key) → poisoned, stays failed', async () => {
    // e2ee mode with no CEK: decodeBytes throws → treated as poisoned (§17), like the drain.
    await stageFailed(store, { contentHash: await computeContentHash(bytes(8)) })
    blobStore.probeResult = bytes(50) // not a valid encb envelope for this key

    const summary = await recoverFailedUploads(USER, deps({ getMaterializability: mat('decrypt') }))

    expect(summary).toMatchObject({ poisoned: 1 })
    expect((await store.get(USER, BLOCK))?.status).toBe('failed')
  })

  it('e2ee PRESENT + verifies (sealed round-trip) → cleared', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const getCek: GetCek = async () => key
    const plain = bytes(40)
    const hash = await computeContentHash(plain)
    await stageFailed(store, { contentHash: hash })
    // The remote object is the SEALED ciphertext the drain would have uploaded.
    blobStore.probeResult = await encodeBytes(plain, 'e2ee', getCek, { contentHash: hash, workspaceId: WS })

    const summary = await recoverFailedUploads(USER, deps({ getMaterializability: mat('decrypt'), getCek }))

    expect(summary).toMatchObject({ cleared: 1 })
    expect(await store.get(USER, BLOCK)).toBeNull()
  })

  it('a TRANSIENT probe error (offline / 5xx / denied) → defers, no state change, no PUT', async () => {
    await stageFailed(store)
    blobStore.probeThrows = () => {
      throw new Error('offline')
    }

    const summary = await recoverFailedUploads(USER, deps())

    expect(summary).toMatchObject({ deferred: 1, requeued: 0, cleared: 0 })
    expect((await store.get(USER, BLOCK))?.status).toBe('failed') // untouched, re-probed next trigger
  })

  it('DEFERS (no probe at all) when the workspace is not materializable (locked / unpinned)', async () => {
    await stageFailed(store)

    const summary = await recoverFailedUploads(USER, deps({ getMaterializability: mat('defer') }))

    expect(summary).toMatchObject({ deferred: 1 })
    expect(blobStore.probes).toBe(0) // never even hit the network — can't verify while locked
    expect((await store.get(USER, BLOCK))?.status).toBe('failed')
  })

  it('DEFERS (no probe) when the queued user is no longer the active account', async () => {
    await stageFailed(store)

    const summary = await recoverFailedUploads(USER, deps({ isActiveUser: () => false }))

    expect(summary).toMatchObject({ deferred: 1 })
    expect(blobStore.probes).toBe(0)
    expect((await store.get(USER, BLOCK))?.status).toBe('failed')
  })

  it('only touches FAILED records — pending / staged are left for the drain / reconciler', async () => {
    await store.stage(stageInput({ assetBlockId: 'media:staged', contentKey: 'ks' })) // staged
    await store.stage(stageInput({ assetBlockId: 'media:pending', contentKey: 'kp' }))
    await store.promote(USER, 'media:pending') // pending
    blobStore.probeResult = null

    const summary = await recoverFailedUploads(USER, deps())

    expect(summary).toEqual({ requeued: 0, cleared: 0, poisoned: 0, deferred: 0, exhausted: 0 })
    expect(blobStore.probes).toBe(0) // no failed records → nothing probed
    expect((await store.get(USER, 'media:staged'))?.status).toBe('staged')
    expect((await store.get(USER, 'media:pending'))?.status).toBe('pending')
  })

  describe('the re-drive bound (a persistent poisoner / shape-reject bug)', () => {
    it('stops re-driving an ABSENT path once recoveryAttempts hits maxRecoveryAttempts → exhausted', async () => {
      await stageFailed(store)
      // Simulate a record that has already been re-driven up to the bound: bump it there.
      for (let i = 0; i < 3; i++) {
        await store.requeue(USER, BLOCK)
        await store.markFailed(USER, BLOCK) // each re-drive came back failed
      }
      expect((await store.get(USER, BLOCK))?.recoveryAttempts).toBe(3)
      blobStore.probeResult = null // path is free, but the bound is spent

      const summary = await recoverFailedUploads(USER, deps({ maxRecoveryAttempts: 3 }))

      expect(summary).toMatchObject({ exhausted: 1, requeued: 0 })
      expect(blobStore.probes).toBe(1) // the cheap probe STILL runs past the bound…
      expect((await store.get(USER, BLOCK))?.status).toBe('failed') // …but no re-drive
    })

    it('past the bound, a PRESENT-and-verifies path is STILL cleared (heal "uploaded elsewhere")', async () => {
      const plain = bytes(16)
      const hash = await computeContentHash(plain)
      await stageFailed(store, { contentHash: hash })
      for (let i = 0; i < 3; i++) {
        await store.requeue(USER, BLOCK)
        await store.markFailed(USER, BLOCK)
      }
      blobStore.probeResult = plain // someone else uploaded our content after all

      const summary = await recoverFailedUploads(USER, deps({ maxRecoveryAttempts: 3 }))

      expect(summary).toMatchObject({ cleared: 1, exhausted: 0 })
      expect(await store.get(USER, BLOCK)).toBeNull()
    })

    it('a HIGHER cap (the slow sweep / uncapped Retry) re-drives a freed path past the low bound', async () => {
      // The auto-heal path: a shape-rejected body exhausted the LOW (frequent-trigger) cap,
      // then the obstruction lifts (limit raised / client fixed). The sweep's HIGH cap (and
      // the Retry's Infinity) re-drive so it heals, rather than sitting failed forever (the
      // frequent triggers stay 'exhausted' — the test above).
      await stageFailed(store)
      for (let i = 0; i < 5; i++) {
        await store.requeue(USER, BLOCK)
        await store.markFailed(USER, BLOCK)
      }
      expect((await store.get(USER, BLOCK))?.recoveryAttempts).toBe(5) // past the low bound (3)
      blobStore.probeResult = null // path is now free

      const summary = await recoverFailedUploads(USER, deps({ maxRecoveryAttempts: Number.POSITIVE_INFINITY }))

      expect(summary).toMatchObject({ requeued: 1, exhausted: 0 })
      expect((await store.get(USER, BLOCK))?.status).toBe('pending')
    })
  })

  it('is scoped to the user — another account’s failed record is not probed or touched', async () => {
    await stageFailed(store, { userId: 'u1', assetBlockId: 'media:mine', contentKey: 'k1' })
    await stageFailed(store, { userId: 'u2', assetBlockId: 'media:theirs', contentKey: 'k2' })
    blobStore.probeResult = null

    const summary = await recoverFailedUploads('u1', deps())

    expect(summary).toMatchObject({ requeued: 1 })
    expect(blobStore.probes).toBe(1) // only u1's one failed record
    expect((await store.get('u2', 'media:theirs'))?.status).toBe('failed') // untouched
  })
})
