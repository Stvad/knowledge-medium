import {afterAll, afterEach, beforeAll, expect, it, vi} from 'vitest'
import {ChangeScope} from '@/data/api/changeScope'
import {createTestDb} from '@/data/test/createTestDb'
import {stubLocalStorage} from '@/data/test/e2eeFixtures'
import {serverWorkspace, syncServer, testWorkspaceRow} from '@/data/test/syncCheckpoint'
import {getLocalMemberRole} from '@/data/workspaces'
import * as commands from '@/plugins/agent-runtime/commands'
import type {connectBridge} from './bridge'
import {serveDatabase} from './host'

const {rpc} = vi.hoisted(() => {
  vi.stubEnv('VITE_POWERSYNC_URL', 'https://sync.invalid')
  return {rpc: vi.fn(() => ({abortSignal: async () => ({error: null, status: 200})}))}
})
vi.mock('@/services/supabase', () => ({
  hasSupabaseAuthConfig: true,
  readPersistedSession: () => null,
  supabase: {
    auth: {getSession: async () => ({data: {session: {access_token: 'fixture-token'}}})},
    rpc,
  },
}))

let fixture: Awaited<ReturnType<typeof createTestDb>>
beforeAll(async () => { fixture = await createTestDb() })
afterAll(async () => {
  await fixture.cleanup()
  vi.unstubAllEnvs()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('keeps an admitted editor read-only, preserving an allowed UI-state write without uploading it', async () => {
  const {db} = fixture
  const workspaceId = 'workspace'
  const user = {id: 'member', name: 'Test'}
  stubLocalStorage()
  vi.stubGlobal('document', {querySelectorAll: () => [], baseURI: 'node:headless'})

  // The public db.connect normalizes both overloads here. Intercept only the
  // transport so the SDK decides which directions this host actually enabled.
  type Connector = {
    fetchCredentials: (signal: AbortSignal) => Promise<unknown>
    uploadCrud?: (signal: AbortSignal) => Promise<void>
  }
  const {connectionManager} = db as unknown as {connectionManager: {connect(connector: Connector): Promise<void>}}
  const deliver = syncServer(db)
  vi.spyOn(Object.getPrototypeOf(db.currentStatus), 'connected', 'get').mockReturnValue(true)
  const connect = vi.spyOn(connectionManager, 'connect').mockImplementation(() => deliver([
    serverWorkspace(testWorkspaceRow(workspaceId, user.id)),
    {type: 'workspace_members', id: 'membership', data: {
      workspace_id: workspaceId, user_id: user.id, role: 'editor', create_time: 1,
    }},
  ]))
  const capture = vi.spyOn(commands, 'createAgentRuntimeContext')
  const register = vi.fn<typeof connectBridge>(async () => ({
    postEvent: async () => {}, close: async () => {},
  }))
  const stopping = new AbortController()
  const host = serveDatabase(db, {mode: 'plaintext', writable: false, workspaceId, profile: 'fixture', stateDir: fixture.dir},
    user, stopping.signal, {register})

  const queue = () => db.getAll<{id: number, tx_id: number, data: string}>('SELECT id, tx_id, data FROM ps_crud ORDER BY id')
  try {
    await Promise.race([vi.waitFor(() => expect(register).toHaveBeenCalledOnce()), host])
    const execute = register.mock.calls[0]![2]
    await vi.waitFor(async () => expect(await execute({type: 'sql', sql: 'SELECT 1 AS n'})).toEqual([{n: 1}]))
    const {repo} = capture.mock.calls[0]![0]
    expect(await getLocalMemberRole(repo, workspaceId, user.id)).toBe('editor')
    expect(repo.isReadOnly).toBe(true)
    const documentWrite = vi.fn()
    await expect(repo.tx(documentWrite, {scope: ChangeScope.BlockDefault})).rejects.toThrow('read-only')
    expect(documentWrite).not.toHaveBeenCalled()
    expect(await queue()).toEqual([])
    const id = await repo.tx(tx => tx.create({workspaceId, parentId: null, orderKey: 'a0', content: 'local UI state'}),
      {scope: ChangeScope.UiState})
    const queued = await queue()
    expect(queued).toHaveLength(1)
    expect(JSON.parse(queued[0]!.data)).toMatchObject({id, op: 'PUT', data: {content: 'local UI state'}})

    const connector = connect.mock.calls[0]![0]
    expect(await connector.fetchCredentials(stopping.signal)).toMatchObject({endpoint: 'https://sync.invalid', token: 'fixture-token'})
    await connector.uploadCrud?.(stopping.signal)
    expect(rpc).not.toHaveBeenCalled()
    expect(connector.uploadCrud).toBeUndefined()
    expect(await queue()).toEqual(queued)
  } finally {
    stopping.abort()
    await host
  }
})
