// @vitest-environment node
import {PowerSyncDatabase} from '@powersync/node'
import {createClientPowerSyncSchema, initializeClientDatabase} from '@/data/internals/initializeClientDatabase'
import {randomUUID} from 'node:crypto'
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest'
import type {KnownAgentCommand} from '@knowledge-medium/agent-cli/protocol'
import {createTestDb, resetTestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {startReadGate} from './gate'
import {clearSyncState, drainStaged, serverWorkspace, stagedBlock, syncServer, testWorkspaceRow} from '@/data/test/syncCheckpoint'
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

// This database boot took 0.36–1.45 s in the focused run.
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

// This database boot took 0.21 s in the focused run.
it('keeps a warm persisted checkpoint closed, opens on a new checkpoint, and closes on membership loss', async () => {
  const deliver = syncServer(fixture.db)
  await deliver([serverWorkspace(testWorkspaceRow(workspaceId)), member])
  const stamp = fixture.db.currentStatus.lastSyncedAt?.getTime()
  expect(stamp).toEqual(expect.any(Number))
  const host = start(plaintext(), async () => {})
  try {
    const read = () => host.execute({type: 'sql', sql: 'SELECT 1 AS n'})
    await vi.waitFor(async () => expect(await host.execute({type: 'health'})).toMatchObject({host: {
      baselineSyncedAt: stamp, lastSyncedAt: stamp, closedReason: 'Waiting for a checkpoint from this connection',
    }}))
    await expect(read()).rejects.toThrow('Waiting for a checkpoint')
    await vi.waitFor(async () => {
      await deliver([stagedBlock(randomUUID(), workspaceId)])
      expect(fixture.db.currentStatus.lastSyncedAt?.getTime()).not.toBe(stamp)
    }, {timeout: 5000})
    await vi.waitFor(async () => expect(await read()).toEqual([{n: 1}]))
    await fixture.db.execute('DELETE FROM workspace_members WHERE id = ?', [member.id])
    await expect(read()).rejects.toThrow('Waiting for the local member row')
  } finally {
    await host.stop()
  }
}, 20_000)

// This database boot took 0.35 s in the focused run.
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
    await vi.waitFor(async () => { await expect(read()).rejects.toThrow('have not been verified locally') })
    await host.execute({type: 'rematerialize-workspace'})
    await vi.waitFor(async () => expect(await read()).toMatchObject({id}))
  } finally {
    await host.stop()
  }
}, 20_000)

it('preserves an existing upload queue and refuses before connecting', async () => {
  await fixture.db.execute("INSERT INTO ps_crud (data) VALUES ('{}')")
  const connect = vi.fn(async () => { throw new Error('Unexpected connection attempt') })
  const run = serveDatabase(fixture.db, plaintext(), user, new AbortController().signal, connect)
  await expect(run).rejects.toThrow('queued writes')
  expect(connect).not.toHaveBeenCalled()
  expect(await fixture.db.get('SELECT data FROM ps_crud')).toEqual({data: '{}'})
})

// This database boot took 0.48 s in the focused run.
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
}, 20_000)

it('keeps watchers, reads and the same bootstrap through ordinary downloads and offline gaps', async () => {
  const id = randomUUID()
  const deliver = syncServer(fixture.db)
  await deliver([serverWorkspace(testWorkspaceRow(workspaceId)), member, stagedBlock(id, workspaceId)])
  await drainStaged(fixture.db)
  const {repo} = createTestRepo({db: fixture.db, user, isReadOnly: true, startSyncObserver: false})
  const open = vi.fn(async () => {})
  const visibility = vi.fn()
  const gate = startReadGate(fixture.db, repo, workspaceId, undefined, open, visibility)
  try {
    await vi.waitFor(() => expect(gate.reason()).toBeNull())
    const checkGap = vi.spyOn(repo, 'workspaceViewGap')
    const downloading = vi.spyOn(Object.getPrototypeOf(fixture.db.currentStatus), 'downloading', 'get')
    downloading.mockReturnValue(true)
    expect(await gate.readReason()).toBeNull()
    await deliver([stagedBlock(randomUUID(), workspaceId)])
    expect(await fixture.db.getOptional('SELECT 1 FROM blocks_synced_changes')).toBeTruthy()
    expect(await gate.readReason()).toBeNull()
    downloading.mockReturnValue(false)
    vi.spyOn(Object.getPrototypeOf(fixture.db.currentStatus), 'connected', 'get').mockReturnValue(false)
    expect(await gate.readReason()).toBeNull()
    expect(checkGap).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledOnce()
    expect(visibility.mock.calls).toEqual([[true]])
  } finally {
    await gate.stop()
  }
})

it('cancels a stalled open on membership loss and admits the restored member once', async () => {
  await syncServer(fixture.db)([serverWorkspace(testWorkspaceRow(workspaceId)), member])
  const {repo} = createTestRepo({db: fixture.db, user, isReadOnly: true})
  const open = vi.fn<(signal: AbortSignal) => Promise<void>>().mockResolvedValue(undefined).mockImplementationOnce(() => new Promise<void>(() => {}))
  const visibility = vi.fn()
  const gate = startReadGate(fixture.db, repo, workspaceId, undefined, open, visibility)
  try {
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce())
    const first = open.mock.calls[0]![0]
    expect(await gate.readReason()).toBe('Opening workspace data')
    await fixture.db.execute('DELETE FROM workspace_members WHERE id = ?', [member.id])
    await vi.waitFor(() => expect(first.aborted).toBe(true))
    expect(gate.reason()).toBe('Waiting for the local member row')
    expect(visibility).not.toHaveBeenCalledWith(true)
    await fixture.db.execute('INSERT INTO workspace_members (id, workspace_id, user_id, role, create_time) VALUES (?, ?, ?, ?, 1)',
      [member.id, workspaceId, user.id, 'viewer'])
    await vi.waitFor(() => expect(gate.reason()).toBeNull())
    expect(open).toHaveBeenCalledTimes(2)
    expect(visibility.mock.calls).toEqual([[true]])
  } finally {
    await gate.stop()
  }
})

it('stops while workspace data is still opening', async () => {
  await syncServer(fixture.db)([serverWorkspace(testWorkspaceRow(workspaceId)), member])
  const {repo} = createTestRepo({db: fixture.db, user, isReadOnly: true})
  const open = vi.fn<(signal: AbortSignal) => Promise<void>>(() => new Promise<void>(() => {}))
  const visibility = vi.fn()
  const gate = startReadGate(fixture.db, repo, workspaceId, undefined, open, visibility)
  await vi.waitFor(() => expect(open).toHaveBeenCalledOnce())
  await gate.stop()
  expect(open.mock.calls[0]![0].aborted).toBe(true)
  expect(visibility).not.toHaveBeenCalledWith(true)
})

it('keeps a bootstrap error in local logs and returns a fixed reason to the caller', async () => {
  await syncServer(fixture.db)([serverWorkspace(testWorkspaceRow(workspaceId)), member])
  const {repo} = createTestRepo({db: fixture.db, user, isReadOnly: true})
  const cause = new Error('private-device-marker')
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  const gate = startReadGate(fixture.db, repo, workspaceId, undefined, async () => { throw cause }, vi.fn())
  try {
    await vi.waitFor(() => expect(gate.reason()).toBe('Could not open workspace data'))
    expect(await gate.readReason()).toBe('Could not open workspace data')
    expect(logged).toHaveBeenCalledWith(expect.any(String), cause)
  } finally {
    await gate.stop()
  }
})

it('kicks a stalled transient drain and verifies its result before opening', async () => {
  await syncServer(fixture.db)([serverWorkspace(testWorkspaceRow(workspaceId)), member, stagedBlock(randomUUID(), workspaceId)])
  const {repo} = createTestRepo({db: fixture.db, user, isReadOnly: true, startSyncObserver: false})
  expect(await repo.workspaceViewGap(workspaceId)).toMatchObject({transient: true})
  // Hold the table notification so this admission must observe the completed
  // drain itself, even if no second wake reaches the gate.
  vi.spyOn(fixture.db, 'onChange').mockImplementation(() => () => {})
  vi.spyOn(repo, 'flushSyncObserver').mockImplementation(async () => { await drainStaged(fixture.db) })
  const open = vi.fn(async () => {})
  const gate = startReadGate(fixture.db, repo, workspaceId, undefined, open, () => {})
  try {
    await vi.waitFor(() => expect(gate.reason()).toBeNull())
    expect(repo.flushSyncObserver).toHaveBeenCalled()
    expect(open).toHaveBeenCalledOnce()
    expect(await repo.workspaceViewGap(workspaceId)).toBeNull()
  } finally {
    await gate.stop()
  }
})

it('requires a defined checkpoint when the persisted timestamp disappears', async () => {
  await syncServer(fixture.db)([serverWorkspace(testWorkspaceRow(workspaceId)), member])
  const baseline = fixture.db.currentStatus.lastSyncedAt!.getTime()
  await clearSyncState(fixture.db)
  expect(fixture.db.currentStatus.lastSyncedAt).toBeUndefined()
  await fixture.db.execute('INSERT OR REPLACE INTO workspace_members (id, workspace_id, user_id, role, create_time) VALUES (?, ?, ?, ?, 1)',
    [member.id, workspaceId, user.id, 'viewer'])
  const {repo} = createTestRepo({db: fixture.db, user, isReadOnly: true})
  const open = vi.fn(async () => {})
  const gate = startReadGate(fixture.db, repo, workspaceId, baseline, open, () => {})
  // stop waits for the initial check, including its eligibility reads.
  await gate.stop()
  expect(open).not.toHaveBeenCalled()
  expect(gate.reason()).toBe('Waiting for a checkpoint from this connection')
})

// This database boot took 0.08 s in the focused run.
it('holds a disconnected host before its first admission even with a fresh checkpoint', async () => {
  vi.spyOn(Object.getPrototypeOf(fixture.db.currentStatus), 'connected', 'get').mockReturnValue(false)
  const host = start(plaintext(), () => syncServer(fixture.db)([serverWorkspace(testWorkspaceRow(workspaceId)), member]))
  try {
    await vi.waitFor(async () => expect(await host.execute({type: 'health'})).toMatchObject({
      host: {closedReason: expect.stringContaining('not caught up with the server')},
    }))
    await expect(host.execute({type: 'sql', sql: 'SELECT 1'})).rejects.toThrow('not caught up with the server')
  } finally {
    await host.stop()
  }
}, 20_000)

it('requires the local member row before bootstrapping a fully synced workspace', async () => {
  await syncServer(fixture.db)([serverWorkspace(testWorkspaceRow(workspaceId))])
  const {repo} = createTestRepo({db: fixture.db, user, isReadOnly: true})
  expect(fixture.db.currentStatus.lastSyncedAt).toBeDefined()
  expect(await repo.workspaceViewGap(workspaceId)).toBeNull()
  const open = vi.fn(async () => {})
  const gate = startReadGate(fixture.db, repo, workspaceId, undefined, open, () => {})
  try {
    await vi.waitFor(() => expect(gate.reason()).toBe('Waiting for the local member row'))
    expect(open).not.toHaveBeenCalled()
    await fixture.db.execute('INSERT INTO workspace_members (id, workspace_id, user_id, role, create_time) VALUES (?, ?, ?, ?, 1)',
      [member.id, workspaceId, user.id, 'viewer'])
    await vi.waitFor(() => expect(gate.reason()).toBeNull())
    expect(open).toHaveBeenCalledOnce()
  } finally {
    await gate.stop()
  }
})
