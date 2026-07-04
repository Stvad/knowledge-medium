// @vitest-environment jsdom
//
// Exercises the bridge's data commands (`backlinks`, `grouped-backlinks`,
// `data-model`, `page`, `daily-note`, `search`) end-to-end against a real
// Repo. The runtime is intentionally minimal — kernel + the
// backlinks/grouped-backlinks data extensions (which carry the queries AND
// the user-prefs infra the resolvers read). It deliberately omits the
// references *parse* processor: that processor re-derives references from
// content/properties post-commit, so manual `references` arrays would be
// asynchronously reconciled away. Trigger-maintained derived indexes
// (`block_references`, `block_aliases`, `blocks_fts`) are part of the test
// DB schema, so manual references / aliases / content project
// deterministically on insert without that processor.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, type BlockReference } from '@/data/api'
import type { BlockProperties } from '@/types.js'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { type Repo } from '@/data/repo'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { backlinksDataExtension } from '@/plugins/backlinks/dataExtension'
import { groupedBacklinksDataExtension } from '@/plugins/grouped-backlinks/dataExtension'
import { dailyNoteBlockId } from '@/plugins/daily-notes/dailyNotes'
import { keyAtEnd } from '@/data/orderKey'
import { createAgentRuntimeContext, executeCommand } from '../commands'
import type { AgentRuntimeContext } from '../protocol'

const WS = 'ws-1'
const USER = {id: 'user-1', name: 'Alice'}
const TOPIC_A = '11111111-1111-4111-8111-111111111111'

interface BacklinkRef {
  id: string
  content: string
  types: string[]
  deepLink: string
  sourceFields: string[]
}
interface BacklinksResult {
  target: {id: string}
  total: number
  filter: unknown
  backlinks: BacklinkRef[]
}
interface GroupedResult {
  total: number
  grouping: Record<string, string[]>
  groups: Array<{
    label: string
    fallback: boolean
    deepLink: string | null
    members: Array<{id: string}>
  }>
}

let sharedDb: TestDb
let repo: Repo
let context: AgentRuntimeContext

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: USER}).repo
  repo.setActiveWorkspaceId(WS)
  const runtime = resolveFacetRuntimeSync(
    [kernelDataExtension, backlinksDataExtension, groupedBacklinksDataExtension],
    {repo, workspaceId: WS, safeMode: false},
  )
  repo.setFacetRuntime(runtime)
  context = createAgentRuntimeContext({repo, runtime, safeMode: false})
})

const create = async (args: {
  id: string
  content?: string
  parentId?: string | null
  orderKey?: string
  references?: BlockReference[]
  properties?: BlockProperties
}) => {
  await repo.tx(async tx => {
    await tx.create({
      id: args.id,
      workspaceId: WS,
      parentId: args.parentId ?? null,
      orderKey: args.orderKey ?? `key-${args.id}`,
      content: args.content ?? args.id,
      references: args.references ?? [],
      ...(args.properties ? {properties: args.properties} : {}),
    })
  }, {scope: ChangeScope.BlockDefault})
}

const childIds = async (parentId: string | null): Promise<string[]> => {
  const rows = parentId === null
    ? await sharedDb.db.getAll<{id: string}>('SELECT id FROM blocks WHERE parent_id IS NULL AND deleted = 0 ORDER BY order_key, id')
    : await sharedDb.db.getAll<{id: string}>('SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id', [parentId])
  return rows.map(row => row.id)
}

const deletedById = async (ids: string[]): Promise<Record<string, number>> => {
  const placeholders = ids.map(() => '?').join(', ')
  const rows = await sharedDb.db.getAll<{id: string, deleted: number}>(
    `SELECT id, deleted FROM blocks WHERE id IN (${placeholders})`,
    ids,
  )
  return Object.fromEntries(rows.map(row => [row.id, row.deleted]))
}

describe('backlinks command', () => {
  it('hydrates sources and distinguishes wikilinks from property refs', async () => {
    await create({id: 'target', content: 'Target'})
    await create({id: 'src-a', content: 'Source A', references: [{id: 'target', alias: 'T'}]})
    await create({
      id: 'src-b',
      content: 'Source B',
      references: [{id: 'target', alias: 'target', sourceField: 'reviewer'}],
    })

    const out = await executeCommand(
      {commandId: 'bl-1', type: 'backlinks', id: 'target'},
      context,
    ) as BacklinksResult

    expect(out.target.id).toBe('target')
    expect(out.total).toBe(2)
    expect(out.filter).toBeNull()

    const byId = new Map(out.backlinks.map(ref => [ref.id, ref]))
    expect(byId.get('src-a')?.content).toBe('Source A')
    expect(byId.get('src-a')?.deepLink).toBe(`#${WS}/src-a`)
    expect(byId.get('src-a')?.sourceFields).toEqual([''])          // body wikilink
    expect(byId.get('src-b')?.sourceFields).toEqual(['reviewer'])  // projected property ref
  })

  it('an explicit object filter narrows the set', async () => {
    await create({id: 'target', content: 'Target'})
    await create({id: 'topic', content: 'Topic'})
    await create({
      id: 'src-a',
      references: [{id: 'target', alias: 'T'}, {id: 'topic', alias: 'Topic'}],
    })
    await create({id: 'src-b', references: [{id: 'target', alias: 'T'}]})

    const out = await executeCommand(
      {
        commandId: 'bl-filter',
        type: 'backlinks',
        id: 'target',
        filter: {include: [{referencedBy: {id: 'topic'}}]},
      },
      context,
    ) as BacklinksResult

    expect(out.backlinks.map(ref => ref.id)).toEqual(['src-a'])
    expect(out.total).toBe(1)
  })

  it("rejects a malformed filter spec", async () => {
    await create({id: 'target', content: 'Target'})
    await expect(executeCommand(
      {commandId: 'bl-bad', type: 'backlinks', id: 'target', filter: 'sideways'},
      context,
    )).rejects.toThrow(/filter must be/)
  })
})

describe('grouped-backlinks command', () => {
  it('groups by a shared ref and links the group page', async () => {
    await create({id: 'target', content: 'Target'})
    await create({id: TOPIC_A, content: 'Topic A'})
    await create({id: 'src-a1', references: [{id: 'target', alias: 'T'}, {id: TOPIC_A, alias: 'A'}]})
    await create({id: 'src-a2', references: [{id: 'target', alias: 'T'}, {id: TOPIC_A, alias: 'A'}]})
    await create({id: 'src-b', references: [{id: 'target', alias: 'T'}]})

    const out = await executeCommand(
      {commandId: 'gb-1', type: 'grouped-backlinks', id: 'target'},
      context,
    ) as GroupedResult

    expect(out.total).toBe(3)
    expect(out.groups.map(group => group.label)).toEqual(['Topic A', 'Other'])
    expect(out.groups[0].members.map(member => member.id).sort()).toEqual(['src-a1', 'src-a2'])
    expect(out.groups[0].deepLink).toBe(`#${WS}/${TOPIC_A}`)  // group is a real page → linkable
    expect(out.groups[1].fallback).toBe(true)
    expect(out.groups[1].deepLink).toBeNull()                 // the Other bucket isn't a block
  })

  it('grouping spec selects the config (user default vs none)', async () => {
    await create({id: 'target', content: 'Target'})
    await create({id: 'src', references: [{id: 'target', alias: 'T'}]})

    const def = await executeCommand(
      {commandId: 'gb-def', type: 'grouped-backlinks', id: 'target'},
      context,
    ) as GroupedResult
    // Default 'user' resolves the INITIAL user config (non-empty).
    expect(def.grouping.lowPriorityTags).toContain('person')

    const none = await executeCommand(
      {commandId: 'gb-none', type: 'grouped-backlinks', id: 'target', grouping: 'none'},
      context,
    ) as GroupedResult
    expect(none.grouping).toEqual({
      highPriorityTags: [],
      lowPriorityTags: [],
      excludedTags: [],
      excludedPatterns: [],
    })
  })
})

describe('data-model command', () => {
  it('returns the guide markdown', async () => {
    const guide = await executeCommand({commandId: 'dm-1', type: 'data-model'}, context)
    expect(typeof guide).toBe('string')
    expect(guide).toContain('block_references')
    expect(guide).toContain('grouped-backlinks')
    expect(guide).toContain('source_field')
  })
})

describe('page command', () => {
  it('resolves an exact alias and returns substring candidates', async () => {
    await create({
      id: 'pg',
      content: 'Project Alpha',
      properties: {alias: ['Project Alpha']},
    })

    const exact = await executeCommand(
      {commandId: 'pg-1', type: 'page', name: 'Project Alpha'},
      context,
    ) as {match: {id: string, deepLink: string} | null, candidates: Array<{id: string}>}
    expect(exact.match?.id).toBe('pg')
    expect(exact.match?.deepLink).toBe(`#${WS}/pg`)
    expect(exact.candidates.map(c => c.id)).toContain('pg')

    // A substring that is not an exact alias → no match, still a candidate.
    const partial = await executeCommand(
      {commandId: 'pg-2', type: 'page', name: 'Project'},
      context,
    ) as {match: {id: string} | null, candidates: Array<{id: string, alias: string}>}
    expect(partial.match).toBeNull()
    expect(partial.candidates.map(c => c.alias)).toContain('Project Alpha')
  })
})

describe('daily-note command', () => {
  it('resolves an ISO date to the deterministic block and reports existence', async () => {
    const iso = '2026-06-18'
    const expectedId = dailyNoteBlockId(WS, iso)

    // Before creation: id is known, exists is false.
    const before = await executeCommand(
      {commandId: 'dn-1', type: 'daily-note', date: iso},
      context,
    ) as {iso: string, blockId: string, exists: boolean, deepLink: string, title: string}
    expect(before.iso).toBe(iso)
    expect(before.blockId).toBe(expectedId)
    expect(before.exists).toBe(false)
    expect(before.deepLink).toBe(`#${WS}/${expectedId}`)
    expect(before.title).toBe('June 18th, 2026')

    // After creating that exact block, exists flips and it hydrates.
    await create({id: expectedId, content: 'June 18th, 2026'})
    const after = await executeCommand(
      {commandId: 'dn-2', type: 'daily-note', date: iso},
      context,
    ) as {exists: boolean, block: {id: string} | null}
    expect(after.exists).toBe(true)
    expect(after.block?.id).toBe(expectedId)
  })

  it('rejects an unparseable date', async () => {
    await expect(executeCommand(
      {commandId: 'dn-bad', type: 'daily-note', date: 'not a date at all'},
      context,
    )).rejects.toThrow(/Could not parse/)
  })
})

describe('search command', () => {
  it('full-text searches block content, hydrated', async () => {
    await create({id: 's1', content: 'banana bread recipe'})
    await create({id: 's2', content: 'completely unrelated note'})

    const out = await executeCommand(
      {commandId: 'se-1', type: 'search', query: 'banana'},
      context,
    ) as {total: number, results: Array<{id: string, deepLink: string}>}

    expect(out.results.map(r => r.id)).toContain('s1')
    expect(out.results.map(r => r.id)).not.toContain('s2')
    expect(out.results.find(r => r.id === 's1')?.deepLink).toBe(`#${WS}/s1`)
  })
})

describe('update-block command', () => {
  it('merges properties — a partial update preserves the other keys', async () => {
    await create({id: 'u1', content: 'x', properties: {a: '1', b: '2'}})
    await executeCommand(
      {commandId: 'up-1', type: 'update-block', id: 'u1', properties: {b: '3'}},
      context,
    )
    expect((await repo.load('u1'))?.properties).toEqual({a: '1', b: '3'})
  })

  it('throws a not-found error for a missing block', async () => {
    await expect(executeCommand(
      {commandId: 'up-nf', type: 'update-block', id: 'nope', properties: {a: '1'}},
      context,
    )).rejects.toThrow(/block nope not found/)
  })

  it('applies concurrent property updates atomically — neither clobbers the other', async () => {
    // Two writers touch DIFFERENT keys of the same block at once. The
    // read-merge-write runs inside one serialized writeTransaction, so
    // neither stale full-map write drops the other's key. A repo.load
    // OUTSIDE the tx (the prior code) let whichever committed second write
    // back its stale snapshot and lose the first's change.
    await create({id: 'u2', content: 'x', properties: {status: 'running', cancel: 'yes'}})
    await Promise.all([
      executeCommand({commandId: 'c-a', type: 'update-block', id: 'u2', properties: {status: 'done'}}, context),
      executeCommand({commandId: 'c-b', type: 'update-block', id: 'u2', properties: {cancel: ''}}, context),
    ])
    expect((await repo.load('u2'))?.properties).toEqual({status: 'done', cancel: ''})
  })
})

describe('move-block command', () => {
  it('moves a block under a target parent at the requested position', async () => {
    const firstOrderKey = keyAtEnd()
    const lastOrderKey = keyAtEnd(firstOrderKey)
    await create({id: 'parent'})
    await create({id: 'first', parentId: 'parent', orderKey: firstOrderKey})
    await create({id: 'last', parentId: 'parent', orderKey: lastOrderKey})
    await create({id: 'moved'})

    const out = await executeCommand(
      {
        commandId: 'mv-1',
        type: 'move-block',
        id: 'moved',
        parentId: 'parent',
        position: {kind: 'before', siblingId: 'last'},
      },
      context,
    ) as {id: string; parentId: string | null}

    expect(out).toMatchObject({id: 'moved', parentId: 'parent'})
    expect(await childIds('parent')).toEqual(['first', 'moved', 'last'])
    expect(await childIds(null)).toEqual(['parent'])
  })
})

describe('delete-block / restore-block commands', () => {
  it('soft-deletes a block subtree, then restores only the requested block', async () => {
    await create({id: 'root', content: 'root'})
    await create({id: 'child', content: 'child', parentId: 'root'})

    const deleted = await executeCommand(
      {commandId: 'del-1', type: 'delete-block', id: 'root'},
      context,
    ) as {id: string, deleted: boolean}

    expect(deleted).toEqual({id: 'root', deleted: true})
    expect(await repo.load('root')).toBeNull()
    expect(await repo.load('child')).toBeNull()
    expect(await deletedById(['root', 'child'])).toEqual({root: 1, child: 1})

    const restored = await executeCommand(
      {commandId: 'restore-1', type: 'restore-block', id: 'root'},
      context,
    ) as {id: string}

    expect(restored.id).toBe('root')
    expect(await repo.load('root')).toMatchObject({id: 'root', deleted: false})
    expect(await repo.load('child')).toBeNull()
    expect(await deletedById(['root', 'child'])).toEqual({root: 0, child: 1})
  })
})

describe('create-blocks-from-markdown command', () => {
  type CreateResult = {ids: string[], rootIds: string[]}

  it('builds a block hierarchy under the parent, tagged with the given properties', async () => {
    await create({id: TOPIC_A, content: 'mention'})

    const result = await executeCommand({
      commandId: 'cbfm-1',
      type: 'create-blocks-from-markdown',
      parentId: TOPIC_A,
      markdown: '- Top A\n  - Child A1\n- Top B',
      properties: {'claude:reply': true},
    }, context) as CreateResult

    const subtree = await context.getSubtree(TOPIC_A)
    const byContent = (text: string) => subtree.find(row => row.content === text)!
    const topA = byContent('Top A')
    const topB = byContent('Top B')
    const childA1 = byContent('Child A1')

    // Roots are children of the mention; the nested bullet is a grandchild.
    expect(result.rootIds).toEqual([topA.id, topB.id])
    expect(topA.parentId).toBe(TOPIC_A)
    expect(topB.parentId).toBe(TOPIC_A)
    expect(childA1.parentId).toBe(topA.id)
    // Every created block carries the passed marker.
    for (const row of [topA, topB, childA1]) {
      expect(row.properties?.['claude:reply']).toBe(true)
    }
  })

  it('appends after existing children rather than before them', async () => {
    await create({id: TOPIC_A, content: 'mention'})
    const existing = await context.createBlock({parentId: TOPIC_A, content: 'user sub-item'})

    await executeCommand({
      commandId: 'cbfm-2',
      type: 'create-blocks-from-markdown',
      parentId: TOPIC_A,
      markdown: '- reply one\n- reply two',
      properties: {'claude:reply': true},
    }, context)

    const children = (await context.getSubtree(TOPIC_A))
      .filter(row => row.parentId === TOPIC_A)
      .sort((a, b) => (a.orderKey! < b.orderKey! ? -1 : 1))
    expect(children.map(row => row.content)).toEqual(['user sub-item', 'reply one', 'reply two'])
    expect(children[0].id).toBe(existing!.id)
  })

  it('reuses rootBlockId (a streamed placeholder) as the first root', async () => {
    await create({id: TOPIC_A, content: 'mention'})
    const placeholder = await context.createBlock({parentId: TOPIC_A, content: '💭 working…'})

    const result = await executeCommand({
      commandId: 'cbfm-3',
      type: 'create-blocks-from-markdown',
      parentId: TOPIC_A,
      rootBlockId: placeholder!.id,
      markdown: '- First\n- Second',
      properties: {'claude:reply': true},
    }, context) as CreateResult

    // The placeholder becomes the first root (content overwritten), not an
    // orphaned extra block; Second is a fresh sibling.
    expect(result.rootIds[0]).toBe(placeholder!.id)
    const subtree = await context.getSubtree(TOPIC_A)
    expect(subtree.find(row => row.id === placeholder!.id)?.content).toBe('First')
    expect(subtree.some(row => row.content === '💭 working…')).toBe(false)
    expect(subtree.find(row => row.content === 'Second')?.parentId).toBe(TOPIC_A)
  })

  it('keeps a fenced code block whole instead of splitting it', async () => {
    await create({id: TOPIC_A, content: 'mention'})

    await executeCommand({
      commandId: 'cbfm-4',
      type: 'create-blocks-from-markdown',
      parentId: TOPIC_A,
      markdown: 'Here:\n```js\nconst x = 1\n```',
      properties: {'claude:reply': true},
    }, context)

    const subtree = await context.getSubtree(TOPIC_A)
    expect(subtree.some(row => row.content === '```js\nconst x = 1\n```')).toBe(true)
  })
})
