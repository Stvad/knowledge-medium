// @vitest-environment node
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest'
import type {PowerSyncBackendConnector} from '@powersync/common'
import type {KnownAgentCommand} from '@knowledge-medium/agent-cli/protocol'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {stubLocalStorage} from '@/data/test/e2eeFixtures'
import {clearSyncState, serverWorkspace, stagedBlock, syncServer, testWorkspaceRow} from '@/data/test/syncCheckpoint'
import * as bootstrap from '@/bootstrap/openWorkspaceData'
import {UploadHeldError} from '@/services/powersync'
import {serveDatabase} from './host'

const {rpc} = vi.hoisted(() => ({
  rpc: vi.fn(() => ({abortSignal: async () => ({error: null, status: 200})})),
}))
vi.mock('@/services/supabase', () => ({hasSupabaseAuthConfig: true, supabase: {rpc}}))

const day = 86_400_000
const workspaceId = 'workspace'
const user = {id: 'member', name: 'Test'}
const config = {mode: 'plaintext' as const, profile: 'fixture', writable: true, workspaceId, stateDir: ''}
const member = {type: 'workspace_members' as const, id: 'member', data: {
  workspace_id: workspaceId, user_id: user.id, role: 'editor', create_time: 1,
}}
let fixture: TestDb
beforeAll(async () => { fixture = await createTestDb() })
beforeEach(async () => {
  await clearSyncState(fixture.db)
  await resetTestDb(fixture.db)
  stubLocalStorage()
  vi.spyOn(Object.getPrototypeOf(fixture.db.currentStatus), 'connected', 'get').mockReturnValue(true)
})
afterEach(() => { rpc.mockClear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
afterAll(async () => { await fixture.cleanup() })

const queuePatch = async (stamp?: number) => fixture.db.execute('INSERT INTO ps_crud (data) VALUES (?)', [
  JSON.stringify({op: 'PATCH', type: 'blocks', id: crypto.randomUUID(), data: {
    workspace_id: workspaceId, content: 'pending edit', updated_at: stamp, base_updated_at: 1,
  }}),
])
const queued = () => fixture.db.getAll('SELECT * FROM ps_crud ORDER BY id')

function start(release = false) {
  const stop = new AbortController()
  let connector!: PowerSyncBackendConnector
  type Execute = (command: KnownAgentCommand) => Promise<unknown>
  let register!: (execute: Execute) => void
  const ready = new Promise<Execute>(resolve => { register = resolve })
  const run = serveDatabase(fixture.db, config, user, stop.signal,
    async (_db, production) => { connector = production! },
    async (_config, _user, execute) => {
      register(execute)
      return {close: async () => {}, postEvent: async () => {}}
    }, release)
  const execute = async (command: KnownAgentCommand) =>
    (await Promise.race([ready, run.then(() => { throw new Error('Host stopped') })]))(command)
  return {execute, upload: () => connector.uploadData(fixture.db), stop: () => { stop.abort(); return run }}
}

it('holds an eight-day edit and the fresh edits beside it, preserves the download in the oplog, and releases on restart', async () => {
  const deliver = syncServer(fixture.db)
  await deliver([serverWorkspace(testWorkspaceRow(workspaceId)), member])
  const baseline = fixture.db.currentStatus.lastSyncedAt!.getTime()
  await queuePatch(Date.now())
  await queuePatch(Date.now() - 8 * day)
  await queuePatch(Date.now())
  const before = await queued()
  const host = start()
  try {
    await expect(host.execute({type: 'health'})).resolves.toMatchObject({host: {
      readOnly: true, uploadHold: expect.stringContaining('checkpoint'), queuedEntries: 3,
    }})
    await expect(host.upload()).rejects.toBeInstanceOf(UploadHeldError)
    expect(rpc).not.toHaveBeenCalled()
    expect(await queued()).toEqual(before)
    const block = stagedBlock(crypto.randomUUID(), workspaceId)
    await deliver([block])
    expect(await fixture.db.getOptional('SELECT 1 FROM ps_oplog WHERE row_id = ?', [block.id])).toBeTruthy()
    expect(await fixture.db.getOptional('SELECT 1 FROM blocks_synced WHERE id = ?', [block.id])).toBeNull()
    expect(await host.execute({type: 'health'})).toMatchObject({host: {
      lastSyncedAt: baseline, closedReason: expect.any(String), oldestQueuedAgeMs: expect.any(Number),
    }})
    const {host: {oldestQueuedAgeMs}} = await host.execute({type: 'health'}) as {host: {oldestQueuedAgeMs: number}}
    expect(oldestQueuedAgeMs).toBeGreaterThanOrEqual(8 * day)
  } finally { await host.stop() }
  const released = start(true)
  try {
    expect(await released.execute({type: 'health'})).toMatchObject({host: {uploadHold: null, queuedEntries: 3}})
    await released.upload()
    expect(rpc).toHaveBeenCalled()
    expect(await queued()).toEqual([])
    expect(await released.execute({type: 'health'})).toMatchObject({host: {uploadHold: null, oldestQueuedAgeMs: null}})
    await queuePatch(Date.now() - 8 * day)
    await expect(released.upload()).rejects.toBeInstanceOf(UploadHeldError)
  } finally { await released.stop() }
}, 20_000)

it('uploads a queue of stamp-less patches without using their base versions as write times', async () => {
  await syncServer(fixture.db)([serverWorkspace(testWorkspaceRow(workspaceId)), member])
  await queuePatch()
  const host = start()
  try {
    expect(await host.execute({type: 'health'})).toMatchObject({host: {uploadHold: null, queuedEntries: 1, oldestQueuedAgeMs: null}})
    await host.upload()
    expect(rpc).toHaveBeenCalled()
    expect(await queued()).toEqual([])
  } finally { await host.stop() }
})

it('makes an admitted editor read-only when its next upload finds a stale write', async () => {
  // Isolate the outage from an unseeded workspace's own zero-version mints.
  vi.spyOn(bootstrap, 'openWorkspaceData').mockResolvedValue([])
  const deliver = syncServer(fixture.db)
  await deliver([serverWorkspace(testWorkspaceRow(workspaceId)), member])
  const host = start(true)
  try {
    await host.execute({type: 'health'})
    await deliver([stagedBlock(crypto.randomUUID(), workspaceId)])
    await vi.waitFor(async () => expect(await host.execute({type: 'health'})).toMatchObject({host: {
      closedReason: null, readOnly: false,
    }}), {timeout: 5000})
    await queuePatch(Date.now() - 8 * day)
    await expect(host.upload()).rejects.toBeInstanceOf(UploadHeldError)
    expect(rpc).not.toHaveBeenCalled()
    expect(await host.execute({type: 'health'})).toMatchObject({host: {
      closedReason: null, readOnly: true, uploadHold: expect.stringContaining('checkpoint'),
    }})
    await expect(host.execute({type: 'create-block', contributorId: null, content: 'held'})).rejects.toThrow('read-only mode')
  } finally { await host.stop() }
}, 20_000)

it('preserves a queued write before the first workspace row can validate its encryption mode', async () => {
  await queuePatch()
  const before = await queued()
  const connect = vi.fn(async () => { throw new Error('Unexpected connection') })
  await expect(serveDatabase(fixture.db, config, user, new AbortController().signal, connect))
    .rejects.toThrow('Queued writes without a workspace row')
  expect(connect).not.toHaveBeenCalled()
  expect(await queued()).toEqual(before)
})

it('holds a stale entry queued during the previous batch of the same upload call', async () => {
  await syncServer(fixture.db)([serverWorkspace(testWorkspaceRow(workspaceId)), member])
  await queuePatch(Date.now())
  const host = start()
  try {
    await host.execute({type: 'health'})
    rpc.mockImplementationOnce(() => ({abortSignal: async () => {
      await queuePatch(Date.now() - 8 * day)
      return {error: null, status: 200}
    }}))
    await expect(host.upload()).rejects.toBeInstanceOf(UploadHeldError)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(await queued()).toHaveLength(1)
  } finally { await host.stop() }
})

it('requires release of the stale queue present at restart, even exactly one millisecond past a week', async () => {
  await syncServer(fixture.db)([serverWorkspace(testWorkspaceRow(workspaceId)), member])
  const stamp = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(stamp + 7 * day)
  await queuePatch(stamp)
  const host = start(true)
  try {
    expect(await host.execute({type: 'health'})).toMatchObject({host: {uploadHold: null, oldestQueuedAgeMs: 7 * day}})
    clock.mockReturnValue(stamp + 7 * day + 1)
    await expect(host.upload()).rejects.toBeInstanceOf(UploadHeldError)
    expect(rpc).not.toHaveBeenCalled()
    expect(await queued()).toHaveLength(1)
  } finally { await host.stop() }
})
