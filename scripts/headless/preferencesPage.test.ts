// @vitest-environment happy-dom
import {randomUUID} from 'node:crypto'
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest'
import type {KnownAgentCommand} from '@knowledge-medium/agent-cli/protocol'
import {ChangeScope} from '@/data/api'
import {BlockCache} from '@/data/blockCache'
import {parseBlockRow, type BlockRow} from '@/data/blockSchema'
import {userIdProp} from '@/data/properties'
import {Repo} from '@/data/repo'
import {
  getPluginPrefsBlock,
  getPluginUIStateBlock,
  pluginPrefsBlockId,
  preferencesRootId,
  userPageBlockId,
} from '@/data/stateBlocks'
import {createTestDb, resetTestDb} from '@/data/test/createTestDb'
import {stubLocalStorage} from '@/data/test/e2eeFixtures'
import {clearSyncState, serverBlock, serverWorkspace, syncServer, testWorkspaceRow, type ServerRow} from '@/data/test/syncCheckpoint'
import {trackTestRepo} from '@/data/test/testRepoScope'
import {staticAppExtensions} from '@/extensions/staticAppExtensions'
import {staticDataExtensions} from '@/extensions/staticDataExtensions'
import {resolveFacetRuntimeSync} from '@/facets/facet'
import {resolveAppRuntimeSync} from '@/facets/resolveAppRuntime'
import {dailyNoteBlockId} from '@/plugins/daily-notes/dailyNotes'
import * as commands from '@/plugins/agent-runtime/commands'
import {backlinksPrefsType, dailyNoteBacklinksDefaultsProp} from '@/plugins/backlinks/dailyNoteDefaults'
import {
  EMPTY_GROUPED_BACKLINKS_CONFIG,
  groupedBacklinksDefaultsProp,
  groupedBacklinksPrefsType,
  INITIAL_GROUPED_BACKLINKS_CONFIG,
} from '@/plugins/grouped-backlinks/config'
import type {HeadlessConfig} from './config'
import {startHost} from './test/startHost'

type Fixture = Awaited<ReturnType<typeof createTestDb>>
const workspaceId = randomUUID()
const owner = {id: 'owner', name: 'Owner'}
const member = {id: 'member', name: 'Agent'}
const ownerPage = userPageBlockId(workspaceId, owner.id)
const target = randomUUID()
const daily = dailyNoteBlockId(workspaceId, '2026-01-15')
const impostor = randomUUID()
const membership: ServerRow = {id: 'membership', type: 'workspace_members', data: {
  workspace_id: workspaceId, user_id: member.id, role: 'viewer', create_time: 1,
}}

let tab: Fixture
let host: Fixture
let serverRows: ServerRow[]
let ownerRows: ServerRow[]

/** One read verb per moved preference read: `defaults` is the same read
 *  without the owner's preference, `outcome` the part that preference changes. */
interface PreferenceRead {
  command: KnownAgentCommand
  defaults: KnownAgentCommand
  outcome: (result: unknown) => unknown
  onTab?: unknown
  withDefaults?: unknown
}
const groupedBacklinks: PreferenceRead = {
  command: {type: 'grouped-backlinks', blockId: target},
  defaults: {type: 'grouped-backlinks', blockId: target, grouping: INITIAL_GROUPED_BACKLINKS_CONFIG},
  outcome: result => (result as {groups: {label: string}[]}).groups.map(group => group.label).sort(),
}
const dailyNoteBacklinks: PreferenceRead = {
  command: {type: 'backlinks', blockId: daily, filter: 'effective'},
  defaults: {type: 'backlinks', blockId: daily, filter: 'stored'},
  outcome: result => (result as {backlinks: {id: string}[]}).backlinks.length,
}
const reads = [groupedBacklinks, dailyNoteBacklinks]

const asServerRow = (row: BlockRow) => serverBlock(parseBlockRow(row))
const ownerSubtree = (db: Fixture['db']) => db.getAll<BlockRow>(`
  WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT b.id FROM blocks b JOIN tree ON b.parent_id = tree.id)
  SELECT b.* FROM blocks b JOIN tree USING (id) ORDER BY b.id`, [ownerPage])

// The tab writes the owner's tuning and the rows it reads. The two topics form
// two groups under the defaults, and the owner excludes one; the owner's
// daily-note filter drops one of the daily note's two backlinks.
beforeAll(async () => {
  tab = await createTestDb()
  host = await createTestDb()
  const repo = trackTestRepo(new Repo({db: tab.db, user: owner, cache: new BlockCache()}))
  const context = {repo, workspaceId, safeMode: false}
  repo.setFacetRuntime(resolveFacetRuntimeSync(staticDataExtensions, context))
  repo.setActiveWorkspaceId(workspaceId)
  const runtime = resolveAppRuntimeSync(staticAppExtensions({repo}), {overrides: new Map(), context})
  repo.setFacetRuntime(runtime)
  const tabCommand = (command: KnownAgentCommand) =>
    commands.executeCommand(command, commands.createAgentRuntimeContext({repo, runtime, safeMode: false}))
  expect(await tabCommand({type: 'create-page', date: '2026-01-15', contributorId: null})).toMatchObject({id: daily})
  const [alpha, beta, dropped] = [randomUUID(), randomUUID(), randomUUID()]
  await repo.tx(async tx => {
    for (const [index, id] of [randomUUID(), dropped].entries()) {
      await tx.create({id, workspaceId, parentId: null, orderKey: `d${index}`, content: `((${daily})) ${index}`})
    }
    for (const [id, content] of [[target, 'Target'], [alpha, 'Alpha'], [beta, 'Beta']]) {
      await tx.create({id, workspaceId, parentId: null, orderKey: 'a0', content})
    }
    for (const [index, topic] of [alpha, alpha, beta, beta].entries()) {
      await tx.create({
        id: randomUUID(), workspaceId, parentId: null, orderKey: `b${index}`, content: `((${target})) ((${topic})) ${index}`,
      })
    }
    await tx.create({id: impostor, workspaceId, parentId: null, orderKey: 'c0', content: 'Not a user page'})
    await tx.setProperty(impostor, userIdProp, owner.id)
  }, {scope: ChangeScope.BlockDefault})
  const prefs = await getPluginPrefsBlock(repo, workspaceId, owner, groupedBacklinksPrefsType)
  await prefs.set(groupedBacklinksDefaultsProp, {...EMPTY_GROUPED_BACKLINKS_CONFIG, excludedTags: ['Alpha']})
  const backlinksPrefs = await getPluginPrefsBlock(repo, workspaceId, owner, backlinksPrefsType)
  await backlinksPrefs.set(dailyNoteBacklinksDefaultsProp, {include: [], exclude: [{id: dropped}]})
  await repo.awaitProcessors()
  for (const read of reads) {
    read.onTab = await tabCommand(read.command)
    read.withDefaults = await tabCommand(read.defaults)
  }
  const rows = await tab.db.getAll<BlockRow>('SELECT * FROM blocks WHERE workspace_id = ?', [workspaceId])
  serverRows = [serverWorkspace(testWorkspaceRow(workspaceId, owner.id)), membership, ...rows.map(asServerRow)]
  ownerRows = (await ownerSubtree(tab.db)).map(asServerRow)
}, 20_000)
beforeEach(async () => {
  await clearSyncState(host.db)
  await resetTestDb(host.db)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
afterAll(async () => { await Promise.all([tab.cleanup(), host.cleanup()]) })

const serve = (preferencesPage: string) => {
  stubLocalStorage()
  vi.spyOn(Object.getPrototypeOf(host.db.currentStatus), 'connected', 'get').mockReturnValue(true)
  const deliver = syncServer(host.db)
  const config: HeadlessConfig = {mode: 'plaintext', workspaceId, profile: 'fixture', stateDir: host.dir, preferencesPage}
  return startHost(host.db, config, member, {connect: () => deliver(serverRows)})
}

it('resolves the configured page in its workspace and the acting user\'s page elsewhere', () => {
  const repo = trackTestRepo(new Repo({
    db: tab.db, user: member, cache: new BlockCache(), preferencesPage: {workspaceId, userPageId: ownerPage},
  }))
  expect(preferencesRootId(repo, workspaceId)).toBe(ownerPage)
  const other = randomUUID()
  expect(preferencesRootId(repo, other)).toBe(userPageBlockId(other, member.id))
})

// Boots a host database on the tab's rows; 1–3 s in the focused run.
it('reads as the tab does when pointed at its user page, and writes nothing there', async () => {
  // The owner's preferences change each outcome, so equality below is not the defaults agreeing.
  expect(groupedBacklinks.outcome(groupedBacklinks.onTab)).toEqual(['Beta', 'Other'])
  expect(groupedBacklinks.outcome(groupedBacklinks.withDefaults)).toEqual(['Alpha', 'Beta'])
  expect(dailyNoteBacklinks.outcome(dailyNoteBacklinks.onTab)).toBe(1)
  expect(dailyNoteBacklinks.outcome(dailyNoteBacklinks.withDefaults)).toBe(2)
  expect(ownerRows.map(row => row.id)).toContain(pluginPrefsBlockId(workspaceId, owner.id, groupedBacklinksPrefsType.id))
  const contexts = vi.spyOn(commands, 'createAgentRuntimeContext')
  const running = serve(ownerPage)
  const assertReadsMatchTab = async () => {
    for (const read of reads) expect(await running.execute(read.command)).toEqual(read.onTab)
  }
  try {
    await vi.waitFor(assertReadsMatchTab, {timeout: 10_000})
    const hostRepo = contexts.mock.calls[0]![0].repo
    // Both write targets are resolved; neither may land on the owner's page.
    const prefs = await getPluginPrefsBlock(hostRepo, workspaceId, hostRepo.user, groupedBacklinksPrefsType)
    await prefs.set(groupedBacklinksDefaultsProp, EMPTY_GROUPED_BACKLINKS_CONFIG)
    await getPluginUIStateBlock(hostRepo, workspaceId, hostRepo.user, groupedBacklinksPrefsType)
    await hostRepo.awaitProcessors()

    await assertReadsMatchTab()
    // Against the tab's rows, so a write during the host's boot counts too.
    expect((await ownerSubtree(host.db)).map(asServerRow)).toEqual(ownerRows)
    const queued = await host.db.getAll<{data: string}>('SELECT data FROM ps_crud')
    const queuedIds = queued.map(row => (JSON.parse(row.data) as {id: string}).id)
    expect(queuedIds).toContain(prefs.id)
    for (const {id} of ownerRows) expect(queuedIds).not.toContain(id)
  } finally {
    await running.stop()
  }
}, 20_000)

it.each([
  ['a page that is not a user page', target],
  ['a block naming a user but not at its user-page id', impostor],
  ['a block id the workspace does not have', randomUUID()],
])('refuses %s before serving reads', async (_name, id) => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  const running = serve(id)
  try {
    await vi.waitFor(() => expect(logged).toHaveBeenCalledWith('Could not open workspace data', expect.objectContaining({
      message: expect.stringContaining('is not a user page'),
    })), {timeout: 10_000})
    await expect(running.execute(groupedBacklinks.command)).rejects.toThrow(/^Headless gate closed:/)
  } finally {
    await running.stop()
  }
}, 20_000)
