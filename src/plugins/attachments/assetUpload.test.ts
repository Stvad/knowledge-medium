import { expect, it, vi } from 'vitest'
import { getAssetResolverForUser } from './assetResolver.js'
import { getMediaLanesForUser } from './assetUpload.js'
import { getByteStore } from './byteStore.js'
import { refreshUploadLaneStatus, uploadLaneDiagnosticSource } from './uploadLaneStatus.js'
import { getByteUploadStore } from './uploadStore.js'

const session = vi.hoisted(() => ({
  userId: '',
  remote: false,
  upload: vi.fn<() => Promise<{ error: { status: number } | null }>>(),
  download: vi.fn(),
  onReadWorkspace: vi.fn(),
  lockNames: [] as string[],
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
    storage: { from: () => ({ upload: session.upload, download: session.download }) },
  },
}))
vi.mock('@/data/workspaceConversion.js', () => ({
  fetchWorkspaceConversionState: async () => {
    session.onReadWorkspace()
    return {
      kind: 'read',
      state: { encryptionMode: 'none', conversionPhase: null, wkCanary: null, ownerUserId: session.userId },
    }
  },
}))
vi.mock('@/utils/webLock.js', () => ({
  withLock: async (name: string, work: () => Promise<void>) => {
    session.lockNames.push(name)
    await work()
  },
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

it('defers an aged upload if its account changes before the PUT', async () => {
  const userId = session.userId = 'aged-user'
  session.remote = true
  session.upload.mockReset()
  session.onReadWorkspace.mockImplementationOnce(() => { session.userId = 'another-user' })
  await enqueue(userId, 1, true)
  const store = getByteUploadStore()
  const record = await store.get(userId, 'block-1')
  expect(record).toMatchObject({ status: 'pending' })
  const clock = vi.spyOn(Date, 'now').mockReturnValue(record!.stagedAt + 8 * 24 * 60 * 60 * 1000)
  try {
    await getMediaLanesForUser(userId).drain()
    expect(session.upload).not.toHaveBeenCalled()
    expect(await store.get(userId, 'block-1')).toEqual(record)
  } finally {
    clock.mockRestore()
  }
})

it('keeps the last attempt if its account changes before verification', async () => {
  const userId = session.userId = 'verifying-user'
  session.remote = true
  session.download.mockClear()
  session.upload.mockReset().mockImplementationOnce(async () => {
    session.userId = 'another-user'
    return { error: { status: 409 } }
  })
  await enqueue(userId, 1, true)
  const store = getByteUploadStore()
  for (let attempts = 0; attempts < 7; attempts += 1) await store.recordAttempt(userId, 'block-1')
  const record = await store.get(userId, 'block-1')
  expect(record).toMatchObject({ status: 'pending', attempts: 7 })

  await getMediaLanesForUser(userId).drain()

  expect(session.upload).toHaveBeenCalledOnce()
  expect(session.download).not.toHaveBeenCalled()
  expect(await store.get(userId, 'block-1')).toEqual(record)
})

it('takes the browser lane lock and publishes a failed upload to diagnostics', async () => {
  const userId = session.userId = 'diagnostic-user'
  session.remote = true
  session.lockNames.length = 0
  await refreshUploadLaneStatus(getByteUploadStore(), null)
  expect(uploadLaneDiagnosticSource.getSnapshot()).toBeNull()
  await enqueue(userId, 1, false)

  await getMediaLanesForUser(userId).drain()

  expect(session.lockNames).toEqual([`km-asset-upload-lane:${userId}`])
  expect(uploadLaneDiagnosticSource.getSnapshot()?.summary).toBe('1 media upload failed')
})
