// @vitest-environment node
import {PowerSyncDatabase} from '@powersync/node'
import {createClientPowerSyncSchema, initializeClientDatabase} from '@/data/internals/initializeClientDatabase'
import {randomUUID} from 'node:crypto'
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest'
import type {KnownAgentCommand} from '@knowledge-medium/agent-cli/protocol'
import {createTestDb, resetTestDb} from '@/data/test/createTestDb'
import {clearSyncState, serverWorkspace, stagedBlock, syncServer, testWorkspaceRow} from '@/data/test/syncCheckpoint'
import {mintWorkspaceKey} from '@/sync/keys/mintWorkspaceKey'
import {getWorkspaceKeyStore} from '@/sync/keys/keyStore'
import {encryptUploadColumns} from '@/sync/transform'
import {RECONCILE_RESCAN_MARKER_PREFIX} from '@/data/internals/clientSchema'
import {stubLocalStorage} from '@/data/test/e2eeFixtures'
import {serveDatabase} from './host'
import {assertReadSurface} from './test/readSurface'
import type {HeadlessConfig} from './config'

const workspaceId = 'scratch'
const user = {id: 'member', name: 'Test'}
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
  // The core supplies the checkpoint, timestamps and all raw rows. Its test
  // transport has no socket, so only the connection bit is supplied here.
  vi.spyOn(Object.getPrototypeOf(fixture.db.currentStatus), 'connected', 'get').mockReturnValue(true)
})
afterEach(async () => {
  await getWorkspaceKeyStore().delete(user.id, workspaceId)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
afterAll(async () => { await fixture.cleanup() })

function start(config: HeadlessConfig, connect: () => Promise<void>, db = fixture.db) {
  const controller = new AbortController()
  type Execute = (cmd: KnownAgentCommand) => Promise<unknown>
  let registered!: (execute: Execute) => void
  const ready = new Promise<Execute>(resolve => { registered = resolve })
  const run = serveDatabase(db, config, user, controller.signal, connect, async (_c, _u, execute) => {
    registered(execute)
    return {postEvent: async () => {}, close: async () => {}}
  })
  return {
    execute: (cmd: KnownAgentCommand) => Promise.race([ready, run.then(() => { throw new Error('Host stopped') })]).then(fn => fn(cmd)),
    stop: () => { controller.abort(); return run },
  }
}

const plaintext = (): HeadlessConfig => ({mode: 'plaintext', workspaceId, profile: 'fixture', stateDir: fixture.dir})

it.each(['e2ee', 'plaintext'] as const)('serves the complete %s cold download without queuing writes or returning device secrets', async mode => {
  const config = plaintext()
  const key = await mintWorkspaceKey(workspaceId)
  const keyFile = join(fixture.dir, 'fixture-key')
  await writeFile(keyFile, key.displayed, {mode: 0o600})
  const ws = testWorkspaceRow(workspaceId)
  const id = randomUUID()
  const block = stagedBlock(id, workspaceId)
  const deviceValue = 'synthetic-private-session'
  localStorage.setItem('session', deviceValue)
  const encrypted = mode === 'e2ee'
  const data = encrypted ? await encryptUploadColumns(id, workspaceId, block.data, 'e2ee', async () => key.record.wk) : block.data
  const deliver = syncServer(fixture.db)
  const serverRows = [
    serverWorkspace({...ws, encryption_mode: encrypted ? 'e2ee' : 'none', wk_canary: encrypted ? key.canary : null}),
    member, {...block, data},
  ]
  const host = start(encrypted ? {...config, mode, keyFile} : config, async () => {
    await deliver(serverRows, {complete: false})
    expect(await fixture.db.getOptional('SELECT id FROM workspaces WHERE id = ?', [workspaceId])).toBeNull()
    await deliver([])
  })
  try {
    await vi.waitFor(async () => {
      expect(await host.execute({type: 'get-block', id})).toMatchObject({id, content: id})
    }, {timeout: 5000})
    // A bulk first load omits create history. A later server edit records a
    // history event on this device and exercises block-history's success path.
    await deliver([{...block, data: {...data, updated_at: 2, user_updated_at: 2}}])
    await vi.waitFor(async () => expect(await fixture.db.getOptional('SELECT 1 FROM row_events WHERE block_id = ?', [id])).toBeTruthy())
    await assertReadSurface(host.execute, id, {deviceValue, workspaceKey: key.displayed})
  } finally {
    await host.stop()
  }
  expect(await fixture.db.get('SELECT count(*) AS n FROM ps_crud')).toEqual({n: 0})
}, 20_000)

it('keeps a warm persisted checkpoint closed, opens on a new checkpoint, and closes on membership loss', async () => {
  const deliver = syncServer(fixture.db)
  await deliver([serverWorkspace(testWorkspaceRow(workspaceId)), member])
  const stamp = fixture.db.currentStatus.lastSyncedAt?.getTime()
  expect(stamp).toEqual(expect.any(Number))
  const host = start(plaintext(), async () => {})
  try {
    const read = () => host.execute({type: 'sql', sql: 'SELECT 1 AS n'})
    await expect(read()).rejects.toThrow('Waiting for a checkpoint')
    expect(await host.execute({type: 'health'})).toMatchObject({host: {baselineSyncedAt: stamp, lastSyncedAt: stamp}})
    await vi.waitFor(async () => {
      await deliver([stagedBlock(randomUUID(), workspaceId)])
      expect(fixture.db.currentStatus.lastSyncedAt?.getTime()).not.toBe(stamp)
    })
    await expect(read()).resolves.toEqual([{n: 1}])
    await fixture.db.execute('DELETE FROM workspace_members WHERE id = ?', [member.id])
    await expect(read()).rejects.toThrow('Waiting for the local member row')
  } finally {
    await host.stop()
  }
}, 20_000)

it('holds a rejoining member behind a durable materialization gap until repaired', async () => {
  const id = randomUUID()
  const deliver = syncServer(fixture.db)
  const host = start(plaintext(), () => deliver([serverWorkspace(testWorkspaceRow(workspaceId)), member, stagedBlock(id, workspaceId)]))
  try {
    const read = () => host.execute({type: 'get-block', id})
    await vi.waitFor(async () => expect(await read()).toMatchObject({id}))
    await fixture.db.execute('DELETE FROM workspace_members WHERE id = ?', [member.id])
    await expect(read()).rejects.toThrow('local member row')
    await vi.waitFor(async () => expect(await fixture.db.getOptional(
      'SELECT 1 FROM client_schema_state WHERE key = ?', [RECONCILE_RESCAN_MARKER_PREFIX + workspaceId],
    )).toBeTruthy())
    await fixture.db.writeTransaction(async tx => {
      await tx.execute('UPDATE blocks_synced SET needs_apply = 1 WHERE id = ?', [id])
      await tx.execute('INSERT INTO workspace_members (id, workspace_id, user_id, role, create_time) VALUES (?, ?, ?, ?, 1)',
        [member.id, workspaceId, user.id, 'editor'])
    })
    expect(await fixture.db.get('SELECT needs_apply FROM blocks_synced WHERE id = ?', [id])).toEqual({needs_apply: 1})
    await expect(read()).rejects.toThrow('have not been verified locally')
    await host.execute({type: 'rematerialize-workspace'})
    await expect(read()).resolves.toMatchObject({id})
  } finally {
    await host.stop()
  }
})

it('preserves an existing upload queue and refuses before connecting', async () => {
  await fixture.db.execute("INSERT INTO ps_crud (data) VALUES ('{}')")
  const connect = vi.fn(async () => {})
  const run = serveDatabase(fixture.db, plaintext(), user, new AbortController().signal, connect)
  await expect(run).rejects.toThrow('queued writes')
  expect(connect).not.toHaveBeenCalled()
  expect(await fixture.db.get('SELECT data FROM ps_crud')).toEqual({data: '{}'})
})

it('samples the persisted checkpoint only after the reopened database is ready', async () => {
  const reopen = () => new PowerSyncDatabase({
    schema: createClientPowerSyncSchema(),
    database: {dbLocation: fixture.dir, dbFilename: 'warm.db', readWorkerCount: 1},
  })
  const first = reopen()
  let persisted: number | undefined
  try {
    await first.waitForReady()
    await initializeClientDatabase(first, 'node')
    await syncServer(first)([serverWorkspace(testWorkspaceRow(workspaceId)), member])
    persisted = first.currentStatus.lastSyncedAt?.getTime()
    expect(persisted).toEqual(expect.any(Number))
  } finally {
    await first.close()
  }

  const second = reopen()
  expect(second.currentStatus.lastSyncedAt).toBeUndefined()
  const host = start(plaintext(), async () => {}, second)
  try {
    expect(await host.execute({type: 'health'})).toMatchObject({host: {
      baselineSyncedAt: persisted, lastSyncedAt: persisted,
    }})
    await expect(host.execute({type: 'sql', sql: 'SELECT 1'})).rejects.toThrow('Waiting for a checkpoint')
  } finally {
    await host.stop()
    await second.close()
  }
})
