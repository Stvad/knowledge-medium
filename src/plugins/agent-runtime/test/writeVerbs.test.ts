// @vitest-environment happy-dom
//
// The markdown-native, conflict-safe write verbs (`append-markdown`,
// `edit-block`, `create-page`, `update-block`'s compare-and-set) and the target
// grammar they share, end-to-end against a real Repo with every static data
// extension — so a page or daily note is created by the same kernel paths the
// app uses.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { PAGE_TYPE } from '@/data/blockTypes'
import { aliasesProp, getBlockTypes } from '@/data/properties'
import { computeAliasSeatId } from '@/data/targets'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { staticDataExtensions } from '@/extensions/staticDataExtensions'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { dailyNoteBlockId, journalBlockId } from '@/plugins/daily-notes/dailyNotes'
import { createAgentRuntimeContext, executeCommand } from '../commands'
import type { AgentRuntimeContext } from '../protocol'
import { resolveAgentTarget, resolveBlockId } from '../targets'

const WS = 'ws-1'
const OTHER_WS = 'ws-other'
const USER = {id: 'user-1', name: 'Alice'}

const NOTE = '3f2a9c1b-0000-4000-8000-000000000001'
const NOTE_TWIN = '3f2a9c1b-0000-4000-8000-000000000002'
const LONE = '7d41e0aa-0000-4000-8000-000000000003'

let sharedDb: TestDb
let repo: Repo
let context: AgentRuntimeContext

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: USER}).repo
  const runtime = resolveFacetRuntimeSync([staticDataExtensions], {repo, workspaceId: WS, safeMode: false})
  repo.setFacetRuntime(runtime)
  repo.setActiveWorkspaceId(WS)
  context = createAgentRuntimeContext({repo, runtime, safeMode: false})
})

const seed = async (
  rows: Array<{id: string, content?: string, parentId?: string | null, workspaceId?: string, orderKey?: string}>,
) => {
  await repo.tx(async tx => {
    for (const row of rows) {
      await tx.create({
        id: row.id,
        workspaceId: row.workspaceId ?? WS,
        parentId: row.parentId ?? null,
        orderKey: row.orderKey ?? 'a0',
        content: row.content ?? row.id,
      })
    }
  }, {scope: ChangeScope.BlockDefault, description: 'seed'})
}

const run = (command: Record<string, unknown>) =>
  executeCommand({commandId: 'c', ...command} as never, context)

const liveChildren = async (parentId: string) =>
  sharedDb.db.getAll<{id: string, content: string}>(
    'SELECT id, content FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id',
    [parentId],
  )

const contentOf = async (id: string) =>
  (await sharedDb.db.get<{content: string}>('SELECT content FROM blocks WHERE id = ?', [id])).content

/** command_events rowid high-water mark — the test clock is deterministic, so
 *  `created_at` can't fence "after this point". */
const commandEventsMark = async () =>
  (await sharedDb.db.get<{mark: number | null}>('SELECT max(rowid) AS mark FROM command_events')).mark ?? 0

const agentDescriptionsAfter = async (mark: number) =>
  (await sharedDb.db.getAll<{description: string}>(
    "SELECT description FROM command_events WHERE rowid > ? AND description LIKE 'agent runtime %' ORDER BY rowid",
    [mark],
  )).map(row => row.description)

describe('target resolution', () => {
  it('resolves an exact id and a unique id prefix', async () => {
    await seed([{id: NOTE}, {id: LONE}])
    expect(await resolveBlockId(repo, NOTE, 'test')).toBe(NOTE)
    expect(await resolveBlockId(repo, '7D41E0AA', 'test')).toBe(LONE)
    expect(await resolveBlockId(repo, '((7d41e0aa))', 'test')).toBe(LONE)
  })

  it('refuses an ambiguous prefix, counting a tombstone as a match', async () => {
    await seed([{id: NOTE}, {id: NOTE_TWIN}])
    await repo.mutate.delete({id: NOTE_TWIN})
    await expect(resolveBlockId(repo, '3f2a9c1b', 'test')).rejects.toThrow(/ambiguous.*deleted/s)
  })

  it('only matches a prefix inside the active workspace', async () => {
    await seed([{id: LONE, workspaceId: OTHER_WS}])
    // Unresolved refs pass through so the verb reports its own not-found.
    expect(await resolveBlockId(repo, '7d41e0aa', 'test')).toBe('7d41e0aa')
  })

  it('refuses a page target in an id field', async () => {
    await expect(resolveBlockId(repo, '[[Inbox]]', 'test')).rejects.toThrow(/expected a block id/)
  })

  it('finds an existing page by alias without creating anything', async () => {
    await repo.tx(async tx => {
      await tx.create({id: LONE, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Inbox'})
      await tx.setProperty(LONE, aliasesProp, ['Inbox'])
    }, {scope: ChangeScope.BlockDefault})
    expect(await resolveAgentTarget(repo, '[[Inbox]]', {verb: 'test', create: true}))
      .toEqual({id: LONE, workspaceId: WS, kind: 'page', created: false})
  })

  it('creates a missing page at the alias seat a wikilink would mint', async () => {
    const resolved = await resolveAgentTarget(repo, '[[Project X]]', {verb: 'test', create: true})
    expect(resolved).toEqual({
      id: computeAliasSeatId('Project X', WS, 0), workspaceId: WS, kind: 'page', created: true,
    })
    const page = (await repo.load(resolved.id))!
    expect(page.parentId).toBeNull()
    expect(getBlockTypes(page)).toContain(PAGE_TYPE)
    expect(page.properties[aliasesProp.name]).toEqual(['Project X'])
  })

  // The page is pinned to the workspace active when the call started; its
  // seat must not be minted after the user switched away (the type registry
  // the mint reads is the ACTIVE workspace's).
  it('refuses to mint a page when the active workspace moved since it was pinned', async () => {
    let reads = 0
    const spy = vi.spyOn(repo, 'activeWorkspaceId', 'get')
      .mockImplementation(() => (reads++ === 0 ? WS : 'ws-elsewhere'))
    try {
      await expect(resolveAgentTarget(repo, '[[Drifted]]', {verb: 'test', create: true}))
        .rejects.toThrow(/not the active one/)
    } finally {
      spy.mockRestore()
    }
    expect(await sharedDb.db.getAll('SELECT block_id FROM block_aliases WHERE alias = ?', ['Drifted'])).toEqual([])
  })

  it('refuses a missing page without create', async () => {
    await expect(resolveAgentTarget(repo, '[[Nope]]', {verb: 'test'})).rejects.toThrow(/no page named \[\[Nope\]\]/)
  })

  it('routes a date-literal page name and a bare date expression to the daily note', async () => {
    const iso = '2026-10-15'
    const literal = await resolveAgentTarget(repo, `[[${iso}]]`, {verb: 'test', create: true})
    expect(literal).toEqual({id: dailyNoteBlockId(WS, iso), workspaceId: WS, kind: 'daily', created: true})
    expect((await repo.load(literal.id))!.parentId).toBe(journalBlockId(WS))

    const bare = await resolveAgentTarget(repo, 'October 15th, 2026', {verb: 'test', create: true})
    expect(bare).toEqual({...literal, created: false})
  })

  it('refuses a bare name rather than reading it as a page', async () => {
    await expect(resolveAgentTarget(repo, 'Inbox', {verb: 'test', create: true}))
      .rejects.toThrow(/wrap its name: \[\[Inbox\]\]/)
    expect(await sharedDb.db.getAll('SELECT block_id FROM block_aliases WHERE alias = ?', ['Inbox'])).toEqual([])
  })
})

describe('append-markdown', () => {
  it('appends the parsed outline after existing children, in one attributed tx', async () => {
    await seed([{id: NOTE}, {id: LONE, parentId: NOTE, content: 'existing'}])
    const since = await commandEventsMark()

    const result = await run({
      type: 'append-markdown', target: NOTE, markdown: '- first\n  - nested\n- second',
    }) as {target: {id: string, created: boolean}, blocks: Array<{id: string, parentId: string, depth: number, content: string}>}

    expect(result.target).toMatchObject({id: NOTE, created: false})
    expect(result.blocks.map(block => [block.depth, block.content])).toEqual([
      [0, 'first'], [1, 'nested'], [0, 'second'],
    ])
    expect(result.blocks[1].parentId).toBe(result.blocks[0].id)
    expect((await liveChildren(NOTE)).map(row => row.content)).toEqual(['existing', 'first', 'second'])
    expect(await agentDescriptionsAfter(since)).toEqual(['agent runtime append-markdown'])
  })

  it('places the run at first, or right after a sibling given by short id', async () => {
    await seed([
      {id: NOTE},
      {id: LONE, parentId: NOTE, content: 'a', orderKey: 'a0'},
      {id: NOTE_TWIN, parentId: NOTE, content: 'z', orderKey: 'a1'},
    ])

    await run({type: 'append-markdown', target: NOTE, markdown: '- top', position: {kind: 'first'}})
    await run({
      type: 'append-markdown', target: NOTE, markdown: '- b\n- c',
      position: {kind: 'after', siblingId: '7d41e0aa'},
    })

    expect((await liveChildren(NOTE)).map(row => row.content)).toEqual(['top', 'a', 'b', 'c', 'z'])
  })

  it('creates a missing [[page]] target and reports it', async () => {
    const result = await run({type: 'append-markdown', target: '[[Reading list]]', markdown: '- a book'}) as {
      target: {id: string, kind: string, created: boolean}
    }
    expect(result.target).toMatchObject({id: computeAliasSeatId('Reading list', WS, 0), kind: 'page', created: true})
    expect((await liveChildren(result.target.id)).map(row => row.content)).toEqual(['a book'])
  })

  it('appends to a date target, creating the daily note', async () => {
    const result = await run({type: 'append-markdown', target: '2026-10-15', markdown: 'standup notes'}) as {
      target: {id: string, kind: string}
    }
    expect(result.target).toMatchObject({id: dailyNoteBlockId(WS, '2026-10-15'), kind: 'daily'})
    expect((await liveChildren(result.target.id)).map(row => row.content)).toEqual(['standup notes'])
  })

  it('shape:block keeps the markdown as one block', async () => {
    await seed([{id: NOTE}])
    await run({type: 'append-markdown', target: NOTE, markdown: '- a\n- b', shape: 'block'})
    expect((await liveChildren(NOTE)).map(row => row.content)).toEqual(['- a\n- b'])
  })

  it('refuses empty markdown before resolving — so it creates no page', async () => {
    await expect(run({type: 'append-markdown', target: '[[Ghost]]', markdown: '  \n '}))
      .rejects.toThrow(/markdown is empty/)
    expect(await sharedDb.db.getAll('SELECT block_id FROM block_aliases WHERE alias = ?', ['Ghost'])).toEqual([])
  })

  it('refuses a deleted target block', async () => {
    await seed([{id: NOTE}])
    await repo.mutate.delete({id: NOTE})
    await expect(run({type: 'append-markdown', target: NOTE, markdown: '- x'})).rejects.toThrow(/deleted/)
    expect(await liveChildren(NOTE)).toEqual([])
  })

  it('refuses a target in another workspace', async () => {
    await seed([{id: NOTE, workspaceId: OTHER_WS}])
    await expect(run({type: 'append-markdown', target: NOTE, markdown: '- x'})).rejects.toThrow(/not the active one/)
    expect(await liveChildren(NOTE)).toEqual([])
  })
})

describe('edit-block', () => {
  it('replaces the one match against the current content, literally', async () => {
    await seed([{id: NOTE, content: 'buy milk and eggs'}])
    const since = await commandEventsMark()
    await run({type: 'edit-block', id: '3f2a9c1b', old: 'milk', new: 'oat $& milk'})
    expect(await contentOf(NOTE)).toBe('buy oat $& milk and eggs')
    expect(await agentDescriptionsAfter(since)).toEqual(['agent runtime edit-block'])
  })

  it('refuses when the old text is not in the block, showing the current content', async () => {
    await seed([{id: NOTE, content: 'buy milk'}])
    await expect(run({type: 'edit-block', id: NOTE, old: 'bread', new: 'x'}))
      .rejects.toThrow(/not found.*buy milk/s)
    expect(await contentOf(NOTE)).toBe('buy milk')
  })

  it('refuses when the old text matches more than once', async () => {
    await seed([{id: NOTE, content: 'a-a-a'}])
    await expect(run({type: 'edit-block', id: NOTE, old: 'a', new: 'b'})).rejects.toThrow(/3 times/)
    expect(await contentOf(NOTE)).toBe('a-a-a')
  })

  it('refuses an empty old string', async () => {
    await seed([{id: NOTE, content: 'x'}])
    await expect(run({type: 'edit-block', id: NOTE, old: '', new: 'y'})).rejects.toThrow(/old must not be empty/)
  })

  it('refuses a deleted block', async () => {
    await seed([{id: NOTE, content: 'x'}])
    await repo.mutate.delete({id: NOTE})
    await expect(run({type: 'edit-block', id: NOTE, old: 'x', new: 'y'})).rejects.toThrow(/not found/)
  })

  it('refuses a block in another workspace', async () => {
    await seed([{id: NOTE, content: 'x', workspaceId: OTHER_WS}])
    await expect(run({type: 'edit-block', id: NOTE, old: 'x', new: 'y'})).rejects.toThrow(/not the active one/)
    expect(await contentOf(NOTE)).toBe('x')
  })
})

describe('update-block compare-and-set', () => {
  it('writes when expectedContent still matches', async () => {
    await seed([{id: NOTE, content: 'v1'}])
    await run({type: 'update-block', id: NOTE, content: 'v2', expectedContent: 'v1'})
    expect(await contentOf(NOTE)).toBe('v2')
  })

  it('refuses — content AND properties — when the block changed since it was read', async () => {
    await seed([{id: NOTE, content: 'edited elsewhere'}])
    await expect(run({
      type: 'update-block', id: NOTE, content: 'mine', properties: {flag: true}, expectedContent: 'what I read',
    })).rejects.toThrow(/changed since.*edited elsewhere/s)
    const after = (await repo.load(NOTE))!
    expect(after.content).toBe('edited elsewhere')
    expect(after.properties.flag).toBeUndefined()
  })

  it('accepts a short id', async () => {
    await seed([{id: NOTE, content: 'v1'}])
    await run({type: 'update-block', id: '3f2a9c1b', content: 'v2'})
    expect(await contentOf(NOTE)).toBe('v2')
  })
})

describe('create-page', () => {
  it('creates a page by name once, and returns it again after', async () => {
    const first = await run({type: 'create-page', name: 'Groceries'}) as {id: string, created: boolean}
    const again = await run({type: 'create-page', name: '[[Groceries]]'}) as {id: string, created: boolean}
    expect(first).toMatchObject({id: computeAliasSeatId('Groceries', WS, 0), created: true})
    expect(again).toMatchObject({id: first.id, created: false})
  })

  it('creates a daily note by date expression', async () => {
    const result = await run({type: 'create-page', date: '2026-10-15'}) as {id: string, kind: string}
    expect(result).toMatchObject({id: dailyNoteBlockId(WS, '2026-10-15'), kind: 'daily'})
  })

  it('refuses both or neither of name and date', async () => {
    await expect(run({type: 'create-page'})).rejects.toThrow(/exactly one of name or date/)
    await expect(run({type: 'create-page', name: 'a', date: 'today'})).rejects.toThrow(/exactly one of name or date/)
  })

  it('refuses a date that does not parse', async () => {
    await expect(run({type: 'create-page', date: 'someday maybe'})).rejects.toThrow(/Could not parse/)
  })
})

describe('agent write attribution', () => {
  it('describes every block-write verb as an agent runtime tx', async () => {
    await seed([{id: NOTE}, {id: LONE}])
    const since = await commandEventsMark()

    const created = await run({type: 'create-block', parentId: NOTE, content: 'child'}) as {id: string}
    await run({type: 'move-block', id: created.id, parentId: LONE, position: {kind: 'last'}})
    await run({type: 'delete-block', id: created.id})
    await run({type: 'restore-block', id: created.id})

    expect(await agentDescriptionsAfter(since)).toEqual([
      'agent runtime create-block',
      'agent runtime move-block',
      'agent runtime delete-block',
      'agent runtime restore-block',
    ])
  })

  it('create-block accepts a [[page]] parent, creating the page', async () => {
    const created = await run({type: 'create-block', parentId: '[[Someday]]', content: 'idea'}) as {parentId: string}
    expect(created.parentId).toBe(computeAliasSeatId('Someday', WS, 0))
  })
})

interface ChangesOut {
  truncated: boolean
  txs: Array<{
    description: string | null
    changes: Array<{blockId: string, kind: string, changed: string[], content?: {before?: string, after?: string}}>
  }>
}

describe('recent-changes', () => {
  const userEdit = async (id: string, content: string, scope: ChangeScope = ChangeScope.BlockDefault) =>
    repo.tx(async tx => { await tx.update(id, {content}) }, {scope, description: 'typing'})

  it('lists agent transactions newest first with the blocks each changed, skipping user edits', async () => {
    await seed([{id: NOTE, content: 'draft'}])
    await userEdit(NOTE, 'draft by user')
    const appended = await run({type: 'append-markdown', target: NOTE, markdown: '- added'}) as {
      blocks: Array<{id: string}>
    }
    await run({type: 'edit-block', id: NOTE, old: 'user', new: 'agent'})

    const out = await run({type: 'recent-changes'}) as ChangesOut
    expect(out.txs.map(tx => tx.description)).toEqual([
      'agent runtime edit-block',
      'agent runtime append-markdown',
    ])
    expect(out.txs[0].changes).toEqual([{
      blockId: NOTE, kind: 'update', changed: ['content'],
      content: {before: 'draft by user', after: 'draft by agent'},
    }])
    expect(out.txs[1].changes.map(change => [change.blockId, change.kind])).toContainEqual(
      [appended.blocks[0].id, 'create'],
    )
  })

  it('includeUser adds the user\'s document edits but never UI-state writes', async () => {
    await seed([{id: NOTE, content: 'a'}])
    await userEdit(NOTE, 'b')
    await userEdit(NOTE, 'ui flicker', ChangeScope.UiState)

    const out = await run({type: 'recent-changes', includeUser: true}) as ChangesOut
    const descriptions = out.txs.map(tx => tx.description)
    expect(descriptions).toContain('typing')
    expect(out.txs.flatMap(tx => tx.changes).map(change => change.content?.after)).not.toContain('ui flicker')
  })

  it('honours since and limit, reporting truncation', async () => {
    await seed([{id: NOTE, content: 'v0'}])
    for (const n of [1, 2, 3]) await run({type: 'update-block', id: NOTE, content: `v${n}`})
    const cutoff = (await sharedDb.db.get<{at: number}>(
      "SELECT max(created_at) AS at FROM command_events WHERE description = 'agent runtime update-block'",
    )).at

    const limited = await run({type: 'recent-changes', limit: 2}) as ChangesOut
    expect(limited.txs).toHaveLength(2)
    expect(limited.truncated).toBe(true)

    const recent = await run({type: 'recent-changes', since: cutoff}) as ChangesOut
    expect(recent.txs.flatMap(tx => tx.changes).map(change => change.content?.after)).toEqual(['v3'])
  })

  it('refuses a since it cannot read', async () => {
    await expect(run({type: 'recent-changes', since: 'last tuesday-ish'})).rejects.toThrow(/since must be/)
  })
})

describe('block-history', () => {
  it('lists one block\'s changes newest first with full content, local and sync-applied', async () => {
    await seed([{id: NOTE, content: 'v1'}, {id: LONE}])
    await run({type: 'update-block', id: NOTE, content: 'v2'})
    await run({type: 'move-block', id: NOTE, parentId: LONE, position: {kind: 'last'}})
    // A raw write outside repo.tx is how a sync-applied change reaches `blocks`.
    await sharedDb.db.writeTransaction(async db => {
      await db.execute('UPDATE blocks SET content = ? WHERE id = ?', ['v3 from another device', NOTE])
    })
    await run({type: 'delete-block', id: NOTE})
    await run({type: 'restore-block', id: NOTE})

    const out = await run({type: 'block-history', id: '3f2a9c1b'}) as {
      events: Array<{kind: string, source: string, description: string | null, content?: {before?: string, after?: string}}>
    }
    expect(out.events.map(event => [event.kind, event.source, event.description])).toEqual([
      ['restore', 'local', 'agent runtime restore-block'],
      ['soft-delete', 'local', 'agent runtime delete-block'],
      ['update', 'sync', null],
      ['move', 'local', 'agent runtime move-block'],
      ['update', 'local', 'agent runtime update-block'],
      ['create', 'local', 'seed'],
    ])
    expect(out.events[2].content).toEqual({before: 'v2', after: 'v3 from another device'})
  })

  it('refuses a block with no recorded changes', async () => {
    await expect(run({type: 'block-history', id: LONE})).rejects.toThrow(/no recorded changes/)
  })
})
