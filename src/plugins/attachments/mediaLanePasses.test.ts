import { expect, it, vi } from 'vitest'
import { NO_REMOTE_BLOB_STORE, type BlobStore } from './blobStore.js'
import { InMemoryByteStore } from './byteStore.js'
import { createMediaLanes, type MediaLaneDeps } from './mediaLanes.js'
import { InMemoryByteUploadStore } from './uploadStore.js'

const USER = 'user'
const WS = 'workspace'
const contentKey = (n: number) => String(n).repeat(64)

const setup = () => {
  const uploadStore = new InMemoryByteUploadStore()
  const byteStore = new InMemoryByteStore()
  const open = (blobStore: Partial<BlobStore>, hooks: Partial<Pick<MediaLaneDeps, 'exclusive' | 'afterPass' | 'canDrain'>> = {}) =>
    createMediaLanes({
      userId: USER,
      uploadStore,
      byteStore,
      blobStore: { ...NO_REMOTE_BLOB_STORE, ...blobStore },
      keys: {
        getMaterializability: async () => 'copy' as const,
        getCek: async () => null,
        getContentKeyHmac: async () => null,
      },
      readLiveWorkspace: async () => ({
        kind: 'read',
        state: { encryptionMode: 'none', conversionPhase: null, wkCanary: null, ownerUserId: USER },
      }),
      canDrain: () => true,
      ...hooks,
    })
  const enqueue = async (n: number) => {
    const key = contentKey(n)
    const id = `block-${n}`
    await byteStore.put(USER, WS, key, new Uint8Array([n]))
    await uploadStore.stage({
      userId: USER, workspaceId: WS, assetBlockId: id, contentKey: key, contentHash: `sha256:${key}`,
    })
    await uploadStore.promote(USER, id)
    return id
  }
  return { open, enqueue, uploadStore }
}

it('probes failed uploads and drains requeued bytes in one lock acquisition', async () => {
  const { open, enqueue, uploadStore } = setup()
  const id = await enqueue(1)
  await uploadStore.markFailed(USER, id)
  expect(await uploadStore.countByStatus(USER, 'failed')).toBe(1)

  const events: string[] = []
  const lanes = open({
    async probe(_workspaceId, key) {
      events.push(`probe:${key}`)
      return null
    },
    async put(_workspaceId, key) {
      events.push(`put:${key}`)
      return 'written'
    },
  }, {
    async exclusive(work) {
      events.push('acquire')
      try {
        await work()
      } finally {
        events.push('release')
      }
    },
  })

  await lanes.recover(async () => 'test-token')

  expect(events).toEqual(['acquire', `probe:${contentKey(1)}`, `put:${contentKey(1)}`, 'release'])
  expect(await uploadStore.get(USER, id)).toBeNull()
})

it('keeps a failed record quarantined when recovery has no session token', async () => {
  const { open, enqueue, uploadStore } = setup()
  const id = await enqueue(1)
  await uploadStore.markFailed(USER, id)
  const probe = vi.fn(async () => null)
  const lanes = open({ probe, put: async () => 'written' })

  await lanes.recover(async () => null)

  expect(probe).not.toHaveBeenCalled()
  expect(await uploadStore.get(USER, id)).toMatchObject({ status: 'failed' })
})

it('skips the recovery lock and status refresh while uploads are held', async () => {
  const { open, enqueue, uploadStore } = setup()
  const id = await enqueue(1)
  await uploadStore.markFailed(USER, id)
  const exclusive = vi.fn(async (work: () => Promise<void>) => work())
  const afterPass = vi.fn(async () => {})
  const lanes = open({}, { canDrain: () => false, exclusive, afterPass })

  await lanes.recover(async () => 'test-token')

  expect(exclusive).not.toHaveBeenCalled()
  expect(afterPass).not.toHaveBeenCalled()
  expect(await uploadStore.get(USER, id)).toMatchObject({ status: 'failed' })
})

it('publishes the resulting queue state before releasing the drain lock', async () => {
  const { open, enqueue, uploadStore } = setup()
  await enqueue(1)
  expect(await uploadStore.countByStatus(USER, 'pending')).toBe(1)

  let locked = false
  const observed: { locked: boolean; pending: number }[] = []
  const lanes = open({ put: async () => 'written' }, {
    async exclusive(work) {
      locked = true
      try {
        await work()
      } finally {
        locked = false
      }
    },
    async afterPass() {
      observed.push({ locked, pending: await uploadStore.countByStatus(USER, 'pending') })
    },
  })

  await lanes.drain()

  expect(observed).toEqual([{ locked: true, pending: 0 }])
})

it('coalesces overlapping arms into one follow-up scan that uploads late records', async () => {
  const { open, enqueue, uploadStore } = setup()
  await enqueue(1)
  let startUpload!: () => void
  let finishUpload!: () => void
  const uploading = new Promise<void>(resolve => { startUpload = resolve })
  const finish = new Promise<void>(resolve => { finishUpload = resolve })
  const scans = vi.spyOn(uploadStore, 'listByStatus')
  const writes: string[] = []
  const lanes = open({
    async put(_workspaceId, key) {
      if (key === contentKey(1)) {
        startUpload()
        await finish
      }
      writes.push(key)
      return 'written'
    },
  })

  const first = lanes.drain()
  await uploading
  const lateId = await enqueue(2)
  const overlapping = [lanes.drain(), lanes.drain(), lanes.drain()]
  finishUpload()
  await Promise.all([first, ...overlapping])

  expect(scans.mock.calls).toEqual([[USER, 'pending'], [USER, 'pending']])
  expect(writes).toEqual([contentKey(1), contentKey(2)])
  expect(await uploadStore.get(USER, lateId)).toBeNull()
})
