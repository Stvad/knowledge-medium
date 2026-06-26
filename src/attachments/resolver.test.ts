import { describe, expect, it, vi } from 'vitest'
import { createAssetResolver, type AssetResolverDeps } from './resolver.js'
import { InMemoryByteStore } from './byteStore.js'
import type { BlobStore } from './blobStore.js'
import { encodeBytes } from '../sync/byteTransform.js'
import { computeContentHash } from '../sync/crypto/contentHash.js'
import { deriveContentKey, deriveContentKeyHmac } from '../sync/crypto/contentKey.js'
import { importWorkspaceKey } from '../sync/crypto/workspaceKey.js'
import type { GetCek, Materializability, SyncMode } from '../sync/transform.js'

const USER = 'user-1'
const WS = 'ws-A'
const WK_BYTES = new Uint8Array(32).fill(7)

// One real WK + its derived K_id, shared across the e2ee cases.
const wk = await importWorkspaceKey(WK_BYTES)
const kid = await deriveContentKeyHmac(WK_BYTES)
const getCek: GetCek = async () => wk

const bytes = (...vals: number[]) => new Uint8Array(vals)
const hashOf = (b: Uint8Array<ArrayBuffer>) => computeContentHash(b)
/** A typed materializability thunk (a bare `mat('copy')` widens to string). */
const mat = (m: Materializability) => async (): Promise<Materializability> => m

/** Seal bytes exactly as the up-lane would (§5): identity for plaintext, an
 *  `encb:v1:` envelope (AAD-bound to `contentHash`) for e2ee. */
const seal = (mode: SyncMode, b: Uint8Array<ArrayBuffer>, contentHash: string) =>
  encodeBytes(b, mode, getCek, { contentHash, workspaceId: WS })

const contentKeyFor = (mode: SyncMode, contentHash: string) =>
  deriveContentKey({ contentHash, mode, contentKeyHmac: mode === 'e2ee' ? kid : null })

/** A BlobStore whose GET returns `serve()` (or throws it). Only `get` is used. */
const fakeBlob = (serve: () => Promise<Uint8Array<ArrayBuffer>>): { store: BlobStore; get: ReturnType<typeof vi.fn> } => {
  const get = vi.fn(serve)
  const store = { get, put: vi.fn(), delete: vi.fn() } as unknown as BlobStore
  return { store, get }
}

const build = (over: Partial<AssetResolverDeps> & { serve?: () => Promise<Uint8Array<ArrayBuffer>> } = {}) => {
  const byteStore = over.byteStore ?? new InMemoryByteStore()
  const { store: blobStore, get } = fakeBlob(over.serve ?? (async () => bytes(0)))
  const resolver = createAssetResolver({
    getUserId: () => USER,
    byteStore,
    blobStore: over.blobStore ?? blobStore,
    getMaterializability: over.getMaterializability ?? (async (): Promise<Materializability> => 'copy'),
    getCek: over.getCek ?? getCek,
    getContentKeyHmac: over.getContentKeyHmac ?? (async () => kid),
  })
  return { resolver, byteStore, blobGet: get }
}

describe('createAssetResolver — happy paths', () => {
  it('plaintext: fetch on miss → verify → store → serve, and the next resolve is a local hit', async () => {
    const plain = bytes(1, 2, 3, 4)
    const contentHash = await hashOf(plain)
    const served = await seal('none', plain, contentHash)
    const { resolver, byteStore, blobGet } = build({
      getMaterializability: mat('copy'),
      serve: async () => served,
    })

    const r = await resolver.resolve({ workspaceId: WS, contentHash })
    expect(r).toEqual({ ok: true, bytes: plain })

    // Stored under the plaintext content-key (raw sha256), so a 2nd resolve is local.
    const key = await contentKeyFor('none', contentHash)
    expect(await byteStore.has(USER, WS, key)).toBe(true)
    blobGet.mockClear()
    await resolver.resolve({ workspaceId: WS, contentHash })
    expect(blobGet).not.toHaveBeenCalled()
  })

  it('e2ee: fetch ciphertext → decrypt → verify → store → serve the plaintext', async () => {
    const plain = bytes(9, 8, 7, 6, 5)
    const contentHash = await hashOf(plain)
    const served = await seal('e2ee', plain, contentHash)
    const { resolver, byteStore } = build({
      getMaterializability: mat('decrypt'),
      serve: async () => served,
    })

    const r = await resolver.resolve({ workspaceId: WS, contentHash })
    expect(r).toEqual({ ok: true, bytes: plain })
    const key = await contentKeyFor('e2ee', contentHash)
    expect(await byteStore.get(USER, WS, key)).toEqual(plain) // decrypted at rest
  })

  it('serves a local hit WITHOUT fetching (already verified when stored, §8)', async () => {
    const plain = bytes(4, 2)
    const contentHash = await hashOf(plain)
    const byteStore = new InMemoryByteStore()
    await byteStore.put(USER, WS, await contentKeyFor('e2ee', contentHash), plain)
    const { resolver, blobGet } = build({ getMaterializability: mat('decrypt'), byteStore })

    expect(await resolver.resolve({ workspaceId: WS, contentHash })).toEqual({ ok: true, bytes: plain })
    expect(blobGet).not.toHaveBeenCalled()
  })

  it('still serves the verified bytes when the cache write fails (quota) — render is not denied', async () => {
    const plain = bytes(1, 1)
    const contentHash = await hashOf(plain)
    const failingPut = new InMemoryByteStore()
    vi.spyOn(failingPut, 'put').mockRejectedValue(new Error('QuotaExceededError'))
    const { resolver } = build({
      getMaterializability: mat('copy'),
      byteStore: failingPut,
      serve: async () => seal('none', plain, contentHash),
    })
    expect(await resolver.resolve({ workspaceId: WS, contentHash })).toEqual({ ok: true, bytes: plain })
  })
})

describe('createAssetResolver — fail-closed (the §7.3/§5.1 acceptance gate)', () => {
  it('defer → deferred, with NO fetch and NO passthrough', async () => {
    const { resolver, blobGet } = build({ getMaterializability: mat('defer') })
    expect(await resolver.resolve({ workspaceId: WS, contentHash: await hashOf(bytes(1)) })).toEqual({
      ok: false,
      reason: 'deferred',
    })
    expect(blobGet).not.toHaveBeenCalled()
  })

  it('signed out → deferred, touching nothing', async () => {
    const { store: blobStore, get } = fakeBlob(async () => bytes(0))
    const resolver = createAssetResolver({
      getUserId: () => null,
      byteStore: new InMemoryByteStore(),
      blobStore,
      getMaterializability: mat('copy'),
      getCek,
      getContentKeyHmac: async () => kid,
    })
    expect(await resolver.resolve({ workspaceId: WS, contentHash: await hashOf(bytes(1)) })).toEqual({
      ok: false,
      reason: 'deferred',
    })
    expect(get).not.toHaveBeenCalled()
  })

  it('e2ee with no K_id → no-content-key, with NO fetch (the §10 re-paste migration)', async () => {
    const { resolver, blobGet } = build({
      getMaterializability: mat('decrypt'),
      getContentKeyHmac: async () => null,
    })
    expect(await resolver.resolve({ workspaceId: WS, contentHash: await hashOf(bytes(1)) })).toEqual({
      ok: false,
      reason: 'no-content-key',
    })
    expect(blobGet).not.toHaveBeenCalled()
  })

  it('a malformed content hash → invalid-hash, with NO fetch', async () => {
    const { resolver, blobGet } = build({ getMaterializability: mat('copy') })
    expect(await resolver.resolve({ workspaceId: WS, contentHash: 'not-a-hash' })).toEqual({
      ok: false,
      reason: 'invalid-hash',
    })
    expect(blobGet).not.toHaveBeenCalled()
  })

  it('a fetch error → fetch-failed, nothing stored', async () => {
    const plain = bytes(5)
    const contentHash = await hashOf(plain)
    const { resolver, byteStore } = build({
      getMaterializability: mat('copy'),
      serve: async () => {
        throw new Error('offline')
      },
    })
    expect(await resolver.resolve({ workspaceId: WS, contentHash })).toEqual({ ok: false, reason: 'fetch-failed' })
    expect(await byteStore.has(USER, WS, await contentKeyFor('none', contentHash))).toBe(false)
  })

  it('e2ee: a tampered / wrong-key object (AEAD fails) → decode-failed, nothing stored', async () => {
    const plain = bytes(3, 3, 3)
    const contentHash = await hashOf(plain)
    // Garbage bytes that are not a valid encb:v1: envelope → openBytes throws.
    const { resolver, byteStore } = build({
      getMaterializability: mat('decrypt'),
      serve: async () => bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10),
    })
    expect(await resolver.resolve({ workspaceId: WS, contentHash })).toEqual({ ok: false, reason: 'decode-failed' })
    expect(await byteStore.has(USER, WS, await contentKeyFor('e2ee', contentHash))).toBe(false)
  })

  it('e2ee: a poisoned object that AEAD-opens but mismatches the hash → hash-mismatch, NEVER stored', async () => {
    // The load-bearing case: the server returns DIFFERENT bytes sealed under the
    // right AAD (a poisoner who knows the content hash). The GCM tag passes; only
    // the read-side sha256 check stops it.
    const real = bytes(1, 1, 1, 1)
    const contentHash = await hashOf(real)
    const poison = bytes(2, 2, 2, 2) // hashes to something else
    const served = await seal('e2ee', poison, contentHash) // sealed under the REQUESTED hash's AAD
    const { resolver, byteStore } = build({
      getMaterializability: mat('decrypt'),
      serve: async () => served,
    })
    expect(await resolver.resolve({ workspaceId: WS, contentHash })).toEqual({ ok: false, reason: 'hash-mismatch' })
    expect(await byteStore.has(USER, WS, await contentKeyFor('e2ee', contentHash))).toBe(false)
  })

  it('plaintext: an untrusted server returning the WRONG bytes is caught by the hash check too', async () => {
    const real = bytes(1, 2, 3)
    const contentHash = await hashOf(real)
    const { resolver, byteStore } = build({
      getMaterializability: mat('copy'),
      serve: async () => bytes(9, 9, 9), // not what contentHash names
    })
    expect(await resolver.resolve({ workspaceId: WS, contentHash })).toEqual({ ok: false, reason: 'hash-mismatch' })
    expect(await byteStore.has(USER, WS, await contentKeyFor('none', contentHash))).toBe(false)
  })
})
