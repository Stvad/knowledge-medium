// Attachment records captured before an in-place conversion, drained across it
// (docs/workspace-e2ee-conversion.md §6.2): the real queue, byte store, drain,
// recovery and reconciler, with the mode the §6 resolver reports at each stage.
import { beforeEach, describe, expect, it } from 'vitest'
import { decodeBytes } from '@/sync/byteTransform.js'
import { computeContentHash } from '@/sync/crypto/contentHash.js'
import { deriveContentKey, deriveContentKeyHmac } from '@/sync/crypto/contentKey.js'
import type { GetCek, Materializability } from '@/sync/transform.js'
import type { BlobStore } from './blobStore.js'
import { InMemoryByteStore } from './byteStore.js'
import { drainUploads } from './uploadDrain.js'
import { reconcileUploads } from './uploadReconcile.js'
import { recoverFailedUploads } from './uploadRecovery.js'
import { InMemoryByteUploadStore } from './uploadStore.js'

const USER = 'u1'
const WS = 'ws-converted'

/** Storage as a map of object key → bytes, first write wins. */
class MapBlobStore implements BlobStore {
  readonly objects = new Map<string, Uint8Array<ArrayBuffer>>()
  async put(_ws: string, key: string, bytes: Uint8Array<ArrayBuffer>): Promise<'written' | 'exists'> {
    if (this.objects.has(key)) return 'exists'
    this.objects.set(key, bytes)
    return 'written'
  }
  async get(_ws: string, key: string): Promise<Uint8Array<ArrayBuffer>> {
    const found = this.objects.get(key)
    if (!found) throw new Error('404')
    return found
  }
  async probe(_ws: string, key: string): Promise<Uint8Array<ArrayBuffer> | null> {
    return this.objects.get(key) ?? null
  }
  async delete(): Promise<void> {}
}

const kid = await deriveContentKeyHmac(new Uint8Array(32).fill(9) as Uint8Array<ArrayBuffer>)
const wk = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt'])
const getCek: GetCek = async () => wk

let store: InMemoryByteUploadStore
let byteStore: InMemoryByteStore
let blobStore: MapBlobStore

interface Captured {
  readonly assetBlockId: string
  readonly plain: Uint8Array<ArrayBuffer>
  readonly contentHash: string
}

/** Capture in a plaintext workspace: bytes and record under the RAW name. */
const capturePlaintext = async (assetBlockId: string, seed: number): Promise<Captured> => {
  const plain = new Uint8Array([seed, seed + 1, seed + 2]) as Uint8Array<ArrayBuffer>
  const contentHash = await computeContentHash(plain)
  const contentKey = await deriveContentKey({contentHash, mode: 'none', contentKeyHmac: null})
  await byteStore.put(USER, WS, contentKey, plain)
  await store.stage({userId: USER, assetBlockId, workspaceId: WS, contentHash, contentKey})
  return {assetBlockId, plain, contentHash}
}

const laneDeps = (materializability: Materializability, liveMode: string) => ({
  store,
  byteStore,
  blobStore,
  getMaterializability: async () => materializability,
  getCek,
  getContentKeyHmac: async () => kid,
  readLiveEncryptionMode: async () => liveMode,
})

beforeEach(() => {
  store = new InMemoryByteUploadStore()
  byteStore = new InMemoryByteStore()
  blobStore = new MapBlobStore()
})

describe('attachment records across an in-place conversion', () => {
  it('nothing uploads during the mismatch, and records of every status land sealed at the keyed path after the upgrade', async () => {
    const staged = await capturePlaintext('media:staged', 10)
    const pending = await capturePlaintext('media:pending', 20)
    await store.promote(USER, pending.assetBlockId)
    const failed = await capturePlaintext('media:failed', 30)
    await store.promote(USER, failed.assetBlockId)
    await store.markFailed(USER, failed.assetBlockId)

    // The mismatch: the resolver defers this workspace.
    expect(await drainUploads(USER, laneDeps('defer', 'e2ee'))).toMatchObject({deferred: 1, uploaded: 0})
    // A stale synced mode still says plaintext; the server, read now, says e2ee.
    expect(await drainUploads(USER, laneDeps('copy', 'e2ee'))).toMatchObject({deferred: 1, uploaded: 0})
    expect(blobStore.objects.size).toBe(0)

    // The pin is upgraded: the boot reconciler promotes, recovery re-drives, the drain uploads.
    const after = laneDeps('decrypt', 'e2ee')
    await reconcileUploads(USER, {store, isBlockPresent: async () => true})
    expect(await recoverFailedUploads(USER, after)).toMatchObject({requeued: 1})
    expect(await drainUploads(USER, after)).toMatchObject({uploaded: 3, failed: 0})

    for (const record of [staged, pending, failed]) {
      const keyed = await deriveContentKey({contentHash: record.contentHash, mode: 'e2ee', contentKeyHmac: kid})
      const sealed = blobStore.objects.get(keyed)
      expect(sealed, record.assetBlockId).toBeDefined()
      expect([...sealed!]).not.toEqual([...record.plain])
      const opened = await decodeBytes(sealed!, 'e2ee', getCek, {contentHash: record.contentHash, workspaceId: WS})
      expect([...opened]).toEqual([...record.plain])
      expect(await store.get(USER, record.assetBlockId)).toBeNull()
    }
    expect(blobStore.objects.size).toBe(3)
  })
})
