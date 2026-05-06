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
import { ChangeScope } from '@/data/api'
import { aliasesProp, typesProp } from '@/data/properties'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '../../../data/repo'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { dailyNoteBlockId, journalBlockId, todayIso } from '@/data/dailyNotes'
import { resolveFacetRuntimeSync } from '@/extensions/facet'
import { roamTodoStateProp, statusProp, TODO_TYPE } from '@/plugins/todo/schema'
import { todoDataExtension } from '@/plugins/todo/dataExtension'
import { srsReschedulingDataExtension } from '@/plugins/srs-rescheduling/dataExtension'
import {
  SRS_SM25_TYPE,
  srsFactorProp,
  srsIntervalProp,
  srsNextReviewDateProp,
  srsReviewCountProp,
} from '@/plugins/srs-rescheduling/schema'
import { computeAliasSeatId } from '../../../data/targets'
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
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    todoDataExtension,
    srsReschedulingDataExtension,
  ]))
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

  it('imports Roam TODO markers as todo type metadata and strips the marker from content', async () => {
    const todoExport: RoamExport = [
      {
        title: 'todos',
        uid: 'todoPage',
        children: [
          {string: '#TODO write importer', uid: 'todoOpen'},
          {string: '{{[[DONE]]}} ship phase five', uid: 'todoDone'},
        ],
      },
    ]

    await importRoam(todoExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    const open = await readBlock(roamBlockId(WORKSPACE, 'todoOpen'))
    expect(open?.content).toBe('write importer')
    const openProps = JSON.parse(open!.properties_json) as Record<string, unknown>
    expect(openProps[typesProp.name]).toContain(TODO_TYPE)
    expect(openProps[statusProp.name]).toBe('open')
    expect(openProps[roamTodoStateProp.name]).toBe('TODO')

    const done = await readBlock(roamBlockId(WORKSPACE, 'todoDone'))
    expect(done?.content).toBe('ship phase five')
    const doneProps = JSON.parse(done!.properties_json) as Record<string, unknown>
    expect(doneProps[typesProp.name]).toContain(TODO_TYPE)
    expect(doneProps[statusProp.name]).toBe('done')
    expect(doneProps[roamTodoStateProp.name]).toBe('DONE')
  })

  it('preserves app-owned todo status while refreshing Roam source mirrors on re-import', async () => {
    const todoExport: RoamExport = [
      {
        title: 'todos',
        uid: 'todoPage',
        children: [
          {string: '#TODO write importer', uid: 'todoOpen'},
        ],
      },
    ]
    const todoId = roamBlockId(WORKSPACE, 'todoOpen')

    await importRoam(todoExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    await env.repo.tx(async tx => {
      const row = await tx.get(todoId)
      if (!row) throw new Error('expected imported todo row')
      await tx.update(todoId, {
        properties: {
          ...row.properties,
          [statusProp.name]: statusProp.codec.encode('done'),
          [roamTodoStateProp.name]: roamTodoStateProp.codec.encode('DONE'),
          'local:note': 'keep me',
        },
      })
    }, {scope: ChangeScope.BlockDefault})

    await importRoam(todoExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    const reimported = await readBlock(todoId)
    const reimportedProps = JSON.parse(reimported!.properties_json) as Record<string, unknown>
    expect(reimportedProps[statusProp.name]).toBe('done')
    expect(reimportedProps[roamTodoStateProp.name]).toBe('TODO')
    expect(reimportedProps['local:note']).toBe('keep me')

    await importRoam([
      {
        title: 'todos',
        uid: 'todoPage',
        children: [
          {string: 'write importer', uid: 'todoOpen'},
        ],
      },
    ], env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    const noMarker = await readBlock(todoId)
    const noMarkerProps = JSON.parse(noMarker!.properties_json) as Record<string, unknown>
    expect(noMarkerProps[statusProp.name]).toBe('done')
    expect(noMarkerProps[typesProp.name]).toContain(TODO_TYPE)
    expect(noMarkerProps[roamTodoStateProp.name]).toBeUndefined()
    expect(noMarkerProps['local:note']).toBe('keep me')
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

    // The alias block lives at the deterministic seat — same id any
    // future import (or parseReferences after the user types
    // [[Get really good at dancing]]) would land on, so the seats
    // unify across runs and across clients.
    expect(aliasRef!.id).toBe(computeAliasSeatId('Get really good at dancing', WORKSPACE))

    const aliasBlock = await readBlock(aliasRef!.id)
    expect(aliasBlock?.content).toBe('Get really good at dancing')
    expect(JSON.parse(aliasBlock!.properties_json)[aliasesProp.name])
      .toEqual(['Get really good at dancing'])
  })

  it('reuses an existing seat row instead of duplicating when re-imported', async () => {
    // First import materialises the seat at the deterministic id.
    await importRoam(minimalExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })
    const seatId = computeAliasSeatId('Get really good at dancing', WORKSPACE)
    expect(await readBlock(seatId)).not.toBeNull()

    // Second import of the same export. With deterministic seat ids,
    // createOrGet sees the live row and returns inserted=false, so
    // the import does NOT count this as a fresh alias block.
    const summary = await importRoam(minimalExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })
    expect(summary.aliasBlocksCreated).toBe(0)

    // No duplicate row at a different id — there is exactly one block
    // owning that alias.
    const owners = await env.h.db.getAll<{id: string}>(
      `SELECT id FROM blocks
       WHERE workspace_id = ?
         AND deleted = 0
         AND EXISTS (
           SELECT 1 FROM json_each(json_extract(properties_json, '$.alias'))
           WHERE value = ?
         )`,
      [WORKSPACE, 'Get really good at dancing'],
    )
    expect(owners.map(r => r.id)).toEqual([seatId])
  })

  it('points imports at a pre-existing seat instead of creating a parallel block', async () => {
    // Simulate the user typing `[[Get really good at dancing]]` BEFORE
    // running the import — parseReferences would land an empty stub at
    // the deterministic seat. We forge that state here directly so the
    // test doesn't depend on the parseReferences pipeline.
    const seatId = computeAliasSeatId('Get really good at dancing', WORKSPACE)
    await env.repo.tx(async tx => {
      await tx.create({
        id: seatId,
        workspaceId: WORKSPACE,
        parentId: null,
        orderKey: 'a0',
        content: '',
        properties: {
          [aliasesProp.name]: aliasesProp.codec.encode(['Get really good at dancing']),
        },
      })
    }, {scope: ChangeScope.BlockDefault})

    const summary = await importRoam(minimalExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    // findBlockByAliasInWorkspace finds the pre-existing seat → the
    // import resolves the alias to its id and does NOT create a fresh
    // row. (The seat-needs-materialisation list is computed from
    // lookup misses; this alias is a lookup hit, so it skips 5a.)
    expect(summary.aliasBlocksCreated).toBe(0)

    const parent = await readBlock(roamBlockId(WORKSPACE, 'parentA'))
    const refs = JSON.parse(parent!.references_json) as {id: string, alias: string}[]
    const aliasRef = refs.find(r => r.alias === 'Get really good at dancing')
    expect(aliasRef?.id).toBe(seatId)

    // The seat keeps its prior empty content (the import doesn't
    // clobber a pre-owned alias).
    const seat = await readBlock(seatId)
    expect(seat?.content).toBe('')
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

  it('writes only into the workspaceId option, never bleeds into others', async () => {
    // Regression for "import picks the first workspace" — exercise
    // the full plan→reconcile→write path with two workspaces present
    // and confirm rows land exclusively in the requested one. The
    // shortcut UI reads `repo.activeWorkspaceId` and passes it as
    // `workspaceId` here, so this also pins the contract that
    // importRoam respects its `workspaceId` argument verbatim.
    const OTHER_WS = 'ws-2'

    // Pre-seed OTHER_WS with a block that owns the "wcs/plan" alias —
    // if reconcilePages or alias-resolution looked up against the
    // wrong workspace, the import would merge into THIS row instead
    // of creating a fresh page in WORKSPACE.
    await env.repo.tx(async tx => {
      await tx.create({
        id: 'other-ws-seed',
        workspaceId: OTHER_WS,
        parentId: null,
        orderKey: 'a0',
        content: 'wcs/plan',
        properties: {[aliasesProp.name]: aliasesProp.codec.encode(['wcs/plan'])},
      })
    }, {scope: ChangeScope.BlockDefault})

    const summary = await importRoam(minimalExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    // Same expectations as the basic-tree test — pages created (not
    // merged), wcs/plan landed at the planner's deterministic id in
    // WORKSPACE.
    expect(summary.pagesCreated).toBe(1)
    expect(summary.pagesMerged).toBe(0)
    const wcsPlan = await readBlock(roamBlockId(WORKSPACE, 'pageA'))
    expect(wcsPlan?.content).toBe('wcs/plan')

    // Cross-workspace check: every imported block carries
    // workspace_id = WORKSPACE. OTHER_WS still has just its seed row.
    const wsCounts = await env.h.db.getAll<{workspace_id: string; n: number}>(
      'SELECT workspace_id, COUNT(*) AS n FROM blocks WHERE deleted = 0 GROUP BY workspace_id ORDER BY workspace_id',
    )
    const byWs = new Map(wsCounts.map(r => [r.workspace_id, r.n]))
    expect(byWs.get(OTHER_WS)).toBe(1) // only the pre-seed
    // WORKSPACE has the import (page + 2 descendants + alias seat) +
    // any daily-note frontmatter materialized for the export's daily.
    expect(byWs.get(WORKSPACE)).toBeGreaterThan(1)

    // The pre-seed in OTHER_WS keeps its content untouched.
    const otherSeed = await readBlock('other-ws-seed')
    expect(otherSeed?.content).toBe('wcs/plan')
  })

  it('chunks descendants across multiple txs without breaking parent links', async () => {
    // A four-deep chain so the descendant phase sees three rows
    // (parent + mid + leaf — page row is written in the frontmatter
    // tx). Setting descendantChunkSize=2 splits parent+mid into
    // chunk 0 and leaf into chunk 1; the leaf's parent must be
    // committed before its insert fires the workspace-invariant
    // trigger.
    const chainExport: RoamExport = [
      {
        title: 'page-chain',
        uid: 'pageChain',
        children: [
          {
            string: 'parent',
            uid: 'chainParent',
            children: [
              {
                string: 'mid',
                uid: 'chainMid',
                children: [
                  {
                    string: 'leaf',
                    uid: 'chainLeaf',
                  },
                ],
              },
            ],
          },
        ],
      },
    ]
    const progress: string[] = []
    const summary = await importRoam(chainExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
      descendantChunkSize: 2,
      onProgress: msg => progress.push(msg),
    })

    expect(summary.blocksWritten).toBe(3)
    // Two descendant chunks: 2 + 1. Per-chunk progress includes
    // throughput and ETA suffixes; we only assert the running counts
    // because timings are non-deterministic in tests.
    const chunkLogs = progress
      .filter(m => m.startsWith('Wrote descendants'))
      .map(m => m.replace(/ \(.*\)$/, ''))
    expect(chunkLogs).toEqual(['Wrote descendants 2/3', 'Wrote descendants 3/3'])

    const parent = await readBlock(roamBlockId(WORKSPACE, 'chainParent'))
    const mid = await readBlock(roamBlockId(WORKSPACE, 'chainMid'))
    const leaf = await readBlock(roamBlockId(WORKSPACE, 'chainLeaf'))
    expect(parent?.parent_id).toBe(roamBlockId(WORKSPACE, 'pageChain'))
    expect(mid?.parent_id).toBe(roamBlockId(WORKSPACE, 'chainParent'))
    expect(leaf?.parent_id).toBe(roamBlockId(WORKSPACE, 'chainMid'))
  })

  it('writes a post-import log block on today\'s daily-note with diagnostics as sub-bullets', async () => {
    // Export with two URL siblings (case 2 → list) and a deeply
    // nested attribute that triggers the "depth > 2" diagnostic.
    const noisyExport: RoamExport = [
      {
        title: 'noisy-page',
        uid: 'noisyPage',
        children: [
          {string: 'URL::https://a.example', uid: 'u1'},
          {string: 'URL::https://b.example', uid: 'u2'},
          {
            string: 'parent',
            uid: 'parent1',
            children: [{
              string: 'A::a',
              uid: 'A1',
              children: [{
                string: 'B::b',
                uid: 'B1',
                children: [{string: 'C::c', uid: 'C1'}],
              }],
            }],
          },
        ],
      },
    ]
    const summary = await importRoam(noisyExport, env.repo, {
      workspaceId: WORKSPACE, currentUserId: USER_ID,
    })
    expect(summary.diagnostics.length).toBeGreaterThan(0)

    const dailyId = dailyNoteBlockId(WORKSPACE, todayIso())
    // Find the import-log header — direct child of today's daily whose
    // content starts with "Roam import".
    const dailyChildren = await env.h.db.getAll<{
      id: string
      content: string
      order_key: string
    }>(
      'SELECT id, content, order_key FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id',
      [dailyId],
    )
    const header = dailyChildren.find(c => c.content.startsWith('Roam import '))
    expect(header).toBeDefined()
    expect(header!.content).toContain(`${summary.diagnostics.length} notes`)

    // Sub-bullets — one per diagnostic, in source order.
    const subs = await env.h.db.getAll<{content: string}>(
      'SELECT content FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id',
      [header!.id],
    )
    expect(subs.length).toBe(summary.diagnostics.length)
    for (let i = 0; i < summary.diagnostics.length; i++) {
      expect(subs[i].content).toBe(summary.diagnostics[i])
    }
  })

  it('posts isa type candidates to the import report block', async () => {
    const typedExport: RoamExport = [
      {
        title: 'Ada Lovelace',
        uid: 'adaPage',
        children: [
          {string: 'isa::[[import-test-person]]', uid: 'adaIsa'},
          {string: 'twitter::@ada', uid: 'adaTwitter'},
          {string: 'website::https://ada.example', uid: 'adaWebsite'},
        ],
      },
      {
        title: 'Grace Hopper',
        uid: 'gracePage',
        children: [
          {string: 'isa::[[import-test-person]]', uid: 'graceIsa'},
          {string: 'twitter::@grace', uid: 'graceTwitter'},
          {string: 'company::[[Navy]]', uid: 'graceCompany'},
        ],
      },
      {
        title: 'A Good Book',
        uid: 'bookPage',
        children: [
          {string: 'isa::[[import-test-book]]', uid: 'bookIsa'},
          {string: 'author::[[Some Author]]', uid: 'bookAuthor'},
        ],
      },
    ]

    const summary = await importRoam(typedExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    expect(summary.typeCandidates.map(candidate => candidate.alias))
      .toEqual(['import-test-person', 'import-test-book'])
    expect(summary.typeCandidates[0]).toMatchObject({
      alias: 'import-test-person',
      typeId: 'import-test-person',
      count: 2,
      commonProperties: [{name: 'roam:twitter', count: 2, percent: 100}],
    })

    const dailyId = dailyNoteBlockId(WORKSPACE, todayIso())
    const dailyChildren = await env.h.db.getAll<{
      id: string
      content: string
      order_key: string
    }>(
      'SELECT id, content, order_key FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id',
      [dailyId],
    )
    const header = dailyChildren.find(c => c.content.startsWith('Roam import '))
    expect(header).toBeDefined()
    expect(header!.content).toContain('2 type candidates')

    const reportChildren = await env.h.db.getAll<{id: string, content: string}>(
      'SELECT id, content FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id',
      [header!.id],
    )
    const section = reportChildren.find(c => c.content === 'Type candidates from isa::')
    expect(section).toBeDefined()

    const candidateLines = await env.h.db.getAll<{content: string}>(
      'SELECT content FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id',
      [section!.id],
    )
    expect(candidateLines.map(line => line.content)).toEqual([
      '[[import-test-person]] -> type "import-test-person" (2 nodes); common props: roam:twitter 2/2 (100%)',
      '[[import-test-book]] -> type "import-test-book" (1 node); common props: roam:author 1/1 (100%)',
    ])
  })

  it('merges imported pages through page_alias properties and reports the merge set', async () => {
    const aliasExport: RoamExport = [
      {
        title: 'page z',
        uid: 'pageZ',
        children: [
          {string: 'z child', uid: 'zChild'},
        ],
      },
      {
        title: 'page y',
        uid: 'pageY',
        children: [
          {string: 'page_alias::[[page z]]', uid: 'aliasYZ'},
          {string: 'y child', uid: 'yChild'},
        ],
      },
      {
        title: 'page x',
        uid: 'pageX',
        children: [
          {string: 'page_alias::[[page y]]', uid: 'aliasXY'},
          {string: 'x child', uid: 'xChild'},
        ],
      },
    ]

    const summary = await importRoam(aliasExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    expect(summary.pagesCreated).toBe(1)
    expect(summary.pagesMerged).toBe(2)
    expect(summary.diagnostics).toContain(
      "[[page x]] also had 'page y' and 'page z' merged in bc of the alias rule",
    )

    const canonicalId = roamBlockId(WORKSPACE, 'pageX')
    const canonical = await readBlock(canonicalId)
    expect(canonical).not.toBeNull()
    expect(JSON.parse(canonical!.properties_json)[aliasesProp.name])
      .toEqual(['page x', 'page y', 'page z'])

    expect(await readBlock(roamBlockId(WORKSPACE, 'pageY'))).toBeNull()
    expect(await readBlock(roamBlockId(WORKSPACE, 'pageZ'))).toBeNull()

    const yChild = await readBlock(roamBlockId(WORKSPACE, 'yChild'))
    const zChild = await readBlock(roamBlockId(WORKSPACE, 'zChild'))
    expect(yChild?.parent_id).toBe(canonicalId)
    expect(zChild?.parent_id).toBe(canonicalId)

    const aliasBlock = await readBlock(roamBlockId(WORKSPACE, 'aliasXY'))
    expect(aliasBlock?.parent_id).toBe(canonicalId)
    expect(aliasBlock?.content).toBe('page_alias::[[page y]]')
  })

  it('imports Roam SRS SM-2.5 markers as typed parent metadata', async () => {
    const srsExport: RoamExport = [
      {
        title: 'srs',
        uid: 'srsPage',
        children: [
          {
            string: 'parent',
            uid: 'srsParent',
            children: [
              {
                string: '[[[[interval]]:31.1]] [[[[factor]]:2.50]] [[June 6th, 2026]] * * *',
                uid: 'srsMarker',
              },
            ],
          },
        ],
      },
    ]

    const summary = await importRoam(srsExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    expect(summary.aliasBlocksCreated).toBe(4)

    const parent = await readBlock(roamBlockId(WORKSPACE, 'srsParent'))
    const props = JSON.parse(parent!.properties_json) as Record<string, unknown>
    const nextReviewDateId = dailyNoteBlockId(WORKSPACE, '2026-06-06')

    expect(props[typesProp.name]).toContain(SRS_SM25_TYPE)
    expect(props[srsIntervalProp.name]).toBe(31.1)
    expect(props[srsFactorProp.name]).toBe(2.5)
    expect(props[srsNextReviewDateProp.name]).toBe(nextReviewDateId)
    expect(props[srsReviewCountProp.name]).toBe(3)

    const refs = JSON.parse(parent!.references_json) as {
      id: string
      alias: string
      sourceField?: string
    }[]
    expect(refs).toContainEqual({
      id: nextReviewDateId,
      alias: 'June 6th, 2026',
      sourceField: srsNextReviewDateProp.name,
    })

    const daily = await readBlock(nextReviewDateId)
    expect(daily).not.toBeNull()

    const marker = await readBlock(roamBlockId(WORKSPACE, 'srsMarker'))
    expect(marker?.content)
      .toBe('[[[[interval]]:31.1]] [[[[factor]]:2.50]] [[June 6th, 2026]] * * *')
    const markerRefs = JSON.parse(marker!.references_json) as {id: string, alias: string}[]
    expect(markerRefs).toEqual(expect.arrayContaining([
      {
        id: computeAliasSeatId('[[interval]]:31.1', WORKSPACE),
        alias: '[[interval]]:31.1',
      },
      {
        id: computeAliasSeatId('interval', WORKSPACE),
        alias: 'interval',
      },
      {
        id: computeAliasSeatId('[[factor]]:2.50', WORKSPACE),
        alias: '[[factor]]:2.50',
      },
      {
        id: computeAliasSeatId('factor', WORKSPACE),
        alias: 'factor',
      },
      {
        id: nextReviewDateId,
        alias: 'June 6th, 2026',
      },
    ]))
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
