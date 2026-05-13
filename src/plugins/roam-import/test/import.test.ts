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
import {
  dailyNoteBlockId,
  dailyNotesDataExtension,
  journalBlockId,
  todayIso,
} from '@/plugins/daily-notes'
import { resolveFacetRuntimeSync } from '@/extensions/facet'
import { roamTodoStateProp, statusProp, TODO_TYPE } from '@/plugins/todo/schema'
import { todoDataExtension } from '@/plugins/todo/dataExtension'
import { srsReschedulingDataExtension } from '@/plugins/srs-rescheduling/dataExtension'
import {
  SRS_SM25_TYPE,
  srsArchivedProp,
  srsFactorProp,
  srsGradeProp,
  srsIntervalProp,
  srsNextReviewDateProp,
  srsReviewCountProp,
  srsSnapshotHistoryProp,
} from '@/plugins/srs-rescheduling/schema'
import { computeAliasSeatId } from '../../../data/targets'
import { importRoam } from '../import'
import { roamBlockId } from '../ids'
import { ROAM_PAGE_ALIAS_PROP } from '../properties'
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
    dailyNotesDataExtension,
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

const readChildren = (parentId: string) =>
  env.h.db.getAll<{id: string, content: string}>(
    'SELECT id, content FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id',
    [parentId],
  )

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

  it('preserves Roam source-only fields as namespaced properties', async () => {
    const sourceFieldExport: RoamExport = [{
      title: 'source fields',
      uid: 'sourceFieldsPage',
      ':log/id': 1777334400000,
      ':create/user': {':user/uid': 'roam-create-user'},
      ':edit/user': {':user/uid': 'roam-edit-user'},
      children: [{
        string: 'aligned reaction',
        uid: 'sourceFieldsBlock',
        'text-align': 'center',
        emojis: [{
          emoji: {native: '👍'},
          users: [{uid: 'roam-create-user', time: 1700000000000}],
        }],
      }],
    }]

    await importRoam(sourceFieldExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    const page = await readBlock(dailyNoteBlockId(WORKSPACE, '2026-04-28'))
    const pageProps = JSON.parse(page!.properties_json) as Record<string, unknown>
    expect(pageProps['roam:log/id']).toBe(1777334400000)
    expect(pageProps['roam:create/user']).toBe('roam-create-user')
    expect(pageProps['roam:edit/user']).toBe('roam-edit-user')

    const block = await readBlock(roamBlockId(WORKSPACE, 'sourceFieldsBlock'))
    const blockProps = JSON.parse(block!.properties_json) as Record<string, unknown>
    expect(blockProps['roam:text-align']).toBe('center')
    expect(JSON.parse(blockProps['roam:emojis'] as string)).toEqual([{
      emoji: {native: '👍'},
      users: [{uid: 'roam-create-user', time: 1700000000000}],
    }])
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

  it('imports DONE SRS marker-only children as archived SM-2.5 metadata on the parent', async () => {
    const srsExport: RoamExport = [{
      title: 'srs archived',
      uid: 'srsArchivedPage',
      children: [{
        string: 'Archived card',
        uid: 'srsArchivedParent',
        children: [{
          string: '[[[[interval]]:5]] [[[[factor]]:2.00]] [[June 6th, 2026]] [[DONE]]',
          uid: 'srsArchivedMarker',
        }],
      }],
    }]

    await importRoam(srsExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    const parent = await readBlock(roamBlockId(WORKSPACE, 'srsArchivedParent'))
    const props = JSON.parse(parent!.properties_json) as Record<string, unknown>
    expect(props[typesProp.name]).toContain(SRS_SM25_TYPE)
    expect(props[srsIntervalProp.name]).toBe(5)
    expect(props[srsArchivedProp.name]).toBe(true)

    const marker = await readBlock(roamBlockId(WORKSPACE, 'srsArchivedMarker'))
    expect(marker?.content).toBe('[[[[interval]]:5]] [[[[factor]]:2.00]] [[June 6th, 2026]] [[DONE]]')
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

  it('imports stale-log-id daily pages by title without alias collisions', async () => {
    await importRoam([
      {
        title: 'scratch',
        uid: 'scratchPage',
        children: [
          {
            string: 'see [[January 21st, 2020]]',
            uid: 'linkingBlock',
          },
        ],
      },
      {
        title: 'January 21st, 2020',
        uid: 'staleLogDaily',
        ':log/id': 1579678296357, // 2020-01-22T07:31:36.357Z
        'create-time': 1579678296357,
        children: [
          {
            string: 'daily note body',
            uid: 'staleLogDailyChild',
          },
        ],
      },
    ], env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    const jan21Id = dailyNoteBlockId(WORKSPACE, '2020-01-21')
    const jan22Id = dailyNoteBlockId(WORKSPACE, '2020-01-22')
    const jan21 = await readBlock(jan21Id)
    const jan22 = await readBlock(jan22Id)
    const child = await readBlock(roamBlockId(WORKSPACE, 'staleLogDailyChild'))
    const linking = await readBlock(roamBlockId(WORKSPACE, 'linkingBlock'))
    const refs = JSON.parse(linking!.references_json) as {id: string, alias: string}[]

    expect(jan21).not.toBeNull()
    expect(jan22).toBeNull()
    expect(child?.parent_id).toBe(jan21Id)
    expect(refs).toContainEqual({id: jan21Id, alias: 'January 21st, 2020'})
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

    // With no prior occupant, the alias block lands at slot 0 of the
    // indexed deterministic seat sequence — same id any future import
    // (or parseReferences after the user types [[Get really good at
    // dancing]]) would land on in the same world-state.
    expect(aliasRef!.id).toBe(computeAliasSeatId('Get really good at dancing', WORKSPACE))

    const aliasBlock = await readBlock(aliasRef!.id)
    expect(aliasBlock?.content).toBe('Get really good at dancing')
    expect(JSON.parse(aliasBlock!.properties_json)[aliasesProp.name])
      .toEqual(['Get really good at dancing'])
  })

  it('reuses an existing seat row instead of duplicating when re-imported', async () => {
    // First import materialises the happy-path slot 0 seat.
    await importRoam(minimalExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })
    const seatId = computeAliasSeatId('Get really good at dancing', WORKSPACE)
    expect(await readBlock(seatId)).not.toBeNull()

    // Second import of the same export. With indexed deterministic seats,
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
    // the happy-path deterministic seat. We forge that state here
    // directly so the test doesn't depend on the parseReferences pipeline.
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

  it('probes past a post-rename alias-seat occupant when creating import alias targets', async () => {
    const alias = 'Get really good at dancing'
    const slot0Id = computeAliasSeatId(alias, WORKSPACE, 0)
    const slot1Id = computeAliasSeatId(alias, WORKSPACE, 1)

    // Simulate slot 0 after a rename: the row still lives at the old
    // alias-derived id, but no longer claims that old alias.
    await env.repo.tx(async tx => {
      await tx.create({
        id: slot0Id,
        workspaceId: WORKSPACE,
        parentId: null,
        orderKey: 'a0',
        content: 'Renamed target',
        properties: {
          [aliasesProp.name]: aliasesProp.codec.encode(['Renamed target']),
        },
      })
    }, {scope: ChangeScope.BlockDefault})

    const summary = await importRoam(minimalExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    expect(summary.aliasBlocksCreated).toBe(1)

    const parent = await readBlock(roamBlockId(WORKSPACE, 'parentA'))
    const refs = JSON.parse(parent!.references_json) as {id: string, alias: string}[]
    const aliasRef = refs.find(r => r.alias === alias)
    expect(aliasRef?.id).toBe(slot1Id)

    const slot0 = await readBlock(slot0Id)
    expect(JSON.parse(slot0!.properties_json)[aliasesProp.name])
      .toEqual(['Renamed target'])

    const slot1 = await readBlock(slot1Id)
    expect(slot1?.content).toBe(alias)
    expect(JSON.parse(slot1!.properties_json)[aliasesProp.name]).toEqual([alias])
  })

  it('preserves whitespace in imported page-title aliases', async () => {
    const spacedExport: RoamExport = [{
      title: ' Foo ',
      uid: 'spacedPage',
      children: [],
    }]

    await importRoam(spacedExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    const pageId = roamBlockId(WORKSPACE, 'spacedPage')
    const page = await readBlock(pageId)
    expect(JSON.parse(page!.properties_json)[aliasesProp.name]).toEqual([' Foo '])

    const aliasRows = await env.h.db.getAll<{block_id: string, alias: string}>(
      'SELECT block_id, alias FROM block_aliases WHERE workspace_id = ?',
      [WORKSPACE],
    )
    expect(aliasRows).toContainEqual({block_id: pageId, alias: ' Foo '})
    expect(aliasRows.some(row => row.alias === 'Foo')).toBe(false)
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

  it('does not create placeholders for unconfirmed double-paren prose', async () => {
    const proseExport: RoamExport = [
      {
        title: 'prose refs',
        uid: 'prosePage',
        children: [
          {
            string: 'A collapsed ((open)) section and expandable ((text)) snippets',
            uid: 'proseBlock',
          },
        ],
      },
    ]

    const summary = await importRoam(proseExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    expect(summary.placeholdersCreated).toBe(0)
    expect(summary.diagnostics.some(line => line.includes('leaked past placeholder registration')))
      .toBe(false)

    const block = await readBlock(roamBlockId(WORKSPACE, 'proseBlock'))
    expect(block?.content).toBe('A collapsed ((open)) section and expandable ((text)) snippets')
    expect(await readBlock(roamBlockId(WORKSPACE, 'open'))).toBeNull()
    expect(await readBlock(roamBlockId(WORKSPACE, 'text'))).toBeNull()
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

  it('writes a grouped post-import log block on today\'s daily-note', async () => {
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

    const sections = await env.h.db.getAll<{id: string, content: string}>(
      'SELECT id, content FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id',
      [header!.id],
    )
    const summarySection = sections.find(c => c.content === 'Summary')
    expect(summarySection).toBeDefined()
    const summaryLines = await env.h.db.getAll<{content: string}>(
      'SELECT content FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id',
      [summarySection!.id],
    )
    expect(summaryLines.map(line => line.content)).toContain('Pages: 1 new, 0 merged, 0 daily')

    const notesSection = sections.find(c => c.content === `Notes (${summary.diagnostics.length})`)
    expect(notesSection).toBeDefined()
    const noteGroups = await env.h.db.getAll<{id: string, content: string}>(
      'SELECT id, content FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id',
      [notesSection!.id],
    )
    const propertyGroup = noteGroups.find(c => c.content.startsWith('Properties and schemas '))
    expect(propertyGroup).toBeDefined()
    const propertyNotes = await env.h.db.getAll<{id: string, content: string}>(
      'SELECT id, content FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id',
      [propertyGroup!.id],
    )
    const deepHoists = propertyNotes.find(line => line.content.startsWith('Deep attribute hoists '))
    expect(deepHoists).toBeDefined()
    const deepHoistChildren = await env.h.db.getAll<{content: string}>(
      'SELECT content FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id',
      [deepHoists!.id],
    )
    expect(deepHoistChildren.map(line => line.content)).toContain('C depth 3: 1')
    expect(deepHoistChildren.map(line => line.content)).toContain('Samples')
  })

  it('reports schema inference near-misses in the import log', async () => {
    const nearMissExport: RoamExport = Array.from({length: 20}, (_, i) => ({
      title: `near miss ${i}`,
      uid: `nearMissPage${i}`,
      children: [{
        string: i >= 17 ? `related::plain text [[Topic ${i}]]` : `related::[[Topic ${i}]]`,
        uid: `nearMissRelated${i}`,
      }],
    }))

    const summary = await importRoam(nearMissExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    expect(summary.diagnostics).toEqual(expect.arrayContaining([
      expect.stringContaining('property "roam:related" inferred string, but 17/20 values (85%) looked like refList'),
    ]))

    const dailyChildren = await readChildren(dailyNoteBlockId(WORKSPACE, todayIso()))
    const header = dailyChildren.find(c => c.content.startsWith('Roam import '))
    expect(header).toBeDefined()
    const sections = await readChildren(header!.id)
    const notesSection = sections.find(c => c.content === `Notes (${summary.diagnostics.length})`)
    expect(notesSection).toBeDefined()
    const noteGroups = await readChildren(notesSection!.id)
    const propertyGroup = noteGroups.find(c => c.content.startsWith('Properties and schemas '))
    expect(propertyGroup).toBeDefined()
    const propertySections = await readChildren(propertyGroup!.id)
    const nearMisses = propertySections.find(c => c.content === 'Schema inference near-misses (1)')
    expect(nearMisses).toBeDefined()
    const nearMissLines = await readChildren(nearMisses!.id)
    expect(nearMissLines).toHaveLength(1)
    expect(nearMissLines[0].content).toContain(
      'property "roam:related" inferred string, but 17/20 values (85%) looked like refList',
    )
    const nearMissChildren = await readChildren(nearMissLines[0].id)
    expect(nearMissChildren.map(line => line.content)).toEqual([
      `((${roamBlockId(WORKSPACE, 'nearMissPage17')}))="plain text [[Topic 17]]"`,
      `((${roamBlockId(WORKSPACE, 'nearMissPage18')}))="plain text [[Topic 18]]"`,
      `((${roamBlockId(WORKSPACE, 'nearMissPage19')}))="plain text [[Topic 19]]"`,
    ])
  })

  it('lists every multiple-marker SRS case in the import report', async () => {
    const srsExport: RoamExport = [{
      title: 'many duplicate srs markers',
      uid: 'manyDuplicateSrsMarkersPage',
      children: Array.from({length: 10}, (_, i) => ({
        string: `parent ${i}`,
        uid: `multiSrsParent${i}`,
        children: [
          {
            string: '[[[[interval]]:5]] [[[[factor]]:2.00]] [[June 6th, 2026]]',
            uid: `multiSrsFirst${i}`,
          },
          {
            string: '[[[[interval]]:7]] [[[[factor]]:2.10]] [[June 8th, 2026]]',
            uid: `multiSrsSecond${i}`,
          },
        ],
      })),
    }]

    const summary = await importRoam(srsExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    expect(summary.diagnostics.filter(line =>
      line.startsWith('Multiple marker-only Roam SRS children'),
    )).toHaveLength(10)

    const dailyChildren = await readChildren(dailyNoteBlockId(WORKSPACE, todayIso()))
    const header = dailyChildren.find(c => c.content.startsWith('Roam import '))
    expect(header).toBeDefined()
    const sections = await readChildren(header!.id)
    const notesSection = sections.find(c => c.content === `Notes (${summary.diagnostics.length})`)
    expect(notesSection).toBeDefined()
    const noteGroups = await readChildren(notesSection!.id)
    const srsGroup = noteGroups.find(c => c.content.startsWith('SRS and roam/memo '))
    expect(srsGroup).toBeDefined()
    const srsSections = await readChildren(srsGroup!.id)
    const multipleMarkers = srsSections.find(c => c.content === 'Multiple marker-only SRS children (10)')
    expect(multipleMarkers).toBeDefined()
    const markerLines = await readChildren(multipleMarkers!.id)
    expect(markerLines).toHaveLength(10)
    expect(markerLines.map(line => line.content)).toContain(
      `Multiple marker-only Roam SRS children under block ((${roamBlockId(WORKSPACE, 'multiSrsParent9')})); promoted latest due date June 8th, 2026 ((${roamBlockId(WORKSPACE, 'multiSrsSecond9')})) and preserved 1 additional marker block(s) literally.`,
    )
    expect(markerLines.some(line => line.content.includes('omitted from this report section')))
      .toBe(false)
  })

  it('lists every missing-date SRS marker in the import report', async () => {
    const srsExport: RoamExport = [{
      title: 'many missing-date srs markers',
      uid: 'manyMissingDateSrsPage',
      children: Array.from({length: 10}, (_, i) => ({
        string: `[[[[interval]]:${i + 1}]] [[[[factor]]:2.00]] ;tomorrow;`,
        uid: `missingDateSrs${i}`,
      })),
    }]

    const summary = await importRoam(srsExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    expect(summary.diagnostics.filter(line =>
      line.includes('has interval/factor but no parseable daily review date'),
    )).toHaveLength(10)

    const dailyChildren = await readChildren(dailyNoteBlockId(WORKSPACE, todayIso()))
    const header = dailyChildren.find(c => c.content.startsWith('Roam import '))
    expect(header).toBeDefined()
    const sections = await readChildren(header!.id)
    const notesSection = sections.find(c => c.content === `Notes (${summary.diagnostics.length})`)
    expect(notesSection).toBeDefined()
    const noteGroups = await readChildren(notesSection!.id)
    const srsGroup = noteGroups.find(c => c.content.startsWith('SRS and roam/memo '))
    expect(srsGroup).toBeDefined()
    const srsSections = await readChildren(srsGroup!.id)
    const missingDates = srsSections.find(c => c.content === 'SRS markers missing review dates (10)')
    expect(missingDates).toBeDefined()
    const missingDateLines = await readChildren(missingDates!.id)
    expect(missingDateLines).toHaveLength(10)
    expect(missingDateLines.map(line => line.content)).toContain(
      `Roam SRS marker on block ((${roamBlockId(WORKSPACE, 'missingDateSrs9')})) has interval/factor but no parseable daily review date; preserved literally without SRS properties.`,
    )
    expect(missingDateLines.some(line => line.content.includes('omitted from this report section')))
      .toBe(false)
  })

  it('links Roam uid diagnostics in the import report to imported blocks', async () => {
    const srsExport: RoamExport = [{
      title: 'bad srs report link',
      uid: 'badSrsReportPage',
      children: [{
        string: '[[[[interval]]:615.9]] [[[[factor]]:1.60]] [[January 29th, 202 6]] *',
        uid: 'badSrsUid',
      }],
    }]

    const summary = await importRoam(srsExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    expect(summary.diagnostics.some(line => line.includes('uid badSrsUid'))).toBe(true)

    const dailyChildren = await readChildren(dailyNoteBlockId(WORKSPACE, todayIso()))
    const header = dailyChildren.find(c => c.content.startsWith('Roam import '))
    expect(header).toBeDefined()
    const sections = await readChildren(header!.id)
    const notesSection = sections.find(c => c.content === `Notes (${summary.diagnostics.length})`)
    expect(notesSection).toBeDefined()
    const noteGroups = await readChildren(notesSection!.id)
    const srsGroup = noteGroups.find(c => c.content.startsWith('SRS and roam/memo '))
    expect(srsGroup).toBeDefined()
    const srsSections = await readChildren(srsGroup!.id)
    const missingDates = srsSections.find(c => c.content === 'SRS markers missing review dates (1)')
    expect(missingDates).toBeDefined()
    const missingDateLines = await readChildren(missingDates!.id)
    expect(missingDateLines.map(line => line.content)).toEqual([
      `Roam SRS marker on block ((${roamBlockId(WORKSPACE, 'badSrsUid')})) has interval/factor but no parseable daily review date; preserved literally without SRS properties.`,
    ])
    expect(missingDateLines[0].content).not.toContain('badSrsUid')
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
      {
        title: 'Mixed SRS marker',
        uid: 'mixedSrsPage',
        children: [
          {string: 'isa::[[[[interval]]:241.0]] [[[[factor]]:1.30]]', uid: 'mixedSrsIsa'},
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

    const confidenceSections = await env.h.db.getAll<{id: string, content: string}>(
      'SELECT id, content FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id',
      [section!.id],
    )
    const highConfidence = confidenceSections.find(c => c.content === 'High-confidence (1)')
    expect(highConfidence).toBeDefined()
    const highConfidenceLines = await env.h.db.getAll<{content: string}>(
      'SELECT content FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id',
      [highConfidence!.id],
    )
    expect(highConfidenceLines.map(line => line.content)).toEqual([
      '[[import-test-person]] -> type "import-test-person" (2 nodes); common props: roam:twitter 2/2 (100%)',
    ])

    const lowerConfidence = confidenceSections.find(c => c.content === 'Lower-confidence / needs review (1)')
    expect(lowerConfidence).toBeDefined()
    const lowerConfidenceLines = await env.h.db.getAll<{content: string}>(
      'SELECT content FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id',
      [lowerConfidence!.id],
    )
    expect(lowerConfidenceLines.map(line => line.content)).toEqual([
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

  it('merges pages that claim the same page_alias into one canonical page', async () => {
    const aliasExport: RoamExport = [
      {
        title: 'canonical page',
        uid: 'canonicalAliasPage',
        children: [
          {string: 'page_alias::[[shared alias]]', uid: 'canonicalAliasBlock'},
          {string: 'canonical child', uid: 'canonicalChild'},
        ],
      },
      {
        title: 'duplicate page',
        uid: 'duplicateAliasPage',
        children: [
          {string: 'page_alias::[[shared alias]]', uid: 'duplicateAliasBlock'},
          {string: 'duplicate child', uid: 'duplicateChild'},
        ],
      },
    ]

    const summary = await importRoam(aliasExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    expect(summary.pagesCreated).toBe(1)
    expect(summary.pagesMerged).toBe(1)
    expect(summary.diagnostics).toContain(
      "[[canonical page]] also had 'duplicate page' merged in bc of the alias rule",
    )

    const canonicalId = roamBlockId(WORKSPACE, 'canonicalAliasPage')
    const canonical = await readBlock(canonicalId)
    expect(canonical).not.toBeNull()
    expect(JSON.parse(canonical!.properties_json)[aliasesProp.name])
      .toEqual(['canonical page', 'duplicate page', 'shared alias'])
    expect(await readBlock(roamBlockId(WORKSPACE, 'duplicateAliasPage'))).toBeNull()

    const duplicateChild = await readBlock(roamBlockId(WORKSPACE, 'duplicateChild'))
    expect(duplicateChild?.parent_id).toBe(canonicalId)

    const duplicateAliasBlock = await readBlock(roamBlockId(WORKSPACE, 'duplicateAliasBlock'))
    expect(duplicateAliasBlock?.parent_id).toBe(canonicalId)
  })

  it('lists all non-standard page aliases and alias merges in the import report', async () => {
    const nonStandardPages: RoamExport = Array.from({length: 10}, (_, i) => ({
      title: `non-standard aliases ${i}`,
      uid: `nonStdPage${i}`,
      children: [
        {string: `page_alias::plain alias ${i}`, uid: `nonStdAlias${i}`},
      ],
    }))
    const mergePages: RoamExport = Array.from({length: 10}, (_, i) => [
      {
        title: `merge target ${i}`,
        uid: `mergeTarget${i}`,
        children: [
          {string: `page_alias::[[merge source ${i}]]`, uid: `mergeAlias${i}`},
        ],
      },
      {
        title: `merge source ${i}`,
        uid: `mergeSource${i}`,
        children: [
          {string: `source child ${i}`, uid: `mergeSourceChild${i}`},
        ],
      },
    ]).flat()

    const summary = await importRoam([...nonStandardPages, ...mergePages], env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    expect(summary.diagnostics.filter(line => line.startsWith('Non-standard page_alias')))
      .toHaveLength(10)
    expect(summary.diagnostics.filter(line => line.includes('merged in bc of the alias rule')))
      .toHaveLength(10)

    const dailyChildren = await readChildren(dailyNoteBlockId(WORKSPACE, todayIso()))
    const header = dailyChildren.find(c => c.content.startsWith('Roam import '))
    expect(header).toBeDefined()

    const sections = await readChildren(header!.id)
    const notesSection = sections.find(c => c.content === `Notes (${summary.diagnostics.length})`)
    expect(notesSection).toBeDefined()

    const noteGroups = await readChildren(notesSection!.id)
    const pageAliasGroup = noteGroups.find(c => c.content.startsWith('Page aliases '))
    expect(pageAliasGroup).toBeDefined()

    const pageAliasSections = await readChildren(pageAliasGroup!.id)
    const nonStandardSection = pageAliasSections.find(c =>
      c.content === 'Non-standard page_alias values (10)')
    expect(nonStandardSection).toBeDefined()
    const nonStandardLines = await readChildren(nonStandardSection!.id)
    expect(nonStandardLines).toHaveLength(10)
    expect(nonStandardLines.map(line => line.content)).toContain(
      `Non-standard page_alias on [[non-standard aliases 9]] ((${roamBlockId(WORKSPACE, 'nonStdPage9')})) was not used for alias-rule merging: "plain alias 9"`,
    )
    expect(nonStandardLines.some(line => line.content.includes('omitted from this report section')))
      .toBe(false)

    const mergeSection = pageAliasSections.find(c => c.content === 'Alias-rule page merges (10)')
    expect(mergeSection).toBeDefined()
    const mergeLines = await readChildren(mergeSection!.id)
    expect(mergeLines).toHaveLength(10)
    expect(mergeLines.map(line => line.content)).toContain(
      "[[merge target 9]] also had 'merge source 9' merged in bc of the alias rule",
    )
    expect(mergeLines.some(line => line.content.includes('omitted from this report section')))
      .toBe(false)
  })

  it('materializes conservative non-standard page_alias values without merging pages', async () => {
    const aliasExport: RoamExport = [
      {
        title: 'Lily @evoenn',
        uid: 'lilyPage',
        children: [
          {string: 'page_alias::"Lily Anna", "Katerina Kolyada"', uid: 'lilyAliases'},
        ],
      },
      {
        title: 'Katerina Kolyada',
        uid: 'katerinaPage',
        children: [
          {string: 'still its own page', uid: 'katerinaChild'},
        ],
      },
    ]

    const summary = await importRoam(aliasExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    expect(summary.pagesCreated).toBe(2)
    expect(summary.pagesMerged).toBe(0)
    expect(summary.aliasBlocksCreated).toBe(1)

    const lily = await readBlock(roamBlockId(WORKSPACE, 'lilyPage'))
    expect(lily).not.toBeNull()
    const lilyProperties = JSON.parse(lily!.properties_json) as Record<string, unknown>
    expect(lilyProperties[ROAM_PAGE_ALIAS_PROP]).toEqual([
      computeAliasSeatId('Lily Anna', WORKSPACE),
      roamBlockId(WORKSPACE, 'katerinaPage'),
    ])
    expect(lilyProperties[aliasesProp.name]).toEqual(['Lily @evoenn'])

    const katerina = await readBlock(roamBlockId(WORKSPACE, 'katerinaPage'))
    expect(katerina).not.toBeNull()
    expect(katerina?.parent_id).toBeNull()
  })

  it('stores mixed scalar and multi-value Roam attributes as arrays', async () => {
    const contactsExport: RoamExport = [
      {
        title: 'single contact fields',
        uid: 'singleContact',
        children: [
          {string: 'email::gliderok@gmail.com', uid: 'singleEmail'},
          {string: 'Twitter::https://twitter.com/anthosewolves', uid: 'singleTwitter'},
        ],
      },
      {
        title: 'multi contact fields',
        uid: 'multiContact',
        children: [
          {
            string: 'email::',
            uid: 'multiEmail',
            children: [
              {string: 'gliderok@gmail.com', uid: 'multiEmailA'},
              {string: 'aix123@yandex.ru', uid: 'multiEmailB'},
            ],
          },
          {
            string: 'Twitter::',
            uid: 'multiTwitter',
            children: [
              {string: 'https://twitter.com/anthosewolves', uid: 'multiTwitterA'},
              {string: 'https://twitter.com/spolakh', uid: 'multiTwitterB'},
            ],
          },
        ],
      },
    ]

    await importRoam(contactsExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    const single = await readBlock(roamBlockId(WORKSPACE, 'singleContact'))
    const singleProps = JSON.parse(single!.properties_json) as Record<string, unknown>
    expect(singleProps['roam:email']).toEqual(['gliderok@gmail.com'])
    expect(singleProps['roam:Twitter']).toEqual(['https://twitter.com/anthosewolves'])

    const multi = await readBlock(roamBlockId(WORKSPACE, 'multiContact'))
    const multiProps = JSON.parse(multi!.properties_json) as Record<string, unknown>
    expect(multiProps['roam:email']).toEqual(['gliderok@gmail.com', 'aix123@yandex.ru'])
    expect(multiProps['roam:Twitter']).toEqual([
      'https://twitter.com/anthosewolves',
      'https://twitter.com/spolakh',
    ])
  })

  it('does not merge daily pages through page_alias properties', async () => {
    const aliasExport: RoamExport = [
      {
        title: 'Sunday',
        uid: 'sundayPage',
        children: [
          {string: 'page_alias::[[March 8th, 2020]]', uid: 'sundayAlias'},
        ],
      },
      {
        title: 'March 8th, 2020',
        uid: '03-08-2020',
        children: [
          {string: 'daily child', uid: 'dailyChildForAlias'},
        ],
      },
    ]

    const summary = await importRoam(aliasExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    expect(summary.pagesCreated).toBe(1)
    expect(summary.pagesDaily).toBe(1)
    expect(summary.pagesMerged).toBe(0)
    expect(summary.diagnostics.some(d =>
      d.includes('Skipped 1 daily-shaped page_alias merge') &&
      d.includes('[[Sunday]] -> [[March 8th, 2020]]'),
    )).toBe(true)

    const sunday = await readBlock(roamBlockId(WORKSPACE, 'sundayPage'))
    expect(JSON.parse(sunday!.properties_json)[aliasesProp.name]).toEqual(['Sunday'])
    expect(await readBlock(dailyNoteBlockId(WORKSPACE, '2020-03-08'))).not.toBeNull()
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

  it('imports embedded Roam SRS SM-2.5 markers as typed block metadata', async () => {
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
                string: 'check in [[[[interval]]:31.1]] [[[[factor]]:2.50]] [[June 6th, 2026]]',
                uid: 'srsTask',
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

    expect(summary.diagnostics.some(d => d.includes('SRS marker conflict'))).toBe(false)

    const parent = await readBlock(roamBlockId(WORKSPACE, 'srsParent'))
    const parentProps = JSON.parse(parent!.properties_json) as Record<string, unknown>
    expect(parentProps[srsIntervalProp.name]).toBeUndefined()

    const task = await readBlock(roamBlockId(WORKSPACE, 'srsTask'))
    const taskProps = JSON.parse(task!.properties_json) as Record<string, unknown>
    expect(taskProps[typesProp.name]).toContain(SRS_SM25_TYPE)
    expect(taskProps[srsIntervalProp.name]).toBe(31.1)
    expect(taskProps[srsFactorProp.name]).toBe(2.5)
    expect(taskProps[srsReviewCountProp.name]).toBe(0)
    expect(taskProps[srsNextReviewDateProp.name])
      .toBe(dailyNoteBlockId(WORKSPACE, '2026-06-06'))
  })

  it('imports roam/memo review snapshots and reports existing SRS conflicts', async () => {
    const targetId = roamBlockId(WORKSPACE, 'targetUid')
    await env.repo.tx(async tx => {
      await tx.create({
        id: targetId,
        workspaceId: WORKSPACE,
        parentId: null,
        orderKey: 'a0',
        content: 'old card',
        properties: {
          [typesProp.name]: typesProp.codec.encode([SRS_SM25_TYPE]),
          [srsIntervalProp.name]: 99,
        },
      })
    }, {scope: ChangeScope.BlockDefault, description: 'seed conflict'})

    const memoExport: RoamExport = [
      {
        title: 'cards',
        uid: 'cardsPage',
        children: [{string: 'Question #memo', uid: 'targetUid'}],
      },
      {
        title: 'roam/memo',
        uid: 'memoPage',
        children: [{
          string: 'data',
          uid: 'memoData',
          children: [{
            string: '((targetUid))',
            uid: 'memoEntry',
            children: [
              {
                string: '[[May 5th, 2026]] 🔵',
                uid: 'newerSession',
                children: [
                  {string: 'reviewMode:: SPACED_INTERVAL', uid: 'newerMode'},
                  {string: 'nextDueDate:: [[May 10th, 2026]]', uid: 'newerDue'},
                  {string: 'repetitions:: 2', uid: 'newerReps'},
                  {string: 'interval:: 5', uid: 'newerInterval'},
                  {string: 'eFactor:: 2.2', uid: 'newerFactor'},
                  {string: 'grade:: 4', uid: 'newerGrade'},
                ],
              },
              {
                string: '[[May 1st, 2026]] 🟢',
                uid: 'olderSession',
                children: [
                  {string: 'reviewMode:: SPACED_INTERVAL', uid: 'olderMode'},
                  {string: 'nextDueDate:: [[May 5th, 2026]]', uid: 'olderDue'},
                  {string: 'repetitions:: 1', uid: 'olderReps'},
                  {string: 'interval:: 4', uid: 'olderInterval'},
                  {string: 'eFactor:: 2.3', uid: 'olderFactor'},
                  {string: 'grade:: 5', uid: 'olderGrade'},
                ],
              },
              {string: '[[memo/archived]]', uid: 'archivedTag'},
            ],
          }],
        }],
      },
    ]

    const summary = await importRoam(memoExport, env.repo, {
      workspaceId: WORKSPACE,
      currentUserId: USER_ID,
    })

    expect(summary.roamMemo).toMatchObject({
      entries: 1,
      matchedTargets: 1,
      archivedTargets: 1,
      snapshots: 2,
      targetsWithHistory: 1,
    })
    expect(summary.diagnostics.some(d =>
      d.includes('roam/memo SRS conflict') &&
      d.includes('interval existing=99 memo=5'),
    )).toBe(true)

    const target = await readBlock(targetId)
    const props = JSON.parse(target!.properties_json) as Record<string, unknown>
    const may1 = dailyNoteBlockId(WORKSPACE, '2026-05-01')
    const may5 = dailyNoteBlockId(WORKSPACE, '2026-05-05')
    const may10 = dailyNoteBlockId(WORKSPACE, '2026-05-10')

    expect(props[typesProp.name]).toContain(SRS_SM25_TYPE)
    expect(props[srsIntervalProp.name]).toBe(5)
    expect(props[srsFactorProp.name]).toBe(2.2)
    expect(props[srsNextReviewDateProp.name]).toBe(may10)
    expect(props[srsReviewCountProp.name]).toBe(2)
    expect(props[srsGradeProp.name]).toBe(4)
    expect(props[srsArchivedProp.name]).toBe(true)
    expect(props[srsSnapshotHistoryProp.name]).toEqual([
      {reviewedAt: may1, grade: 5, interval: 4, factor: 2.3, reviewCount: 1},
      {reviewedAt: may5, grade: 4, interval: 5, factor: 2.2, reviewCount: 2},
    ])
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
