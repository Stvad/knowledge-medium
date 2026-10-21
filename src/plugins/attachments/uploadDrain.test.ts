import { beforeEach, describe, expect, it } from 'vitest'
import { verifyObjectBytes } from '@/sync/byteTransform.js'
import { computeContentHash } from '@/sync/crypto/contentHash.js'
import { deriveContentKey, deriveContentKeyHmac } from '@/sync/crypto/contentKey.js'
import type { WorkspaceConversionRead } from '@/sync/keys/conversionState.js'
import type { GetCek, GetMaterializability, Materializability } from '@/sync/transform.js'
import { BlobPutError, type BlobStore } from './blobStore.js'
import { InMemoryByteStore } from './byteStore.js'
import { drainUploads } from './uploadDrain.js'
import { InMemoryByteUploadStore, type StageInput } from './uploadStore.js'

const USER = 'u1'
const WS = 'ws1'
// A well-formed hash no test byte string matches; its raw name is the record's
// capture-time key, as for anything captured in a plaintext workspace.
const KEY = 'ab'.repeat(32)
const HASH = `sha256:${KEY}`
const BLOCK = 'media:ab'

const bytes = (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => i & 0xff)) as Uint8Array<ArrayBuffer>

const stageInput = (over: Partial<StageInput> = {}): StageInput => ({
  userId: USER,
  assetBlockId: BLOCK,
  workspaceId: WS,
  contentHash: HASH,
  contentKey: KEY,
  ...over,
})

// A controllable BlobStore: records every put, optionally throws a scripted error.
class FakeBlobStore implements BlobStore {
  puts: Array<{ workspaceId: string; contentKey: string; bytes: Uint8Array<ArrayBuffer> }> = []
  fail: (() => never) | null = null
  /** When set, put() reports a 409 dedup and get() returns these bytes as the
   *  existing remote object — so the drain's verify-on-409 path runs against them. */
  existing: Uint8Array<ArrayBuffer> | null = null
  /** When true, the verify GET throws (a transient read failure on the 409 path). */
  getFails = false
  async put(workspaceId: string, contentKey: string, b: Uint8Array<ArrayBuffer>): Promise<'written' | 'exists'> {
    if (this.fail) this.fail()
    this.puts.push({ workspaceId, contentKey, bytes: b })
    return this.existing ? 'exists' : 'written'
  }
  gets: string[] = []
  async get(_workspaceId: string, objectKey: string): Promise<Uint8Array<ArrayBuffer>> {
    this.gets.push(objectKey)
    if (this.getFails) throw new Error('transient verify GET failure')
    if (this.existing) return this.existing
    throw new Error('not used in drain tests')
  }
  async probe(): Promise<Uint8Array<ArrayBuffer> | null> {
    throw new Error('the drain uses put/get, never probe (that is the §9 recovery pass)')
  }
  async delete(): Promise<void> {}
}

const live = (encryptionMode: string) => async (): Promise<WorkspaceConversionRead> => ({
  kind: 'read',
  state: { encryptionMode, conversionPhase: null, wkCanary: null, ownerUserId: 'owner' },
})
const unavailable = async (): Promise<WorkspaceConversionRead> => ({ kind: 'unavailable', error: new Error('offline') })

const kid = await deriveContentKeyHmac(new Uint8Array(32).fill(5) as Uint8Array<ArrayBuffer>)

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
    getContentKeyHmac: async () => null,
    readLiveWorkspace: live('none'),
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

  it('409 whose existing object hash-MATCHES → clears the record (genuine cross-device dedup)', async () => {
    const plain = bytes(24)
    const realHash = await computeContentHash(plain)
    await store.stage(stageInput({ contentHash: realHash }))
    await store.promote(USER, BLOCK)
    await byteStore.put(USER, WS, KEY, plain)
    blobStore.existing = plain // the path already holds OUR exact (plaintext) content

    const summary = await drainUploads(USER, deps())

    expect(summary).toMatchObject({ uploaded: 1, failed: 0, retried: 0 })
    expect(await store.get(USER, BLOCK)).toBeNull() // safe to clear — the dedup is genuine
  })

  it('409 whose existing object hash-MISMATCHES (poisoned path) → keeps the record failed, never clears', async () => {
    // HASH never matches arbitrary bytes, so the existing object is "poisoned".
    await store.stage(stageInput())
    await store.promote(USER, BLOCK)
    await byteStore.put(USER, WS, KEY, bytes(16))
    blobStore.existing = bytes(99) // a different body already occupies the content path

    const summary = await drainUploads(USER, deps())

    expect(summary).toMatchObject({ failed: 1, uploaded: 0 })
    // Preserved (not cleared) so §9/§17 correction can act — clearing would strand the good bytes.
    expect((await store.get(USER, BLOCK))?.status).toBe('failed')
  })

  it('409 whose verify-GET fails transiently → retries (does not clear, does not quarantine)', async () => {
    await store.stage(stageInput())
    await store.promote(USER, BLOCK)
    await byteStore.put(USER, WS, KEY, bytes(16))
    blobStore.existing = bytes(16) // put → 'exists'
    blobStore.getFails = true // …but the verify read fails transiently

    const summary = await drainUploads(USER, deps({ maxAttempts: 5 }))

    expect(summary).toMatchObject({ retried: 1, failed: 0, uploaded: 0 })
    expect((await store.get(USER, BLOCK))).toMatchObject({ status: 'pending', attempts: 1 })
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
    const plain = bytes(40)
    const contentHash = await computeContentHash(plain)
    await store.stage(stageInput({ contentHash }))
    await store.promote(USER, BLOCK)
    await byteStore.put(USER, WS, KEY, plain)

    await drainUploads(USER, deps({ getMaterializability: matDecrypt, getCek, getContentKeyHmac: async () => kid }))

    const uploaded = blobStore.puts[0].bytes
    expect([...uploaded]).not.toEqual([...plain]) // sealed, not raw
    const opened = await verifyObjectBytes(uploaded, 'e2ee', getCek, { contentHash, workspaceId: WS })
    expect(opened.ok && [...opened.plaintext]).toEqual([...plain]) // and it opens back to the plaintext
    expect(await store.get(USER, BLOCK)).toBeNull()
  })

  it('skips (defers, no attempt burn) a record whose queued user is no longer the active account', async () => {
    // An account switch landed after the drain was armed: the deps + session now
    // belong to a different user, so draining this record could 403 and wrongly
    // quarantine it. It must defer (stay pending) and re-drain when its user returns.
    await store.stage(stageInput())
    await store.promote(USER, BLOCK)
    await byteStore.put(USER, WS, KEY, bytes(8))

    const summary = await drainUploads(USER, deps({ isActiveUser: () => false }))

    expect(summary).toMatchObject({ deferred: 1, uploaded: 0, failed: 0, retried: 0 })
    expect(blobStore.puts).toHaveLength(0) // never touched Storage under the wrong account
    expect((await store.get(USER, BLOCK))?.status).toBe('pending')
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

  it('a TRANSIENT rejection DEFERS (no attempt burn) and stays pending', async () => {
    await store.stage(stageInput())
    await store.promote(USER, BLOCK)
    await byteStore.put(USER, WS, KEY, bytes(8))
    blobStore.fail = () => {
      throw new BlobPutError('offline', false, 0, 'network')
    }

    const summary = await drainUploads(USER, deps({ maxAttempts: 5 }))

    expect(summary).toMatchObject({ deferred: 1, retried: 0, failed: 0 })
    const rec = await store.get(USER, BLOCK)
    expect(rec).toMatchObject({ status: 'pending', attempts: 0 }) // attempt budget untouched
  })

  it('a transient failure CANNOT exhaust the attempt budget — only AGE quarantines (Codex P2)', async () => {
    await store.stage(stageInput())
    await store.promote(USER, BLOCK)
    await byteStore.put(USER, WS, KEY, bytes(8))
    blobStore.fail = () => {
      throw new BlobPutError('offline', false, 0, 'network')
    }

    // The reconciler re-arms the drain on every online/visible event. With a tiny
    // attempt budget, the PRE-FIX code quarantined a good paste in a handful of drains;
    // now a transient miss only defers (the clock doesn't advance, so age never trips).
    for (let i = 0; i < 12; i++) {
      const s = await drainUploads(USER, deps({ maxAttempts: 2 }))
      expect(s).toMatchObject({ deferred: 1, failed: 0 })
    }
    expect(await store.get(USER, BLOCK)).toMatchObject({ status: 'pending', attempts: 0 })
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

  it('a re-paste that re-arms a record mid-drain is NOT buried by the drain’s stale failure', async () => {
    // The drain snapshots the pending record (stagedAt 1000) and starts a slow upload;
    // a concurrent re-paste re-arms the SAME content (capture is lock-free) with a
    // fresh stamp before the upload's failure is handled. The drain's stale `markFailed`
    // must be dropped, leaving the live re-paste intact (else it lands in `failed`,
    // which nothing re-drains).
    await store.stage(stageInput()) // stagedAt 1000
    await store.promote(USER, BLOCK)
    await byteStore.put(USER, WS, KEY, bytes(8))
    clock = 2000
    blobStore.fail = () => {
      void store.stage(stageInput()) // re-arm: staged, attempts 0, stagedAt 2000
      throw new BlobPutError('offline', false, 0, 'network')
    }

    // A transient miss now quarantines only by AGE: maxAgeMs 500 with the stale
    // snapshot stamp 1000 vs now 2000 → it WOULD markFailed(stale 1000), but the CAS
    // sees the live stamp moved to 2000 and drops the write.
    await drainUploads(USER, deps({ maxAgeMs: 500 }))

    expect(await store.get(USER, BLOCK)).toMatchObject({ status: 'staged', attempts: 0, stagedAt: 2000 })
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

    expect(blobStore.puts).toHaveLength(1)
    expect(await store.get('u1', 'media:a')).toBeNull() // uploaded
    expect((await store.get('u2', 'media:b'))?.status).toBe('pending') // untouched
  })

  // Addresses are derived when used (docs/workspace-e2ee-conversion.md §6.2): the
  // record's contentKey names its local bytes, never where they go.
  describe('the address, derived when used', () => {
    it('uploads to the address the hash and the live mode give, reading bytes under the record key', async () => {
      await store.stage(stageInput({ contentKey: 'local-name' }))
      await store.promote(USER, BLOCK)
      await byteStore.put(USER, WS, 'local-name', bytes(8))

      await drainUploads(USER, deps())

      expect(blobStore.puts.map(p => p.contentKey)).toEqual([KEY])
    })

    it('a record captured plaintext uploads sealed to the KEYED address once the workspace is e2ee', async () => {
      const key = await aesKey()
      const plain = bytes(12)
      const contentHash = await computeContentHash(plain)
      const raw = contentHash.slice('sha256:'.length)
      await store.stage(stageInput({ contentHash, contentKey: raw }))
      await store.promote(USER, BLOCK)
      await byteStore.put(USER, WS, raw, plain)

      await drainUploads(USER, deps({
        getMaterializability: mat('decrypt'),
        getCek: async () => key,
        getContentKeyHmac: async () => kid,
      }))

      const keyed = await deriveContentKey({ contentHash, mode: 'e2ee', contentKeyHmac: kid })
      expect(blobStore.puts.map(p => p.contentKey)).toEqual([keyed])
      const opened = await verifyObjectBytes(blobStore.puts[0].bytes, 'e2ee', async () => key, { contentHash, workspaceId: WS })
      expect(opened.ok && [...opened.plaintext]).toEqual([...plain])
    })

    it('verifies a 409 at the derived address', async () => {
      const plain = bytes(24)
      const contentHash = await computeContentHash(plain)
      await store.stage(stageInput({ contentHash, contentKey: 'local-name' }))
      await store.promote(USER, BLOCK)
      await byteStore.put(USER, WS, 'local-name', plain)
      blobStore.existing = plain

      expect(await drainUploads(USER, deps())).toMatchObject({ uploaded: 1 })
      expect(blobStore.gets).toEqual([contentHash.slice('sha256:'.length)])
    })

    it('an e2ee workspace whose key record has no K_id waits (no attempt burn)', async () => {
      await store.stage(stageInput())
      await store.promote(USER, BLOCK)
      await byteStore.put(USER, WS, KEY, bytes(8))

      const summary = await drainUploads(USER, deps({ getMaterializability: mat('decrypt'), getCek: async () => aesKey() }))

      expect(summary).toMatchObject({ deferred: 1 })
      expect(blobStore.puts).toHaveLength(0)
      expect(await store.get(USER, BLOCK)).toMatchObject({ status: 'pending', attempts: 0 })
    })

    it('a malformed hash can never upload: failed at once', async () => {
      await store.stage(stageInput({ contentHash: 'sha256:nothex' }))
      await store.promote(USER, BLOCK)
      await byteStore.put(USER, WS, KEY, bytes(8))

      expect(await drainUploads(USER, deps())).toMatchObject({ failed: 1 })
      expect(blobStore.puts).toHaveLength(0)
    })
  })

  // The synced mode lags the server whenever this device's ps_crud is non-empty,
  // so a plaintext upload confirms the server's mode first.
  describe('the live-mode check before a plaintext upload', () => {
    const pending = async () => {
      await store.stage(stageInput())
      await store.promote(USER, BLOCK)
      await byteStore.put(USER, WS, KEY, bytes(8))
    }

    it('a server that now says e2ee defers the upload, with no attempt burn', async () => {
      await pending()
      const summary = await drainUploads(USER, deps({ readLiveWorkspace: live('e2ee') }))
      expect(summary).toMatchObject({ deferred: 1, uploaded: 0 })
      expect(blobStore.puts).toHaveLength(0)
      expect(await store.get(USER, BLOCK)).toMatchObject({ status: 'pending', attempts: 0 })
    })

    it('an unreadable server mode defers too', async () => {
      await pending()
      expect(await drainUploads(USER, deps({ readLiveWorkspace: unavailable })))
        .toMatchObject({ deferred: 1 })
      expect(blobStore.puts).toHaveLength(0)
    })

    it('a workspace this session can no longer see goes to the PUT, which fails it at once as before', async () => {
      // The same membership gates the row and the PUT, so the upload is refused
      // (403, permanent) rather than stored — not deferred out of sight for days.
      await pending()
      blobStore.fail = () => { throw new BlobPutError('forbidden', true) }
      expect(await drainUploads(USER, deps({ readLiveWorkspace: async () => ({ kind: 'not-visible' as const }) })))
        .toMatchObject({ failed: 1 })
    })

    it('an unreadable mode still ages out like any transient failure', async () => {
      await pending()
      clock += 8 * 24 * 60 * 60 * 1000
      expect(await drainUploads(USER, deps({ readLiveWorkspace: unavailable })))
        .toMatchObject({ failed: 1 })
    })

    it('a sealed upload does not ask: it is safe whatever the server says', async () => {
      await pending()
      let asked = 0
      await drainUploads(USER, deps({
        getMaterializability: mat('decrypt'),
        getCek: async () => aesKey(),
        getContentKeyHmac: async () => kid,
        readLiveWorkspace: async () => { asked += 1; return live('none')() },
      }))
      expect(asked).toBe(0)
      expect(blobStore.puts).toHaveLength(1)
    })
  })
})
