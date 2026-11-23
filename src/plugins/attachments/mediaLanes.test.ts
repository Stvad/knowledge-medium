import { expect, it } from 'vitest'
import type { BlobStore } from './blobStore.js'
import { InMemoryByteStore } from './byteStore.js'
import { createMediaLanes } from './mediaLanes.js'
import { InMemoryByteUploadStore } from './uploadStore.js'

const USER = 'u1'
const WS = 'ws1'

it('stops uploading mid-pass once the client may no longer write, leaving the rest pending', async () => {
  const store = new InMemoryByteUploadStore()
  const byteStore = new InMemoryByteStore()
  for (const n of [1, 2, 3]) {
    const key = String(n).repeat(64)
    await store.stage({ userId: USER, assetBlockId: `b${n}`, workspaceId: WS, contentHash: `sha256:${key}`, contentKey: key })
    await store.promote(USER, `b${n}`)
    await byteStore.put(USER, WS, key, new Uint8Array([n]))
  }
  let writable = true
  const puts: string[] = []
  const blobStore: BlobStore = {
    put: async (_ws, key) => {
      puts.push(key)
      writable = false // demoted while this upload was in flight
      return 'written'
    },
    get: async () => { throw new Error('unused') },
    probe: async () => { throw new Error('unused') },
    delete: async () => { throw new Error('unused') },
  }
  const lanes = createMediaLanes({
    userId: USER, byteStore, uploadStore: store, blobStore,
    getAccessToken: async () => null,
    exclusive: work => work(),
    keys: { getMaterializability: async () => 'copy' as const, getCek: async () => null, getContentKeyHmac: async () => null },
    readLiveWorkspace: async () => ({
      kind: 'read', state: { encryptionMode: 'none', conversionPhase: null, wkCanary: null, ownerUserId: USER },
    }),
    canDrain: () => writable,
  })

  await lanes.drain()

  expect(puts).toHaveLength(1)
  expect(await lanes.counts()).toEqual({ staged: 0, pending: 2, failed: 0 })
})
