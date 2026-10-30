// @vitest-environment jsdom
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {ChangeScope, type SubtreeRow} from '@/data/api'
import {PAGE_TYPE} from '@/data/blockTypes'
import {typesProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {resolveAppRuntimeSync} from '@/facets/resolveAppRuntime'
import {staticAppExtensions} from '@/extensions/staticAppExtensions'
import {resolveDeletionRefusal} from '@/extensions/core'
import {definitionSeedsFacet, typeSeedsFacet} from '@/data/facets'
import {materializePropertySeeds, materializeTypeSeeds} from '@/data/definitionSeeds'
import {getOrCreatePropertiesPage, propertiesPageBlockId} from '@/data/propertiesPage'
import {getOrCreateTypesPage, typesPageBlockId} from '@/data/typesPage'
import {getOrCreateMigrationsPage, migrationsPageBlockId} from '@/data/migrationsPage'
import {getOrCreateRecentsPage, recentsPageBlockId} from '@/data/recentsPage'
import {getOrCreateKernelPage, kernelPageBlockId} from '@/data/kernelPage'
import {getOrCreateJournalBlock, journalBlockId} from '@/plugins/daily-notes/dailyNotes'
import {getOrCreateLocationsPage, locationsPageBlockId} from '@/plugins/geo/locationsPage'
import {assetsPageSpec} from '@/plugins/attachments/mediaBlock'
import {getOrCreateCommentsPage, commentsPageBlockId} from '@/plugins/annotations/container'
import {createThread} from '@/plugins/annotations/threads'
import {getOrCreateReviewDeck, reviewDeckBlockId} from '@/plugins/srs-review/deck'
import {deleteBlocksThroughUi} from '@/utils/deleteBlockThroughUi'
import {openDialog} from '@/utils/dialogs'

vi.mock('@/utils/dialogs', () => ({openDialog: vi.fn(async () => true)}))
vi.mock('@/utils/toast', () => ({showInfo: vi.fn()}))

const WS = 'ws'
const opts = {scope: ChangeScope.BlockDefault}
let db: TestDb
let repo: Repo
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  vi.clearAllMocks()
  await resetTestDb(db.db)
  repo = createTestRepo({db: db.db, user: {id: 'user'}, newId: () => crypto.randomUUID()}).repo
  const runtime = resolveAppRuntimeSync(staticAppExtensions({repo}), {
    overrides: new Map(), context: {repo, workspaceId: WS, safeMode: false},
  })
  repo.setFacetRuntime(runtime)
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Notes',
      properties: {[typesProp.name]: [PAGE_TYPE]}})
    await tx.create({id: 'target', workspaceId: WS, parentId: 'page', orderKey: 'a0', content: 'Text'})
  }, {...opts, allowUnloadedWorkspace: true})
  await repo.ensureSystemPages(WS)
  await materializePropertySeeds(repo, WS, runtime.read(definitionSeedsFacet))
  await materializeTypeSeeds(repo, WS, runtime.read(typeSeedsFacet))
})

// Independent of the facet: a missing owner contribution must fail its case.
const expectedPages = [
  {alias: 'Properties', ensure: getOrCreatePropertiesPage},
  {alias: 'Types', ensure: getOrCreateTypesPage},
  {alias: 'Recents', ensure: getOrCreateRecentsPage},
  {alias: 'System Migrations (km)', ensure: getOrCreateMigrationsPage},
  {alias: 'Journal', ensure: getOrCreateJournalBlock},
  {alias: 'Locations', ensure: getOrCreateLocationsPage},
  {alias: 'Assets', ensure: (r: Repo, ws: string) => getOrCreateKernelPage(r, ws, assetsPageSpec, {skipUndo: true})},
  {alias: 'Comments (km)', ensure: getOrCreateCommentsPage},
  {alias: 'SRS Review', ensure: getOrCreateReviewDeck},
]

describe('kernel page UI deletion under the static app runtime', () => {
  it('bootstraps eager pages without creating lazy pages', async () => {
    for (const id of [propertiesPageBlockId(WS), typesPageBlockId(WS), recentsPageBlockId(WS),
      journalBlockId(WS), locationsPageBlockId(WS)]) expect(await repo.load(id)).not.toBeNull()
    for (const id of [migrationsPageBlockId(WS), kernelPageBlockId(WS, assetsPageSpec.namespace),
      commentsPageBlockId(WS), reviewDeckBlockId(WS)]) expect(await repo.load(id)).toBeNull()
  })

  it.each(expectedPages)('refuses $alias before any write or confirmation', async ({alias, ensure}) => {
    const page = await ensure(repo, WS)
    if (alias !== 'Comments (km)') {
      await repo.mutate.createChild({parentId: page.id, content: 'Filed record'})
    }
    await page.load()
    const subtree = await repo.runQuery<SubtreeRow[]>('core.subtree', {id: page.id})
    expect(subtree.length).toBeGreaterThan(0)
    if (alias === 'Comments (km)') expect(subtree).toHaveLength(1)
    if (alias === 'Properties' || alias === 'Types') expect(subtree.length).toBeGreaterThan(20)
    const tx = vi.spyOn(repo, 'tx')
    try {
      expect(await resolveDeletionRefusal(repo, page)).toContain(alias)
      expect(await deleteBlocksThroughUi([page])).toBe(false)
      expect(tx).not.toHaveBeenCalled()
      expect(openDialog).not.toHaveBeenCalled()
      const after = await repo.runQuery<SubtreeRow[]>('core.subtree', {id: page.id})
      expect(after).toEqual(subtree)
      for (const row of subtree) expect(await repo.load(row.id)).not.toBeNull()
    } finally {
      tx.mockRestore()
    }
  })

  it('deletes an ordinary page holding a thread root moved there by hand', async () => {
    const {threadId, commentId} = await createThread(repo, {targetId: 'target', anchor: null, comment: 'Comment'})
    await repo.mutate.move({id: threadId, parentId: 'page', position: {kind: 'last'}})
    const page = repo.block('page')
    await page.load()
    expect((await repo.load(threadId))?.parentId).toBe(page.id)
    expect(await resolveDeletionRefusal(repo, page)).toBeNull()
    expect(await deleteBlocksThroughUi([page])).toBe(true)
    for (const id of [page.id, threadId, commentId!]) expect(await repo.load(id)).toBeNull()
  })
})
