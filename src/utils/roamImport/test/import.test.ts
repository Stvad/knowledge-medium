// @vitest-environment node
/**
 * End-to-end tests for `importRoam` — the orchestrator that takes a
 * planImport output and writes pages + descendants to a workspace.
 *
 * Coverage:
 *   - Pages + descendants written with planned ids; tree shape
 *     reflects parentId pointers
 *   - Daily pages routed through getOrCreateDailyNote and parented
 *     under the workspace's journal
 *   - `[[alias]]` references resolve to imported page final ids
 *   - Permanent alias blocks created for unmatched `[[alias]]`
 *     references in content
 *   - Dry-run reports counts without writing rows
 *
 * Replaces deleted `src/utils/roamImport/test/import.test.ts` (legacy
 * 3-arg `new Repo(db, undoRedoManager, user)` + stub-DB regex
 * router). The new test runs against `createTestDb` (real PowerSync
 * + tx engine) so the importer's tx writes hit the same triggers as
 * production.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { aliasesProp } from '@/data/properties'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/internals/repo'
import { dailyNoteBlockId, journalBlockId } from '@/data/dailyNotes'
import { importRoam } from '../import'
import { roamBlockId } from '../ids'
import type { RoamExport } from '../types'

const WORKSPACE = 'ws-1'
const USER_ID = 'user-1'

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  const h = await createTestDb()
  const cache = new BlockCache()
  let timeCursor = 1700_000_000_000
  let idCursor = 0
  const repo = new Repo({
    db: h.db,
    cache,
    user: {id: USER_ID},
    now: () => ++timeCursor,
    newId: () => `gen-${++idCursor}`,
    // The importer pre-populates references[] explicitly; running
    // parseReferences on top would re-parse content + clobber. The
    // importer also calls processors itself for alias resolution.
    registerKernelProcessors: false,
  })
  return {h, repo}
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

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
      },
    ],
  },
]

const readBlock = (id: string) =>
  env.h.db.getOptional<{
    id: string
    parent_id: string | null
    content: string
    properties_json: string
    references_json: string
    deleted: 0 | 1
  }>('SELECT id, parent_id, content, properties_json, references_json, deleted FROM blocks WHERE id = ?', [id])

describe('importRoam', () => {
  it('writes pages and descendants to the repo with planned ids', async () => {
    const summary = await importRoam(minimalExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    expect(summary.pagesCreated).toBe(1)
    expect(summary.pagesDaily).toBe(1)
    expect(summary.blocksWritten).toBe(3)

    const wcsPlanId = roamBlockId(WORKSPACE, 'pageA')
    const wcsPlan = await readBlock(wcsPlanId)
    expect(wcsPlan).not.toBeNull()
    expect(wcsPlan?.content).toBe('wcs/plan')
    expect(JSON.parse(wcsPlan!.properties_json)[aliasesProp.name]).toEqual(['wcs/plan'])
    expect(wcsPlan?.parent_id).toBeNull()

    const parent = await readBlock(roamBlockId(WORKSPACE, 'parentA'))
    expect(parent?.parent_id).toBe(wcsPlanId)
    expect(parent?.content).toBe(
      `see [[Get really good at dancing]] and ((${roamBlockId(WORKSPACE, 'leafA')}))`,
    )

    const leaf = await readBlock(roamBlockId(WORKSPACE, 'leafA'))
    expect(leaf?.parent_id).toBe(roamBlockId(WORKSPACE, 'parentA'))
    expect(leaf?.content).toBe('leaf with [[wcs/plan]]')
  })

  it('routes daily pages through getOrCreateDailyNote and parents children there', async () => {
    await importRoam(minimalExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    const dailyId = dailyNoteBlockId(WORKSPACE, '2026-04-28')
    const daily = await readBlock(dailyId)
    expect(daily).not.toBeNull()
    expect(daily?.parent_id).toBe(journalBlockId(WORKSPACE))
    const dailyAliases = JSON.parse(daily!.properties_json)[aliasesProp.name] as string[]
    expect(dailyAliases).toContain('2026-04-28')

    const child = await readBlock(roamBlockId(WORKSPACE, 'dailyChild'))
    expect(child?.parent_id).toBe(dailyId)
    expect(child?.content).toBe('morning notes')
  })

  it('resolves [[alias]] references to imported page final ids', async () => {
    await importRoam(minimalExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    const leaf = await readBlock(roamBlockId(WORKSPACE, 'leafA'))
    const refs = JSON.parse(leaf!.references_json) as {id: string, alias: string}[]
    // Leaf content references [[wcs/plan]] which is an imported page.
    expect(refs.some(r =>
      r.alias === 'wcs/plan' && r.id === roamBlockId(WORKSPACE, 'pageA'),
    )).toBe(true)
  })

  it('creates permanent alias blocks for unmatched [[alias]] references', async () => {
    const summary = await importRoam(minimalExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    // "Get really good at dancing" wasn't an imported page and no
    // existing alias matched, so the importer creates a permanent
    // alias block we can backlink against.
    expect(summary.aliasBlocksCreated).toBeGreaterThanOrEqual(1)

    const parent = await readBlock(roamBlockId(WORKSPACE, 'parentA'))
    const refs = JSON.parse(parent!.references_json) as {id: string, alias: string}[]
    const aliasRef = refs.find(r => r.alias === 'Get really good at dancing')
    expect(aliasRef).toBeDefined()

    const aliasBlock = await readBlock(aliasRef!.id)
    expect(aliasBlock?.content).toBe('Get really good at dancing')
    expect(JSON.parse(aliasBlock!.properties_json)[aliasesProp.name])
      .toEqual(['Get really good at dancing'])
  })

  it('upgrades a previously-imported placeholder when a later import contains the real block', async () => {
    // First pass: an export that *references* leafA but the real block
    // for leafA isn't in the children of any imported page. The
    // planner emits a placeholder for it (so backlinks can resolve).
    const placeholderExport: RoamExport = [
      {
        title: 'page-with-ref',
        uid: 'pageRef',
        children: [
          {
            string: 'block with ((leafA))',
            uid: 'parentRef',
            ':block/refs': [{':block/uid': 'leafA'}],
          },
        ],
      },
    ]
    await importRoam(placeholderExport, env.repo, {
      workspaceId: WORKSPACE, currentUserId: USER_ID,
    })

    const leafId = roamBlockId(WORKSPACE, 'leafA')
    const beforeUpgrade = await readBlock(leafId)
    expect(beforeUpgrade?.content).toBe('')           // placeholder
    expect(beforeUpgrade?.parent_id).toBeNull()        // root-level

    // Second pass: a different export that contains the real leafA
    // block under a parent. The upgraded row should now have the real
    // content + parent.
    const realExport: RoamExport = [
      {
        title: 'page-with-leaf',
        uid: 'pageLeaf',
        children: [
          {
            string: 'parent of leaf',
            uid: 'parentLeaf',
            children: [
              {
                string: 'real leaf content',
                uid: 'leafA',
              },
            ],
          },
        ],
      },
    ]
    await importRoam(realExport, env.repo, {
      workspaceId: WORKSPACE, currentUserId: USER_ID,
    })

    const afterUpgrade = await readBlock(leafId)
    expect(afterUpgrade?.content).toBe('real leaf content')
    expect(afterUpgrade?.parent_id).toBe(roamBlockId(WORKSPACE, 'parentLeaf'))
  })

  it('restores a tombstoned imported block on re-import', async () => {
    // First import lands the block.
    await importRoam(minimalExport, env.repo, {
      workspaceId: WORKSPACE, currentUserId: USER_ID,
    })

    const leafId = roamBlockId(WORKSPACE, 'leafA')
    expect((await readBlock(leafId))?.deleted).toBe(0)

    // Simulate user deletion of the imported block (subtree-aware).
    await env.repo.mutate.delete({id: leafId})
    expect((await readBlock(leafId))?.deleted).toBe(1)

    // Re-import the same export — without the tombstone-restore
    // branch, this would throw DeletedConflictError and abort the tx.
    await importRoam(minimalExport, env.repo, {
      workspaceId: WORKSPACE, currentUserId: USER_ID,
    })

    const restored = await readBlock(leafId)
    expect(restored?.deleted).toBe(0)
    expect(restored?.content).toBe('leaf with [[wcs/plan]]')
    expect(restored?.parent_id).toBe(roamBlockId(WORKSPACE, 'parentA'))
  })

  it('restores a tombstoned placeholder on re-import', async () => {
    // First import has an unresolved ((leafA)) ref → emits placeholder.
    const placeholderExport: RoamExport = [
      {
        title: 'page-with-ref',
        uid: 'pageRef',
        children: [
          {
            string: 'block with ((leafA))',
            uid: 'parentRef',
            ':block/refs': [{':block/uid': 'leafA'}],
          },
        ],
      },
    ]
    await importRoam(placeholderExport, env.repo, {
      workspaceId: WORKSPACE, currentUserId: USER_ID,
    })

    const placeholderId = roamBlockId(WORKSPACE, 'leafA')
    expect((await readBlock(placeholderId))?.deleted).toBe(0)

    // User deletes the placeholder.
    await env.repo.mutate.delete({id: placeholderId})
    expect((await readBlock(placeholderId))?.deleted).toBe(1)

    // Re-importing the same placeholder-emitting export should not
    // crash; the placeholder row is restored so refs resolve again.
    await importRoam(placeholderExport, env.repo, {
      workspaceId: WORKSPACE, currentUserId: USER_ID,
    })

    const restored = await readBlock(placeholderId)
    expect(restored?.deleted).toBe(0)
    expect(restored?.content).toBe('')
  })

  it('dry-run reports counts without writing rows', async () => {
    const summary = await importRoam(minimalExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
      dryRun: true,
    })

    expect(summary.dryRun).toBe(true)
    expect(summary.blocksWritten).toBe(3)

    // No rows should have been written.
    const counts = await env.h.db.get<{count: number}>('SELECT COUNT(*) AS count FROM blocks')
    expect(counts.count).toBe(0)
  })
})
