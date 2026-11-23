import { expect, it, vi } from 'vitest'
import { getAssetResolverForUser } from './assetResolver.js'
import { getMediaLanesForUser } from './assetUpload.js'
import { getByteStore } from './byteStore.js'
import { getByteUploadStore } from './uploadStore.js'

const session = vi.hoisted(() => ({
  userId: '',
  remote: false,
  upload: vi.fn<() => Promise<{ error: null }>>(),
}))

vi.mock('@/data/repoProvider.js', () => ({
  getActiveUserId: () => session.userId,
  isRemoteSyncActive: () => session.remote,
  syncResolverForUser: () => ({
    getMaterializability: async () => 'copy',
    getCek: async () => null,
    getContentKeyHmac: async () => null,
  }),
}))
vi.mock('@/services/supabase.js', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: 'test-token' } } }) },
    storage: { from: () => ({ upload: session.upload }) },
  },
}))
vi.mock('@/data/workspaceConversion.js', () => ({
  fetchWorkspaceConversionState: async () => ({
    kind: 'read',
    state: { encryptionMode: 'none', conversionPhase: null, wkCanary: null, ownerUserId: session.userId },
  }),
}))
vi.mock('./byteStore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./byteStore.js')>()
  const store = new actual.InMemoryByteStore()
  return { ...actual, getByteStore: () => store }
})
vi.mock('./uploadStore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./uploadStore.js')>()
  const store = new actual.InMemoryByteUploadStore()
  return { ...actual, getByteUploadStore: () => store }
})

const workspaceId = 'workspace'
const enqueue = async (userId: string, n: number, withBytes: boolean) => {
  const assetBlockId = `block-${n}`
  const contentKey = String(n).repeat(64)
  const store = getByteUploadStore()
  if (withBytes) await getByteStore().put(userId, workspaceId, contentKey, new Uint8Array([n]))
  await store.stage({ userId, workspaceId, assetBlockId, contentKey, contentHash: `sha256:${contentKey}` })
  await store.promote(userId, assetBlockId)
}

it.each([
  ['account changes', () => { session.userId = 'another-user' }],
  ['remote sync turns off', () => { session.remote = false }],
] as const)('preserves pending records when %s mid-pass', async (transition, switchSession) => {
  const userId = transition === 'account changes' ? 'first-user' : 'second-user'
  session.userId = userId
  session.remote = false
  session.upload.mockReset().mockImplementationOnce(async () => {
    switchSession()
    return { error: null }
  })
  const lanes = getMediaLanesForUser(userId)
  await enqueue(userId, 1, true)
  // A clean byte miss would quarantine this record if the per-record gate let it run.
  await enqueue(userId, 2, false)

  session.remote = true
  expect(getAssetResolverForUser(userId)).toBe(lanes.resolver)
  await lanes.drain()

  expect(session.upload).toHaveBeenCalledTimes(1)
  expect(await lanes.counts()).toEqual({ staged: 0, pending: 1, failed: 0 })
})
