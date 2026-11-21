import {afterAll, afterEach, beforeAll, expect, it, vi} from 'vitest'
import {ChangeScope} from '@/data/api/changeScope'
import {createTestDb} from '@/data/test/createTestDb'
import {stubLocalStorage} from '@/data/test/e2eeFixtures'
import {insertWorkspaceRow} from '@/data/test/syncCheckpoint'
import * as commands from '@/plugins/agent-runtime/commands'
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

it('installs downloads without an uploader and preserves an allowed UI-state write on disk', async () => {
  const {db} = fixture
  const workspaceId = 'workspace'
  const user = {id: 'member', name: 'Test'}
  await insertWorkspaceRow(db, workspaceId, user.id)
  stubLocalStorage()
  vi.stubGlobal('document', {querySelectorAll: () => [], baseURI: 'node:headless'})

  // The public db.connect normalizes both overloads here. Intercept only the
  // transport so the SDK decides which directions this host actually enabled.
  type Connector = {
    fetchCredentials: (signal: AbortSignal) => Promise<unknown>
    uploadCrud?: (signal: AbortSignal) => Promise<void>
  }
  const {connectionManager} = db as unknown as {connectionManager: {connect(connector: Connector): Promise<void>}}
  const connect = vi.spyOn(connectionManager, 'connect').mockResolvedValue(undefined)
  const capture = vi.spyOn(commands, 'createAgentRuntimeContext')
  const register = vi.fn(async () => ({postEvent: async () => {}, close: async () => {}}))
  const stopping = new AbortController()
  const host = serveDatabase(db, {mode: 'plaintext', workspaceId, profile: 'fixture', stateDir: fixture.dir},
    user, stopping.signal, undefined, register)

  const queue = () => db.getAll<{id: number, tx_id: number, data: string}>('SELECT id, tx_id, data FROM ps_crud ORDER BY id')
  try {
    await Promise.race([vi.waitFor(() => expect(register).toHaveBeenCalledOnce()), host])
    const {repo} = capture.mock.calls[0]![0]
    expect(repo.isReadOnly).toBe(true)
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
