// @vitest-environment node
import {PowerSyncDatabase} from '@powersync/node'
import type {PowerSyncBackendConnector, Transaction} from '@powersync/common'
import {createClientPowerSyncSchema, initializeClientDatabase} from '@/data/internals/initializeClientDatabase'
import {randomUUID} from 'node:crypto'
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest'
import type {KnownAgentCommand} from '@knowledge-medium/agent-cli/protocol'
import {propertyDefinitionBlockId} from '@/data/definitionSeeds'
import {propertiesPageBlockId} from '@/data/propertiesPage'
import {createTestDb, resetTestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {startReadGate} from './gate'
import {clearSyncState, drainStaged, serverWorkspace, stagedBlock, syncServer, testWorkspaceRow} from '@/data/test/syncCheckpoint'
import {mintWorkspaceKey} from '@/sync/keys/mintWorkspaceKey'
import {getWorkspaceKeyStore} from '@/sync/keys/keyStore'
import {encryptUploadColumns} from '@/sync/transform'
import {stubLocalStorage} from '@/data/test/e2eeFixtures'
import {statusProp} from '@/plugins/todo/schema'
import {serveDatabase} from './host'
import {assertReadSurface} from './test/readSurface'
import type {HeadlessConfig} from './config'

const {rpc} = vi.hoisted(() => ({rpc: vi.fn(() => ({abortSignal: async () => ({error: null, status: 200})}))}))
vi.mock('@/services/supabase', async importOriginal => ({
  ...await importOriginal<typeof import('@/services/supabase')>(),
  supabase: {rpc},
}))

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
  rpc.mockClear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
afterAll(async () => { await fixture.cleanup() })

function start(config: HeadlessConfig, connect: NonNullable<Parameters<typeof serveDatabase>[4]>, db = fixture.db) {
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
const writable = () => ({...plaintext(), writable: true})

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

// Real bootstrap on both sides of promotion took 8.85 s with another suite running.
it('uploads a write after promotion and refuses the next write after demotion', async () => {
  const {db} = fixture
  const id = randomUUID()
  const deliver = syncServer(db)
  let uploader: PowerSyncBackendConnector | undefined
  const host = start(writable(), async (_db, connector) => {
    uploader = connector
    await deliver([serverWorkspace(testWorkspaceRow(workspaceId)),
      {...member, data: {...member.data, role: 'viewer'}}, stagedBlock(id, workspaceId)])
  })
  const update = (content: string) => host.execute({type: 'update-block', id, content, contributorId: null})
  const expectOpen = (readOnly: boolean) => vi.waitFor(async () => {
    expect(await host.execute({type: 'health'})).toMatchObject({host: {readOnly, closedReason: null}})
  }, {timeout: 15_000})
  try {
    await expectOpen(true)
    await expect(update('viewer edit')).rejects.toThrow(/read-only mode/)
    expect(await db.get('SELECT content FROM blocks WHERE id = ?', [id])).toEqual({content: id})

    await deliver([member])
    await expectOpen(false)
    await update('accepted edit')
    expect(await db.get('SELECT content FROM blocks WHERE id = ?', [id])).toEqual({content: 'accepted edit'})
    expect(uploader).toBeDefined()
    await uploader!.uploadData(db)
    expect(rpc).toHaveBeenCalledWith('apply_block_patches', {
      patches: expect.arrayContaining([expect.objectContaining({id, content: 'accepted edit'})]),
    })
    expect(await db.getOptional("SELECT 1 FROM ps_crud WHERE json_extract(data, '$.id') = ?", [id])).toBeNull()

    // The fake sink acknowledges queue entries. Apply the role change directly
    // to the replica because it does not supply a server write checkpoint.
    await db.execute("UPDATE workspace_members SET role = 'viewer' WHERE id = ?", [member.id])
    await expect(update('edit after demotion')).rejects.toThrow(/read-only mode|gate closed/)
    expect(await host.execute({type: 'health'})).toMatchObject({host: {readOnly: true}})
    expect(await db.get('SELECT content FROM blocks WHERE id = ?', [id])).toEqual({content: 'accepted edit'})
  } finally {
    await host.stop()
  }
}, 40_000)

// Bootstrapping and queuing the real seed rows took 1.53 s in the focused run.
it('uploads fresh workspace seed rows with zero-version stamps', async () => {
  const {db} = fixture
  const deliver = syncServer(db)
  let uploader: PowerSyncBackendConnector | undefined
  const host = start(writable(), async (_db, connector) => {
    uploader = connector
    await deliver([serverWorkspace(testWorkspaceRow(workspaceId)), member, stagedBlock(randomUUID(), workspaceId)])
  })
  const health = () => host.execute({type: 'health'})
  const seedId = propertyDefinitionBlockId(workspaceId, statusProp.seedKey)
  try {
    await vi.waitFor(async () => {
      expect(await health()).toMatchObject({host: {closedReason: null, readOnly: false}})
      expect(await db.getOptional(
        `SELECT 1 AS queued FROM ps_crud WHERE json_extract(data, '$.op') = 'PUT'
           AND json_extract(data, '$.id') = ? AND json_extract(data, '$.data.updated_at') = 0`, [seedId],
      )).toEqual({queued: 1})
    }, {timeout: 15_000})
    expect(uploader).toBeDefined()
    await uploader!.uploadData(db)
    expect(rpc).toHaveBeenCalledWith('apply_block_creates', {
      creates: expect.arrayContaining([expect.objectContaining({
        id: seedId, content: statusProp.name, parent_id: propertiesPageBlockId(workspaceId), updated_at: 0,
      })]),
    })
    expect(await db.getOptional("SELECT 1 FROM ps_crud WHERE json_extract(data, '$.id') = ?", [seedId])).toBeNull()
    expect(await health()).toMatchObject({host: {closedReason: null, readOnly: false, uploadHold: null}})
  } finally {
    await host.stop()
  }
}, 30_000)

// Real bootstrap and rejoin took 8.59 s in the focused run.
it('holds a rejoining editor read-only behind a durable materialization gap until repaired', async () => {
  const id = randomUUID()
  const deliver = syncServer(fixture.db)
  const host = start(writable(), () => deliver([serverWorkspace(testWorkspaceRow(workspaceId)), member, stagedBlock(id, workspaceId)]))
  try {
    const read = () => host.execute({type: 'get-block', id})
    const update = (content: string) => host.execute({type: 'update-block', id, content, contributorId: null})
    const health = () => host.execute({type: 'health'})
    const expectWritable = () => vi.waitFor(async () => {
      expect(await health()).toMatchObject({host: {readOnly: false, closedReason: null}})
    }, {timeout: 15_000})
    await expectWritable()
    expect(await read()).toMatchObject({id, content: id})
    await fixture.db.execute('DELETE FROM workspace_members WHERE id = ?', [member.id])
    await expect(update('edit after removal')).rejects.toThrow('local member row')
    expect(await health()).toMatchObject({host: {readOnly: true, closedReason: 'Waiting for the local member row'}})
    await fixture.db.writeTransaction(async tx => {
      await tx.execute('UPDATE blocks_synced SET needs_apply = 1 WHERE id = ?', [id])
      await tx.execute('INSERT INTO workspace_members (id, workspace_id, user_id, role, create_time) VALUES (?, ?, ?, ?, 1)',
        [member.id, workspaceId, user.id, 'editor'])
    })
    expect(await fixture.db.get('SELECT needs_apply FROM blocks_synced WHERE id = ?', [id])).toEqual({needs_apply: 1})
    await vi.waitFor(async () => { await expect(read()).rejects.toThrow('have not been verified locally') })
    await expect(update('edit before repair')).rejects.toThrow('have not been verified locally')
    expect(await health()).toMatchObject({host: {readOnly: true}})
    await host.execute({type: 'rematerialize-workspace'})
    await expectWritable()
    expect(await read()).toMatchObject({id, content: id})
    await update('edit after repair')
    expect(await read()).toMatchObject({id, content: 'edit after repair'})
  } finally {
    await host.stop()
  }
}, 40_000)

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

it.each(['editor', 'owner'])('sets the %s role before writable bootstrap and keeps the gate closed until it finishes', async role => {
  await syncServer(fixture.db)([serverWorkspace(testWorkspaceRow(workspaceId)),
    {...member, data: {...member.data, role: 'viewer'}}])
  const {repo} = createTestRepo({db: fixture.db, user, isReadOnly: true})
  let finishBootstrap!: () => void
  const bootstrap = new Promise<void>(resolve => { finishBootstrap = resolve })
  const open = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    .mockImplementationOnce(async () => { expect(repo.isReadOnly).toBe(true) })
    .mockImplementationOnce(async () => {
      expect(repo.isReadOnly).toBe(false)
      await bootstrap
    })
  const gate = startReadGate(fixture.db, repo, workspaceId, undefined, open, () => {},
    {writable: true, isUploadHeld: () => false})
  try {
    await vi.waitFor(() => expect(gate.reason()).toBeNull())
    expect(open).toHaveBeenCalledOnce()
    expect(repo.isReadOnly).toBe(true)
    await fixture.db.execute('UPDATE workspace_members SET role = ? WHERE id = ?', [role, member.id])
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2))
    expect(await gate.readReason()).toBe('Opening workspace data')
    finishBootstrap()
    await vi.waitFor(() => expect(gate.reason()).toBeNull())
    expect(repo.isReadOnly).toBe(false)
    expect(open).toHaveBeenCalledTimes(2)
  } finally {
    finishBootstrap()
    await gate.stop()
  }
})

it('refuses stale write access before the membership notification arrives', async () => {
  await syncServer(fixture.db)([serverWorkspace(testWorkspaceRow(workspaceId)), member])
  const {repo} = createTestRepo({db: fixture.db, user, isReadOnly: true})
  vi.spyOn(fixture.db, 'onChange').mockImplementation(() => () => {})
  const gate = startReadGate(fixture.db, repo, workspaceId, undefined, async () => {}, () => {},
    {writable: true, isUploadHeld: () => false})
  try {
    await vi.waitFor(() => expect(gate.reason()).toBeNull())
    expect(repo.isReadOnly).toBe(false)
    await fixture.db.execute("UPDATE workspace_members SET role = 'viewer' WHERE id = ?", [member.id])
    expect(repo.isReadOnly).toBe(false)
    await gate.readReason()
    expect(repo.isReadOnly).toBe(true)
  } finally {
    await gate.stop()
  }
})

it('closes the gate on a failed membership snapshot during command admission', async () => {
  await syncServer(fixture.db)([serverWorkspace(testWorkspaceRow(workspaceId)), member])
  const {repo} = createTestRepo({db: fixture.db, user, isReadOnly: true})
  const visibility = vi.fn()
  const cause = new Error('private-device-marker')
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  const gate = startReadGate(fixture.db, repo, workspaceId, undefined, async () => {}, visibility,
    {writable: true, isUploadHeld: () => false})
  try {
    await vi.waitFor(() => expect(gate.reason()).toBeNull())
    expect(repo.isReadOnly).toBe(false)
    vi.spyOn(fixture.db, 'readTransaction').mockRejectedValueOnce(cause)
    expect(await gate.readReason()).toBe('Could not check the workspace view')
    expect(gate.reason()).toBe('Could not check the workspace view')
    expect(repo.isReadOnly).toBe(true)
    expect(visibility.mock.calls).toEqual([[true], [false]])
    expect(logged).toHaveBeenCalledWith(expect.any(String), cause)
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

it('never combines a clean view with membership restored alongside a staged row', async () => {
  const {db} = fixture
  await syncServer(db)([serverWorkspace(testWorkspaceRow(workspaceId)), member])
  const {repo} = createTestRepo({db, user, isReadOnly: true})
  vi.spyOn(db, 'onChange').mockImplementation(() => () => {})
  const flush = vi.spyOn(repo, 'flushSyncObserver').mockResolvedValue(undefined)
  const open = vi.fn(async () => {})
  const gate = startReadGate(db, repo, workspaceId, undefined, open, () => {},
    {writable: true, isUploadHeld: () => false})
  try {
    await vi.waitFor(() => expect(gate.reason()).toBeNull())
    expect(open).toHaveBeenCalledOnce()
    expect(repo.isReadOnly).toBe(false)
    await db.execute('DELETE FROM workspace_members WHERE id = ?', [member.id])
    expect(await gate.readReason()).toBe('Waiting for the local member row')
    expect(await repo.workspaceViewGap(workspaceId)).toBeNull()

    const restore = () => db.writeTransaction(async tx => {
      await tx.execute('INSERT INTO workspace_members (id, workspace_id, user_id, role, create_time) VALUES (?, ?, ?, ?, 1)',
        [member.id, workspaceId, user.id, 'editor'])
      await tx.execute("INSERT INTO blocks_synced_changes (id, op) VALUES (?, 'delete')", ['staged-removal'])
    })
    const readGap = repo.workspaceViewGap.bind(repo)
    const readTransaction = db.readTransaction.bind(db)
    // Put the restore at the first snapshot boundary. With split reads, it
    // lands after the clean gap check and before the membership lookup.
    const restored = vi.fn(restore)
    vi.spyOn(repo, 'workspaceViewGap').mockImplementationOnce(async (...args) => {
      const gap = await readGap(...args)
      if (!restored.mock.calls.length) await restored()
      return gap
    })
    vi.spyOn(db, 'readTransaction').mockImplementationOnce(async <T>(callback: (tx: Transaction) => Promise<T>) => {
      const result = await readTransaction(callback)
      if (!restored.mock.calls.length) await restored()
      return result
    })
    await vi.waitFor(async () => {
      await gate.readReason()
      expect(flush.mock.calls.length + open.mock.calls.length).toBeGreaterThan(1)
    })
    expect(restored).toHaveBeenCalledOnce()
    expect(await db.getOptional('SELECT 1 FROM blocks_synced_changes')).toBeTruthy()
    expect(open).toHaveBeenCalledOnce()
    expect(repo.isReadOnly).toBe(true)
    await drainStaged(db)
    await vi.waitFor(async () => expect(await gate.readReason()).toBeNull())
    expect(open).toHaveBeenCalledTimes(2)
    expect(repo.isReadOnly).toBe(false)
  } finally {
    await gate.stop()
  }
})

it('checks the staging queue before replacing an unadmitted viewer bootstrap with an editor bootstrap', async () => {
  const {db} = fixture
  await syncServer(db)([serverWorkspace(testWorkspaceRow(workspaceId)), {...member, data: {...member.data, role: 'viewer'}}])
  const {repo} = createTestRepo({db, user, isReadOnly: true})
  const open = vi.fn<(signal: AbortSignal) => Promise<void>>().mockResolvedValue(undefined)
    .mockImplementationOnce(() => new Promise<void>(() => {}))
  const flush = vi.spyOn(repo, 'flushSyncObserver').mockResolvedValue(undefined)
  const gate = startReadGate(db, repo, workspaceId, undefined, open, () => {},
    {writable: true, isUploadHeld: () => false})
  try {
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce())
    expect(gate.reason()).toBe('Opening workspace data')
    expect(repo.isReadOnly).toBe(true)
    await db.writeTransaction(async tx => {
      await tx.execute("UPDATE workspace_members SET role = 'editor' WHERE id = ?", [member.id])
      await tx.execute("INSERT INTO blocks_synced_changes (id, op) VALUES (?, 'delete')", ['staged-removal'])
    })
    await vi.waitFor(() => expect(flush.mock.calls.length + open.mock.calls.length).toBeGreaterThan(1))
    expect(open.mock.calls[0]![0].aborted).toBe(true)
    expect(await db.getOptional('SELECT 1 FROM blocks_synced_changes')).toBeTruthy()
    expect(open).toHaveBeenCalledOnce()
    expect(repo.isReadOnly).toBe(true)
    await drainStaged(db)
    await vi.waitFor(() => expect(gate.reason()).toBeNull())
    expect(open).toHaveBeenCalledTimes(2)
    expect(repo.isReadOnly).toBe(false)
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
  const open = async () => {
    expect(repo.isReadOnly).toBe(false)
    throw cause
  }
  const gate = startReadGate(fixture.db, repo, workspaceId, undefined, open, vi.fn(),
    {writable: true, isUploadHeld: () => false})
  try {
    await vi.waitFor(() => expect(gate.reason()).toBe('Could not open workspace data'))
    expect(repo.isReadOnly).toBe(true)
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

it('admits a rejoining member with the role observed after its staged backlog drains', async () => {
  const deliver = syncServer(fixture.db)
  await deliver([serverWorkspace(testWorkspaceRow(workspaceId)), member])
  const {repo} = createTestRepo({db: fixture.db, user, isReadOnly: true, startSyncObserver: false})
  const opened: boolean[] = []
  const gate = startReadGate(fixture.db, repo, workspaceId, undefined, async () => { opened.push(repo.isReadOnly) },
    () => {}, {writable: true, isUploadHeld: () => false})
  let finishDrain!: () => void
  const release = new Promise<void>(resolve => { finishDrain = resolve })
  const flush = vi.spyOn(repo, 'flushSyncObserver').mockImplementation(async () => {
    await release
    await drainStaged(fixture.db)
  })
  try {
    await vi.waitFor(() => expect(opened).toEqual([false]))
    await fixture.db.execute('DELETE FROM workspace_members WHERE id = ?', [member.id])
    await vi.waitFor(() => expect(gate.reason()).toContain('local member row'))
    await deliver([member, stagedBlock(randomUUID(), workspaceId)])
    await vi.waitFor(() => expect(flush).toHaveBeenCalled())
    expect(await fixture.db.getOptional('SELECT 1 FROM blocks_synced_changes')).toBeTruthy()
    expect(await gate.readReason()).toEqual(expect.any(String))
    expect(repo.isReadOnly).toBe(true)
    await fixture.db.execute("UPDATE workspace_members SET role = 'viewer' WHERE id = ?", [member.id])
    finishDrain()
    await vi.waitFor(() => expect(gate.reason()).toBeNull())
    expect(opened).toEqual([false, true])
    expect(repo.isReadOnly).toBe(true)
  } finally {
    finishDrain()
    await gate.stop()
  }
})
