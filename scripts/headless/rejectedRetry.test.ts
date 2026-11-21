// @vitest-environment node
import {randomUUID} from 'node:crypto'
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest'
import type {PowerSyncBackendConnector} from '@powersync/common'
import type {KnownAgentCommand} from '@knowledge-medium/agent-cli/protocol'
import type {RejectedUpload} from '@/data/rejectedUploads'
import {createTestDb, resetTestDb} from '@/data/test/createTestDb'
import {stubLocalStorage} from '@/data/test/e2eeFixtures'
import {clearSyncState, serverWorkspace, stagedBlock, syncServer, testWorkspaceRow} from '@/data/test/syncCheckpoint'
import {UploadHeldError} from '@/services/powersync'
import type {HeadlessConfig} from './config'
import {serveDatabase} from './host'
import {STALE_QUEUE_REASON} from './uploadHold'

const accepted = () => ({abortSignal: async () => ({error: null, status: 200})})
const {rpc} = vi.hoisted(() => ({rpc: vi.fn()}))
vi.mock('@/services/supabase', () => ({hasSupabaseAuthConfig: true, supabase: {rpc}}))

const day = 86_400_000
const workspaceId = 'workspace'
const user = {id: 'member', name: 'Test'}
const writable: HeadlessConfig = {mode: 'plaintext', profile: 'fixture', writable: true, workspaceId, stateDir: ''}
const member = {type: 'workspace_members' as const, id: 'membership', data: {
  workspace_id: workspaceId, user_id: user.id, role: 'editor', create_time: 1,
}}
let fixture: Awaited<ReturnType<typeof createTestDb>>
beforeAll(async () => { fixture = await createTestDb() })
beforeEach(async () => {
  await clearSyncState(fixture.db)
  await resetTestDb(fixture.db)
  stubLocalStorage()
  vi.stubGlobal('document', {querySelectorAll: () => [], baseURI: 'node:headless'})
  vi.spyOn(Object.getPrototypeOf(fixture.db.currentStatus), 'connected', 'get').mockReturnValue(true)
  rpc.mockImplementation(accepted)
})
afterEach(() => { rpc.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
afterAll(async () => { await fixture.cleanup() })

/** What the server answers once the account can no longer write the workspace. */
const refuseUploads = () => rpc.mockImplementation((name: string) => ({abortSignal: async () => ({
  error: Object.assign(new Error('row-level security'), {code: name === 'apply_block_patches' ? 'P0002' : '42501'}),
  status: 400,
})}))

function start(config: HeadlessConfig, blocks: string[]) {
  const {db} = fixture
  const stop = new AbortController()
  let connector!: PowerSyncBackendConnector
  type Execute = (command: KnownAgentCommand) => Promise<unknown>
  let register!: (execute: Execute) => void
  const registered = new Promise<Execute>(resolve => { register = resolve })
  const run = serveDatabase(db, config, user, stop.signal,
    async (_db, production) => {
      connector = production!
      await syncServer(db)([serverWorkspace(testWorkspaceRow(workspaceId)), member,
        ...blocks.map(id => stagedBlock(id, workspaceId))])
    },
    async (_config, _user, execute) => {
      register(execute)
      return {close: async () => {}, postEvent: async () => {}}
    })
  const ready = Promise.race([registered, run.then(() => { throw new Error('Host stopped') })])
  const execute = async (command: KnownAgentCommand) => (await ready)(command)
  return {
    execute,
    health: () => execute({type: 'health'}) as Promise<{rejectedUploads: number, host: {readOnly: boolean}}>,
    rejected: () => execute({type: 'rejected-uploads'}) as Promise<RejectedUpload[]>,
    retry: (txId: number) => execute({type: 'retry-rejected-upload', txId, contributorId: null}),
    update: (id: string, content: string) => execute({type: 'update-block', id, content, contributorId: null}),
    upload: () => connector.uploadData(db),
    untilOpen: (readOnly: boolean) => vi.waitFor(async () => expect(await execute({type: 'health'}))
      .toMatchObject({host: {closedReason: null, readOnly}}), {timeout: 15_000}),
    /** Uploads what the bootstrap queued (seed rows) so a test starts from an empty queue. */
    drainBootstrap: async () => {
      await vi.waitFor(async () => {
        await connector.uploadData(db)
        expect(await db.getAll('SELECT 1 FROM ps_crud')).toEqual([])
      }, {timeout: 20_000})
      rpc.mockClear()
    },
    stop: () => { stop.abort(); return run },
  }
}

const queued = () => fixture.db.getAll<{tx_id: number, data: string}>('SELECT tx_id, data FROM ps_crud ORDER BY id')
const quarantine = () => fixture.db.getAll('SELECT * FROM ps_crud_rejected ORDER BY id')
const setRole = (role: string) => fixture.db.execute('UPDATE workspace_members SET role = ? WHERE id = ?', [role, member.id])
const sentIds = () => JSON.stringify(rpc.mock.calls)

// Each boots a writable host and drains its seed rows: 3–9 s under load, past 10 s at load 60.
it('uploads a refused edit once after the role is restored, and refuses the retry while the role is viewer', async () => {
  const id = randomUUID()
  const host = start(writable, [id])
  try {
    await host.untilOpen(false)
    await host.drainBootstrap()
    await host.update(id, 'refused edit')
    refuseUploads()
    await host.upload()
    expect(await queued()).toEqual([])
    expect(await host.health()).toMatchObject({rejectedUploads: 1})
    expect(await fixture.db.get('SELECT content FROM blocks WHERE id = ?', [id])).toEqual({content: 'refused edit'})
    const [rejected] = await host.rejected()
    expect(rejected.rows).toEqual([expect.objectContaining({op: 'PATCH', table: 'blocks', id})])

    await setRole('viewer')
    await host.untilOpen(true)
    const kept = await quarantine()
    await expect(host.retry(rejected.txId)).rejects.toThrow('retry-rejected-upload: the member role viewer cannot write')
    expect(await quarantine()).toEqual(kept)
    expect(await queued()).toEqual([])

    await setRole('editor')
    await host.untilOpen(false)
    rpc.mockReset()
    rpc.mockImplementation(accepted)
    await expect(host.retry(rejected.txId)).resolves.toEqual({txId: rejected.txId, requeued: 1})
    await host.upload()
    await host.upload()
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('apply_block_patches', {patches: [expect.objectContaining({id, content: 'refused edit'})]})
    expect(await queued()).toEqual([])
    expect(await host.health()).toMatchObject({rejectedUploads: 0})
  } finally { await host.stop() }
}, 60_000)

it('retries a two-row transaction whole', async () => {
  const parent = randomUUID()
  const host = start(writable, [parent])
  try {
    await host.untilOpen(false)
    await host.drainBootstrap()
    await host.execute({type: 'append-markdown', target: parent, markdown: '- one\n- two', contributorId: null})
    refuseUploads()
    await host.upload()
    const rejected = await host.rejected()
    expect(rejected).toHaveLength(1)
    const [{txId, rows}] = rejected
    expect(rows.map(row => row.op)).toEqual(['PUT', 'PUT'])

    rpc.mockReset()
    rpc.mockImplementation(accepted)
    await expect(host.retry(txId)).resolves.toEqual({txId, requeued: 2})
    expect((await queued()).map(row => row.tx_id)).toEqual([txId, txId])
    expect(await quarantine()).toEqual([])
    await host.upload()
    expect(rpc).toHaveBeenCalledTimes(1)
    for (const {id} of rows) expect(sentIds()).toContain(id)
    expect(await host.health()).toMatchObject({rejectedUploads: 0})
  } finally { await host.stop() }
}, 60_000)

const quarantineRecord = (id: string) => fixture.db.execute(
  'INSERT INTO ps_crud_rejected (original_id, tx_id, data, rejected_at) VALUES (1, 42, ?, 1)',
  [JSON.stringify({op: 'PATCH', type: 'blocks', id, data: {workspace_id: workspaceId, content: 'refused'}})])

it('refuses a retry on a host configured writable: false', async () => {
  const id = randomUUID()
  const host = start({...writable, writable: false}, [id])
  try {
    await host.untilOpen(true)
    await quarantineRecord(id)
    const kept = await quarantine()
    await expect(host.retry(42)).rejects.toThrow('retry-rejected-upload: the host is configured with writable: false')
    expect(await quarantine()).toEqual(kept)
    expect(await queued()).toEqual([])
  } finally { await host.stop() }
}, 60_000)

it('refuses a retry while the stale-queue hold holds uploads', async () => {
  const id = randomUUID()
  const host = start(writable, [id])
  try {
    await host.untilOpen(false)
    await host.drainBootstrap()
    await host.update(id, 'queued edit')
    await quarantineRecord(id)
    const {first_seen_ms: firstSeen} = await fixture.db.get<{first_seen_ms: number}>('SELECT first_seen_ms FROM headless_upload_head')
    vi.spyOn(Date, 'now').mockReturnValue(firstSeen + 8 * day)
    await expect(host.upload()).rejects.toBeInstanceOf(UploadHeldError)
    const [before, kept] = [await queued(), await quarantine()]
    await expect(host.retry(42)).rejects.toThrow(`retry-rejected-upload: ${STALE_QUEUE_REASON}`)
    expect(await quarantine()).toEqual(kept)
    expect(await queued()).toEqual(before)
  } finally { await host.stop() }
}, 60_000)
