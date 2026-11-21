// @vitest-environment happy-dom
import {randomUUID} from 'node:crypto'
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {afterAll, afterEach, beforeAll, expect, it, vi} from 'vitest'
import type {KnownAgentCommand} from '@knowledge-medium/agent-cli/protocol'
import {bootstrapWorkspace} from '@/bootstrap/workspaceBootstrap'
import {BlockCache} from '@/data/blockCache'
import type {BlockRow} from '@/data/blockSchema'
import * as definitionSeeds from '@/data/definitionSeeds'
import {Repo} from '@/data/repo'
import {createTestDb} from '@/data/test/createTestDb'
import {stubLocalStorage} from '@/data/test/e2eeFixtures'
import {serverWorkspace, stagedBlock, syncServer, testWorkspaceRow, type ServerRow} from '@/data/test/syncCheckpoint'
import {trackTestRepo} from '@/data/test/testRepoScope'
import {readWorkspaceEncryptionMode} from '@/data/workspaceSchema'
import {staticAppExtensions} from '@/extensions/staticAppExtensions'
import {staticDataExtensions} from '@/extensions/staticDataExtensions'
import {resolveFacetRuntimeSync} from '@/facets/facet'
import {resolveAppRuntimeSync} from '@/facets/resolveAppRuntime'
import * as commands from '@/plugins/agent-runtime/commands'
import {commentsPageBlockId} from '@/plugins/annotations/container'
import {attributionCreatorsProp, attributionEditorsProp} from '@/plugins/contributors/schema'
import {statusProp} from '@/plugins/todo/schema'
import {createWorkspaceConnector, UploadHeldError} from '@/services/powersync'
import {contentAad} from '@/sync/crypto/aad'
import {open} from '@/sync/crypto/aead'
import {unlockWorkspaceWithKey} from '@/sync/keys/flows/unlockWorkspaceWithKey'
import {getWorkspaceKeyStore} from '@/sync/keys/keyStore'
import {mintWorkspaceKey} from '@/sync/keys/mintWorkspaceKey'
import {getModePin} from '@/sync/keys/modePin'
import {createSyncResolver} from '@/sync/keys/resolver'
import {encryptUploadColumns, SEALED_COLUMNS} from '@/sync/transform'
import {buildLayout} from '@/utils/routing'
import {serveDatabase} from './host'
import {STALE_QUEUE_REASON} from './uploadHold'

type WireRow = Record<string, unknown> & {id: string}
type Rpc = (method: string, args: {creates?: WireRow[]; patches?: WireRow[]}) =>
  {abortSignal: () => Promise<{error: null; status: number}>}
const {rpc} = vi.hoisted(() => {
  vi.stubEnv('VITE_POWERSYNC_URL', 'https://sync.invalid')
  return {rpc: vi.fn<Rpc>(() => ({abortSignal: async () => ({error: null, status: 200})}))}
})
vi.mock('@/services/supabase', () => ({
  hasSupabaseAuthConfig: true,
  readPersistedSession: () => null,
  supabase: {
    auth: {getSession: async () => ({data: {session: {access_token: 'fixture-token'}}})},
    rpc,
  },
}))

type Fixture = Awaited<ReturnType<typeof createTestDb>>
type Db = Fixture['db']
type Execute = (command: KnownAgentCommand) => Promise<unknown>
type ReferenceRow = {source_id: string; target_id: string; alias: string; source_field: string; workspace_id: string}
const workspaceId = randomUUID()
const fromId = randomUUID()
const toId = randomUUID()
const noteId = randomUUID()
const user = {id: 'member', name: 'Test'}
const keyStore = getWorkspaceKeyStore()
const rowsIn = (db: Db) => db.getAll<BlockRow>('SELECT * FROM blocks WHERE workspace_id = ? ORDER BY id', [workspaceId])
const queue = (db: Db) => db.getAll<{data: string}>('SELECT data FROM ps_crud ORDER BY id')

let tab: Fixture
let host: Fixture
beforeAll(async () => {
  tab = await createTestDb()
  host = await createTestDb()
})
afterEach(async () => {
  await keyStore.delete(user.id, workspaceId)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
afterAll(async () => {
  vi.unstubAllEnvs()
  await Promise.all([tab.cleanup(), host.cleanup()])
})

// Name random rows and their descendants by outline position. Preserve IDs
// derived from stable parents so namespace or definition mismatches are visible.
const changedSnapshot = async (db: Db, before: BlockRow[]) => {
  const baseline = new Map(before.map(row => [row.id, JSON.stringify(row)]))
  const all = await rowsIn(db)
  const rows = all.filter(row => baseline.get(row.id) !== JSON.stringify(row))
  const minted = rows.filter(row => !baseline.has(row.id) && row.id !== noteId)
  const ids = new Map<string, string>()
  let visited = 0
  const nameChildren = (parent: string | null, name: string) => {
    const children = minted.filter(row => row.parent_id === parent)
      .sort((a, b) => a.order_key.localeCompare(b.order_key) || a.content.localeCompare(b.content) || a.created_at - b.created_at)
    children.forEach((row, index) => {
      visited += 1
      if (row.id[14] === '5' && (parent === null || !ids.has(parent))) {
        nameChildren(row.id, `new:${row.id}`)
      } else {
        const id = `${name}/${index}`
        ids.set(row.id, id)
        nameChildren(row.id, id)
      }
    })
  }
  nameChildren(null, 'new')
  for (const parent of [...baseline.keys(), noteId]) nameChildren(parent, `new:${parent}`)
  expect(visited).toBe(minted.length)
  const normalize = (row: object): string => {
    let wire = JSON.stringify(row)
    for (const [id, name] of ids) wire = wire.replaceAll(id, name)
    return wire
  }
  const liveIds = new Set(all.map(row => row.id))
  const removed = before.filter(row => !liveIds.has(row.id)).map(row => row.id)
  const references = await db.getAll<ReferenceRow>(
    'SELECT source_id, target_id, alias, source_field, workspace_id FROM block_references WHERE workspace_id = ?',
    [workspaceId],
  )
  return {rows: rows.map(normalize).sort(), removed, references: references.map(normalize).sort()}
}

// The scratch server has one bucket. Replay accepted tab writes into it before
// the host's first checkpoint so both clients open the same persisted rows.
const serverAfterTabOpen = (initial: ServerRow[]): ServerRow[] => {
  const rows = new Map(initial.map(row => [row.id, row]))
  for (const [, {creates, patches}] of rpc.mock.calls) {
    for (const {id, ...data} of creates ?? []) rows.set(id, {id, data, type: 'blocks_synced'})
    for (const {id, ...data} of patches ?? []) {
      delete data.base_updated_at
      const row = rows.get(id)!
      rows.set(id, {...row, data: {...row.data, ...data}})
    }
  }
  return [...rows.values()]
}

// Two real SQLite databases, several thousand tab seed rows and an encrypted
// host restart took 27 s under parallel gate load.
it('writes the same rows as the tab and seals every uploaded content column', async () => {
  const key = await mintWorkspaceKey(workspaceId)
  const keyFile = join(host.dir, 'fixture-key')
  await writeFile(keyFile, key.displayed, {mode: 0o600})
  stubLocalStorage()
  expect(await unlockWorkspaceWithKey({
    userId: user.id, workspaceId, canary: key.canary, pastedKey: key.displayed, keyStore,
  })).toMatchObject({ok: true})
  const member: ServerRow = {id: 'membership', type: 'workspace_members', data: {
    workspace_id: workspaceId, user_id: user.id, role: 'editor', create_time: 1,
  }}
  const workspace = serverWorkspace({...testWorkspaceRow(workspaceId), encryption_mode: 'e2ee', wk_canary: key.canary})
  const initial = [workspace, member]
  for (const id of [fromId, toId]) {
    const row = stagedBlock(id, workspaceId)
    initial.push({...row, data: await encryptUploadColumns(id, workspaceId, row.data, 'e2ee', async () => key.record.wk)})
  }
  const resolver = createSyncResolver(() => user.id, keyStore, id => readWorkspaceEncryptionMode(tab.db, id))
  const realNow = Date.now
  let stamp: number | undefined
  vi.spyOn(Date, 'now').mockImplementation(() => stamp ?? realNow())
  const repo = trackTestRepo(new Repo({db: tab.db, user, cache: new BlockCache(), syncObserverDeps: resolver}))
  const context = {repo, workspaceId, safeMode: false}
  repo.setFacetRuntime(resolveFacetRuntimeSync(staticDataExtensions, context))
  repo.setActiveWorkspaceId(workspaceId)
  await syncServer(tab.db)(initial)
  await repo.flushSyncObserver()
  const propertyPass = vi.spyOn(definitionSeeds, 'materializePropertySeeds')
  const typePass = vi.spyOn(definitionSeeds, 'materializeTypeSeeds')
  await bootstrapWorkspace({
    repo, workspaceId, freshlyCreated: false, requestedHash: buildLayout(workspaceId, [fromId]), requestedWorkspaceId: workspaceId,
  })
  await vi.waitFor(() => {
    expect(propertyPass).toHaveBeenCalled()
    expect(typePass).toHaveBeenCalled()
  }, {timeout: 20_000})
  await repo.awaitDeferredWork()
  const runtime = resolveAppRuntimeSync(staticAppExtensions({repo}), {overrides: new Map(), context})
  repo.setFacetRuntime(runtime)
  await repo.whenPropertyDefinitionsReady(workspaceId)
  const tabCommand: Execute = command => commands.executeCommand(command, commands.createAgentRuntimeContext({repo, runtime, safeMode: false}))
  const {id: creator} = await tabCommand({type: 'create-contributor', name: 'Writer', kind: 'agent'}) as {id: string}
  const {id: editor} = await tabCommand({type: 'create-contributor', name: 'Editor', kind: 'agent'}) as {id: string}
  await repo.awaitDeferredWork()
  const tabConnector = createWorkspaceConnector('tab.db', resolver)
  await tabConnector.uploadData(tab.db)
  expect(await queue(tab.db)).toEqual([])
  const serverRows = serverAfterTabOpen(initial)
  const tabBaseline = await rowsIn(tab.db)
  expect(serverRows).toContainEqual(expect.objectContaining({id: creator}))
  expect(serverRows).toContainEqual(expect.objectContaining({id: editor}))
  expect(serverRows).toContainEqual(expect.objectContaining({id: definitionSeeds.propertyDefinitionBlockId(workspaceId, statusProp.seedKey)}))

  stubLocalStorage()
  await keyStore.delete(user.id, workspaceId)
  expect(getModePin(user.id, workspaceId)).toBeNull()
  propertyPass.mockClear()
  typePass.mockClear()
  rpc.mockClear()
  // Leave the SDK's public connect overload and connector normalization in
  // place. The fake transport delivers the core checkpoint and retains uploadCrud.
  type Connector = {uploadCrud?: (signal: AbortSignal) => Promise<void>}
  const {connectionManager} = host.db as unknown as {connectionManager: {connect(connector: Connector): Promise<void>}}
  const connect = vi.spyOn(connectionManager, 'connect').mockResolvedValue(undefined).mockImplementationOnce(async () => {
    await syncServer(host.db)(serverRows)
  })
  vi.spyOn(Object.getPrototypeOf(host.db.currentStatus), 'connected', 'get').mockReturnValue(true)
  const contexts = vi.spyOn(commands, 'createAgentRuntimeContext')
  const start = (releaseStaleQueue = false) => {
    const controller = new AbortController()
    let register!: (execute: Execute) => void
    const ready = new Promise<Execute>(resolve => { register = resolve })
    const running = serveDatabase(host.db, {
      workspaceId, stateDir: host.dir, profile: 'fixture', mode: 'e2ee', keyFile, writable: true,
    }, user, controller.signal, undefined, async (_config, _user, execute) => {
      register(execute)
      return {postEvent: async () => {}, close: async () => {}}
    }, releaseStaleQueue)
    return {
      ready: Promise.race([ready, running.then(() => { throw new Error('Host stopped') })]),
      upload: () => {
        const upload = connect.mock.lastCall?.[0].uploadCrud
        expect(upload).toBeTypeOf('function')
        return upload!(controller.signal)
      },
      stop: () => { controller.abort(); return running },
    }
  }
  let active = start()
  try {
    const hostCommand = await active.ready
    await vi.waitFor(async () => {
      expect(await hostCommand({type: 'get-block', id: fromId})).toMatchObject({id: fromId, content: fromId})
      expect(propertyPass).toHaveBeenCalled()
      expect(typePass).toHaveBeenCalled()
    }, {timeout: 20_000})
    expect(await hostCommand({type: 'health'})).toMatchObject({host: {closedReason: null, readOnly: false}})
    const passes = [...propertyPass.mock.results, ...typePass.mock.results]
    for (const pass of passes) {
      expect(await pass.value).toEqual({created: 0, restored: 0, skippedReadOnly: false})
    }
    expect(getModePin(user.id, workspaceId)).toBe('e2ee')
    expect(await queue(host.db)).toEqual([])
    expect(rpc).not.toHaveBeenCalled()
    const hostRepo = contexts.mock.calls[0]![0].repo
    await hostRepo.awaitDeferredWork()
    expect(await queue(host.db)).toEqual([])
    const hostBaseline = await rowsIn(host.db)
    expect(hostBaseline).toEqual(tabBaseline)

    const steps: KnownAgentCommand[] = [
      {type: 'create-block', parentId: fromId, data: {id: noteId}, content: 'draft', properties: {status: 'open'}, contributorId: creator},
      {type: 'update-block', id: noteId, content: `edited ((${toId}))`, properties: {status: 'done'}, contributorId: editor},
      {type: 'move-block', id: noteId, parentId: toId, position: {kind: 'last'}, contributorId: editor},
      {type: 'delete-block', id: noteId, contributorId: editor},
      {type: 'restore-block', id: noteId, contributorId: editor},
      {type: 'append-markdown', target: noteId, format: 'json', markdown: `- child\n  - ((${fromId}))`, contributorId: creator},
      {type: 'add-comment', target: noteId, quote: 'edited', content: `See ((${fromId}))`, contributorId: editor},
    ]
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    stamp = realNow()
    for (const step of steps) {
      stamp += 100
      await tabCommand(step)
      const result = await hostCommand(step)
      await Promise.all([repo.awaitProcessors(), hostRepo.awaitProcessors()])
      const note = await host.db.get<BlockRow>('SELECT * FROM blocks WHERE id = ?', [noteId])
      if (step.type === 'create-block') {
        expect(note).toMatchObject({parent_id: fromId, content: 'draft', created_by: user.id, updated_by: user.id})
        expect(JSON.parse(note.properties_json)).toMatchObject({status: 'open', [attributionCreatorsProp.name]: [creator]})
      }
      if (step.type === 'update-block') {
        expect(JSON.parse(note.properties_json)).toMatchObject({status: 'done', [attributionEditorsProp.name]: [editor]})
        expect(JSON.parse(note.references_json)).toContainEqual({id: toId, alias: toId})
      }
      if (step.type === 'move-block') expect(note.parent_id).toBe(toId)
      if (step.type === 'delete-block') expect(note.deleted).toBe(1)
      if (step.type === 'restore-block') expect(note.deleted).toBe(0)
      if (step.type === 'append-markdown') expect(result).toMatchObject({appended: 2})
      if (step.type === 'add-comment') expect(result).toMatchObject({quote: 'edited', commentId: expect.any(String)})
      expect(await changedSnapshot(host.db, hostBaseline), step.type).toEqual(await changedSnapshot(tab.db, tabBaseline))

      rpc.mockClear()
      if (step.type === 'add-comment') {
        // The first comment lazily mints its pristine container with stamp 0.
        const queued = await queue(host.db)
        expect(queued.map(row => JSON.parse(row.data))).toContainEqual(expect.objectContaining({
          id: commentsPageBlockId(workspaceId), op: 'PUT', data: expect.objectContaining({updated_at: 0}),
        }))
        await expect(active.upload()).rejects.toBeInstanceOf(UploadHeldError)
        expect(await hostCommand({type: 'health'})).toMatchObject({host: {
          readOnly: true, uploadHold: STALE_QUEUE_REASON, queuedEntries: queued.length,
        }})
        expect(rpc).not.toHaveBeenCalled()
        expect(await queue(host.db)).toEqual(queued)
        await active.stop()
        active = start(true)
        await active.ready
        expect(await queue(host.db)).toEqual(queued)
      }
      await active.upload()
      expect(await queue(host.db)).toEqual([])
      const calls = rpc.mock.calls
      expect(calls.length, step.type).toBeGreaterThan(0)
      if (step.type === 'update-block') {
        expect(calls).toContainEqual(['apply_block_patches', {patches: expect.arrayContaining([
          expect.objectContaining({id: noteId, content: expect.any(String), properties_json: expect.any(String), references_json: expect.any(String)}),
        ])}])
      }
      const opened = new Map<string, Partial<Record<(typeof SEALED_COLUMNS)[number], string>>>()
      for (const [method, {creates, patches}] of calls) {
        expect(['apply_block_creates', 'apply_block_patches']).toContain(method)
        for (const payload of creates ?? patches ?? []) {
          expect(payload.workspace_id).toBe(workspaceId)
          const columns = opened.get(payload.id) ?? {}
          for (const column of SEALED_COLUMNS) {
            if (creates || column in payload) {
              columns[column] = await open(key.record.wk, payload[column] as string, contentAad(payload.id, workspaceId, column))
            }
          }
          opened.set(payload.id, columns)
        }
      }
      // A CREATE can be followed by a separate derived-reference PATCH.
      for (const [id, columns] of opened) {
        expect(await host.db.get<BlockRow>('SELECT * FROM blocks WHERE id = ?', [id])).toMatchObject(columns)
      }
    }
  } finally {
    await active.stop()
  }
}, 60_000)
