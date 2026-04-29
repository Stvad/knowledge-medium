import { describe, expect, it, vi } from 'vitest'
import type { PowerSyncDatabase } from '@powersync/web'
import { Repo } from '@/data/repo'
import { UndoRedoManager } from '@/data/undoRedo'
import { blockToRowParams } from '@/data/blockSchema'
import { dailyNoteBlockId, journalBlockId } from '@/data/dailyNotes'
import { aliasProp, fromList } from '@/data/properties'
import type { BlockData, User } from '@/types'
import { importRoam } from '../import'
import { roamBlockId } from '../ids'
import type { RoamExport } from '../types'

const WORKSPACE = 'ws-1'
const USER_ID = 'user-1'

const makeStubDb = (
  overrides: Partial<{
    getAll: PowerSyncDatabase['getAll']
    getOptional: PowerSyncDatabase['getOptional']
  }> = {},
): PowerSyncDatabase =>
  ({
    onChange: () => () => {},
    writeLock: async () => undefined,
    getOptional: overrides.getOptional ?? (async () => null),
    getAll: overrides.getAll ?? (async () => []),
    get: async () => ({seq: 0}),
    execute: async () => undefined,
  }) as unknown as PowerSyncDatabase

const makeUser = (): User => ({id: USER_ID, name: 'Test'})

const blockData = (overrides: Partial<BlockData> = {}): BlockData => ({
  id: overrides.id ?? 'block',
  workspaceId: overrides.workspaceId ?? WORKSPACE,
  content: overrides.content ?? '',
  properties: overrides.properties ?? {},
  childIds: overrides.childIds ?? [],
  parentId: overrides.parentId,
  createTime: overrides.createTime ?? 0,
  updateTime: overrides.updateTime ?? 0,
  createdByUserId: overrides.createdByUserId ?? USER_ID,
  updatedByUserId: overrides.updatedByUserId ?? USER_ID,
  references: overrides.references ?? [],
  deleted: overrides.deleted ?? false,
})

const toRow = (data: BlockData) => {
  const params = blockToRowParams(data)
  return {
    id: params[0],
    workspace_id: params[1],
    content: params[2],
    properties_json: params[3],
    child_ids_json: params[4],
    parent_id: params[5],
    create_time: params[6],
    update_time: params[7],
    created_by_user_id: params[8],
    updated_by_user_id: params[9],
    references_json: params[10],
    deleted: params[11],
  }
}

interface StubOptions {
  byId?: Map<string, BlockData>
  byAlias?: Map<string, BlockData>
}

const stubRepo = ({byId = new Map(), byAlias = new Map()}: StubOptions = {}) => {
  const getOptional = vi.fn(async (sql: string, params?: unknown[]) => {
    if (typeof sql !== 'string') return null
    if (/WHERE id = \?/.test(sql)) {
      const id = (params as string[])[0]
      const row = byId.get(id)
      return row ? toRow(row) : null
    }
    // findBlockByAliasInWorkspace looks up by alias via JSON_EACH
    if (/json_each|alias/i.test(sql)) {
      // Brutal heuristic — first param after workspace is the alias text.
      const alias = (params as string[]).find(p => byAlias.has(p))
      if (alias) {
        const row = byAlias.get(alias)
        return row ? toRow(row) : null
      }
    }
    return null
  })

  const getAll = vi.fn(async () => [])
  const repo = new Repo(
    makeStubDb({
      getOptional: getOptional as PowerSyncDatabase['getOptional'],
      getAll: getAll as PowerSyncDatabase['getAll'],
    }),
    new UndoRedoManager(),
    makeUser(),
  )
  repo.setActiveWorkspaceId(WORKSPACE)
  return repo
}

const minimalExport: RoamExport = [
  {
    title: 'wcs/plan',
    uid: 'pageA',
    'create-time': 1700000000000,
    'edit-time': 1700000001000,
    children: [
      {
        string: 'see [[Get really good at dancing]] and ((leafA))',
        uid: 'parentA',
        'create-time': 1700000002000,
        'edit-time': 1700000002000,
        ':block/refs': [{':block/uid': 'leafA'}],
        children: [
          {
            string: 'leaf with [[wcs/plan]]',
            uid: 'leafA',
            'create-time': 1700000003000,
          },
        ],
      },
    ],
  },
  {
    title: 'April 28th, 2026',
    uid: '04-28-2026',
    ':log/id': 1777334400000,
    'create-time': 1777334400000,
    children: [
      {
        string: 'morning notes',
        uid: 'dailyChild',
        'create-time': 1777334401000,
      },
    ],
  },
]

describe('importRoam', () => {
  it('writes pages and descendants to the repo with planned ids', async () => {
    const repo = stubRepo()

    const summary = await importRoam(minimalExport, repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    expect(summary.pagesCreated).toBe(1)
    expect(summary.pagesDaily).toBe(1)
    expect(summary.blocksWritten).toBe(3)

    const wcsPlanId = roamBlockId(WORKSPACE, 'pageA')
    const wcsPlan = repo.find(wcsPlanId).dataSync()
    expect(wcsPlan).toBeDefined()
    expect(wcsPlan?.content).toBe('wcs/plan')
    expect(wcsPlan?.properties.alias?.value).toEqual(['wcs/plan'])
    expect(wcsPlan?.childIds).toEqual([roamBlockId(WORKSPACE, 'parentA')])

    const parent = repo.find(roamBlockId(WORKSPACE, 'parentA')).dataSync()
    expect(parent?.parentId).toBe(wcsPlanId)
    expect(parent?.content).toBe(
      `see [[Get really good at dancing]] and ((${roamBlockId(WORKSPACE, 'leafA')}))`,
    )

    const leaf = repo.find(roamBlockId(WORKSPACE, 'leafA')).dataSync()
    expect(leaf?.parentId).toBe(roamBlockId(WORKSPACE, 'parentA'))
    expect(leaf?.content).toBe('leaf with [[wcs/plan]]')
  })

  it('routes daily pages through getOrCreateDailyNote and appends children', async () => {
    const repo = stubRepo()
    await importRoam(minimalExport, repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    const dailyId = dailyNoteBlockId(WORKSPACE, '2026-04-28')
    const daily = repo.find(dailyId).dataSync()
    expect(daily).toBeDefined()
    expect(daily?.parentId).toBe(journalBlockId(WORKSPACE))

    // Daily-note metadata is preserved (alias list, type) AND the
    // imported descendant landed under it.
    expect(daily?.properties.alias?.value).toEqual(['April 28th, 2026', '2026-04-28'])
    expect(daily?.childIds).toContain(roamBlockId(WORKSPACE, 'dailyChild'))

    const child = repo.find(roamBlockId(WORKSPACE, 'dailyChild')).dataSync()
    expect(child?.parentId).toBe(dailyId)
  })

  it('resolves [[alias]] references to imported page final ids', async () => {
    const repo = stubRepo()
    await importRoam(minimalExport, repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    const leaf = repo.find(roamBlockId(WORKSPACE, 'leafA')).dataSync()
    const refs = leaf?.references ?? []
    // Leaf content references [[wcs/plan]] which is an imported page.
    expect(refs.some(r =>
      r.alias === 'wcs/plan' && r.id === roamBlockId(WORKSPACE, 'pageA'),
    )).toBe(true)
  })

  it('creates permanent alias blocks for unmatched aliases referenced in content', async () => {
    const repo = stubRepo()
    const summary = await importRoam(minimalExport, repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    // "Get really good at dancing" wasn't an imported page and no
    // existing alias matched, so the importer creates a permanent alias
    // block we can backlink against.
    expect(summary.aliasBlocksCreated).toBeGreaterThanOrEqual(1)

    const parent = repo.find(roamBlockId(WORKSPACE, 'parentA')).dataSync()
    const aliasRef = parent?.references.find(r => r.alias === 'Get really good at dancing')
    expect(aliasRef).toBeDefined()
    expect(aliasRef?.id).toBeDefined()
    // The new block exists in the repo and carries the alias.
    if (aliasRef) {
      const aliasBlock = repo.find(aliasRef.id).dataSync()
      expect(aliasBlock?.content).toBe('Get really good at dancing')
      expect(aliasBlock?.properties.alias?.value).toEqual(['Get really good at dancing'])
    }
  })

  it('dry-run returns counts and writes nothing', async () => {
    const repo = stubRepo()
    const summary = await importRoam(minimalExport, repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
      dryRun: true,
    })

    expect(summary.dryRun).toBe(true)
    expect(summary.blocksWritten).toBe(3)

    // Repo cache should not contain any imported blocks.
    expect(repo.getCachedBlockData(roamBlockId(WORKSPACE, 'pageA'))).toBeUndefined()
    expect(repo.getCachedBlockData(roamBlockId(WORKSPACE, 'parentA'))).toBeUndefined()
    expect(repo.getCachedBlockData(roamBlockId(WORKSPACE, 'leafA'))).toBeUndefined()
  })

  it('merges into existing alias-page when one is found in the workspace', async () => {
    const existingPage = blockData({
      id: 'existing-wcs-plan-id',
      content: 'wcs/plan',
      properties: fromList(aliasProp(['wcs/plan'])),
    })
    const byId = new Map<string, BlockData>([[existingPage.id, existingPage]])
    const byAlias = new Map<string, BlockData>([['wcs/plan', existingPage]])
    const repo = stubRepo({byId, byAlias})

    const summary = await importRoam(minimalExport, repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    expect(summary.pagesMerged).toBe(1)
    expect(summary.pagesCreated).toBe(0)

    // Existing page should now own the imported children.
    const merged = repo.find('existing-wcs-plan-id').dataSync()
    expect(merged?.childIds).toContain(roamBlockId(WORKSPACE, 'parentA'))

    // Reparented direct child points at the existing page id, not the
    // would-be planned page id.
    const parent = repo.find(roamBlockId(WORKSPACE, 'parentA')).dataSync()
    expect(parent?.parentId).toBe('existing-wcs-plan-id')
  })
})
