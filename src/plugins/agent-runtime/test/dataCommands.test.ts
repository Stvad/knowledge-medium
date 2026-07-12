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

describe('reconcile-markdown-subtree command', () => {
  type ReconcileResult = {ids: string[], rootIds: string[]}
  const KEY = 'reply:test:1'

  const reconcile = (
    markdown: string,
    opts: {key?: string, shape?: 'outline' | 'block', final?: boolean, commandId?: string} = {},
  ) => executeCommand({
    commandId: opts.commandId ?? `rms-${markdown.length}-${opts.final ? 'f' : 'p'}`,
    type: 'reconcile-markdown-subtree',
    parentId: TOPIC_A,
    markdown,
    key: opts.key ?? KEY,
    ...(opts.shape ? {shape: opts.shape} : {}),
    ...(opts.final ? {final: true} : {}),
    properties: {'claude:reply': true},
  }, context) as Promise<ReconcileResult>

  const replyRoots = async () =>
    (await context.getSubtree(TOPIC_A))
      .filter(row => row.parentId === TOPIC_A && row.properties?.['agent:subtreeKey'] === KEY)
      .sort((a, b) => (a.orderKey! < b.orderKey! ? -1 : 1))

  it('builds a block hierarchy under the parent, tagged with the marker AND the key', async () => {
    await create({id: TOPIC_A, content: 'mention'})

    const result = await reconcile('- Top A\n  - Child A1\n- Top B', {final: true})

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
    // Every block carries the passed marker AND the reconcile key.
    for (const row of [topA, topB, childA1]) {
      expect(row.properties?.['claude:reply']).toBe(true)
      expect(row.properties?.['agent:subtreeKey']).toBe(KEY)
    }
  })

  it('is idempotent by key: re-sending the same markdown adds no blocks', async () => {
    await create({id: TOPIC_A, content: 'mention'})

    const first = await reconcile('- One\n- Two', {commandId: 'rms-a'})
    const again = await reconcile('- One\n- Two', {commandId: 'rms-b'})

    // Same block ids, same tree — a re-send converges rather than duplicating.
    expect(again.rootIds).toEqual(first.rootIds)
    expect((await replyRoots()).map(r => r.content)).toEqual(['One', 'Two'])
  })

  it('streaming: a growing markdown extends the tail in place, keeping prior block ids', async () => {
    await create({id: TOPIC_A, content: 'mention'})

    const t1 = await reconcile('- A', {commandId: 'rms-1'})
    const t2 = await reconcile('- A\n- B', {commandId: 'rms-2'})
    const t3 = await reconcile('- A\n- B\n- C', {commandId: 'rms-3', final: true})

    // A keeps its id across every tick; each tick only appends the new tail.
    expect(t2.rootIds[0]).toBe(t1.rootIds[0])
    expect(t3.rootIds.slice(0, 2)).toEqual(t2.rootIds)
    expect((await replyRoots()).map(r => r.content)).toEqual(['A', 'B', 'C'])
  })

  it('updates the tail block content in place as it grows (no duplicate block)', async () => {
    await create({id: TOPIC_A, content: 'mention'})

    // A single root whose text grows (streaming a paragraph, shape=block).
    const t1 = await reconcile('Loading', {commandId: 'rms-g1', shape: 'block'})
    const t2 = await reconcile('Loading more', {commandId: 'rms-g2', shape: 'block', final: true})

    expect(t2.rootIds).toEqual(t1.rootIds)
    const roots = await replyRoots()
    expect(roots).toHaveLength(1)
    expect(roots[0].content).toBe('Loading more')
  })

  it('final reconcile prunes trailing blocks a shorter final text dropped', async () => {
    await create({id: TOPIC_A, content: 'mention'})

    await reconcile('- A\n- B\n- C', {commandId: 'rms-p1'})
    // Mid-stream (no final) must NOT prune the tail it simply hasn't re-sent.
    await reconcile('- A', {commandId: 'rms-p2'})
    expect((await replyRoots()).map(r => r.content)).toEqual(['A', 'B', 'C'])

    // The final text really is shorter — now B and C are pruned.
    await reconcile('- A', {commandId: 'rms-p3', final: true})
    expect((await replyRoots()).map(r => r.content)).toEqual(['A'])
  })

  it('keeps streamed reply roots contiguous when the user inserts a sibling mid-stream', async () => {
    await create({id: TOPIC_A, content: 'mention'})
    // Streaming tick 1: the first reply root lands.
    await reconcile('- Root A', {commandId: 'rms-c1'})
    const rootA = (await replyRoots())[0]
    // The user drops their own block right after the live reply root.
    const userBlock = await context.createBlock({parentId: TOPIC_A, content: 'user note'})

    // Streaming tick 2 (final): more roots arrive — they must stay contiguous
    // with Root A, NOT land after the user's block (splitting the reply).
    await reconcile('- Root A\n- Root B\n- Root C', {commandId: 'rms-c2', final: true})

    const children = (await context.getSubtree(TOPIC_A))
      .filter(row => row.parentId === TOPIC_A)
      .sort((a, b) => (a.orderKey! < b.orderKey! ? -1 : 1))
    expect(children.map(r => r.content)).toEqual(['Root A', 'Root B', 'Root C', 'user note'])
    expect(children[0].id).toBe(rootA.id) // Root A kept its identity
    expect(children.find(r => r.content === 'user note')!.id).toBe(userBlock!.id)
  })

  it('salvages a user block nested under a pruned reply node instead of orphaning it', async () => {
    await create({id: TOPIC_A, content: 'mention'})
    // Stream an outline: Root A, Root B.
    await reconcile('- Root A\n- Root B', {commandId: 'rms-s1'})
    const rootB = (await replyRoots()).find(r => r.content === 'Root B')!
    // The user nests their OWN note under Root B (untagged — not our reply).
    const userChild = await context.createBlock({parentId: rootB.id, content: 'user note under B'})

    // The final text is shorter — Root B is pruned. The user's note must
    // survive (reparented up to a surviving ancestor), not vanish under the
    // now-deleted Root B.
    await reconcile('- Root A', {commandId: 'rms-s2', final: true})

    const subtree = await context.getSubtree(TOPIC_A)
    const salvaged = subtree.find(row => row.id === userChild!.id)
    expect(salvaged).toBeDefined()
    expect(salvaged!.content).toBe('user note under B')
    expect(salvaged!.parentId).toBe(TOPIC_A) // bubbled up to the mention
    // Root B itself is gone, and the surviving reply is just Root A.
    expect((await replyRoots()).map(r => r.content)).toEqual(['Root A'])
  })

  it('shape:block keeps the whole markdown as ONE block (newlines preserved)', async () => {
    await create({id: TOPIC_A, content: 'mention'})

    await reconcile('line one\nline two', {shape: 'block', final: true})

    const roots = await replyRoots()
    expect(roots).toHaveLength(1)
    expect(roots[0].content).toBe('line one\nline two')
  })

  it('keeps a fenced code block whole instead of splitting it', async () => {
    await create({id: TOPIC_A, content: 'mention'})

    await reconcile('Here:\n```js\nconst x = 1\n```', {final: true})

    const subtree = await context.getSubtree(TOPIC_A)
    expect(subtree.some(row => row.content === '```js\nconst x = 1\n```')).toBe(true)
  })

  it('reconciles ONLY its own keyed subtree — user content and other keys are untouched', async () => {
    await create({id: TOPIC_A, content: 'mention'})
    const userItem = await context.createBlock({parentId: TOPIC_A, content: 'user sub-item'})
    // A different run's reply lives under the same mention.
    await reconcile('- other reply', {key: 'reply:test:2', commandId: 'rms-o'})

    await reconcile('- mine one\n- mine two', {commandId: 'rms-m1'})
    // A second reconcile of THIS key must not disturb the user block or the
    // other reply, and appends after existing children (never before them).
    await reconcile('- mine one\n- mine two\n- mine three', {commandId: 'rms-m2', final: true})

    const children = (await context.getSubtree(TOPIC_A))
      .filter(row => row.parentId === TOPIC_A)
      .sort((a, b) => (a.orderKey! < b.orderKey! ? -1 : 1))
    expect(children.map(row => row.content)).toEqual([
      'user sub-item', 'other reply', 'mine one', 'mine two', 'mine three',
    ])
    // The user block is the same block, untouched.
    expect(children[0].id).toBe(userItem!.id)
    expect(children[0].properties?.['agent:subtreeKey']).toBeUndefined()
  })
})
