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
import { MAX_ALIAS_LENGTH } from '@/data/referenceBlock'
import { ensureDailyNoteTarget } from '@/plugins/daily-notes/dailyNotes'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { staticDataExtensions } from '@/extensions/staticDataExtensions'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { dailyNoteBlockId, journalBlockId } from '@/plugins/daily-notes/dailyNotes'
import { createAgentRuntimeContext, executeCommand } from '../commands'
import type { AgentRuntimeContext } from '../protocol'
import { resolveAgentTarget, resolveBlockId, resolvePageTarget } from '../targets'
import { agentTxOptions } from '../agentWrites'
import { BLOCK_HISTORY_CONTENT_CHARS, MAX_LISTED_CHANGES } from '../changeHistory'
import { parseMarkdownToBlocks } from '@/utils/markdownParser.js'
import { AGENT_VIEW_DEFAULTS } from '@knowledge-medium/agent-cli/protocol'

// Passthrough spy, so a test can tell whether a refusal beat the parse.
vi.mock('@/utils/markdownParser.js', async original => {
  const actual = await original<typeof import('@/utils/markdownParser.js')>()
  return {...actual, parseMarkdownToBlocks: vi.fn(actual.parseMarkdownToBlocks)}
})

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
  // Real uuids, so created blocks get `^short` ids like production ones.
  repo = createTestRepo({db: sharedDb.db, user: USER, newId: () => crypto.randomUUID()}).repo
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

  it('refuses an ambiguous prefix', async () => {
    await seed([{id: NOTE}, {id: NOTE_TWIN}])
    await expect(resolveBlockId(repo, '^3f2a9c1b', 'test')).rejects.toThrow(/ambiguous/)
  })

  it('passes a ref that matches nothing through, so the verb reports its own not-found', async () => {
    expect(await resolveBlockId(repo, '7d41e0aa', 'test')).toBe('7d41e0aa')
    await expect(run({type: 'update-block', id: '7d41e0aa', content: 'x'})).rejects.toThrow(/not found/)
  })

  it('refuses a page target in an id field', async () => {
    await expect(resolveBlockId(repo, '[[Inbox]]', 'test')).rejects.toThrow(/expected a block id/)
  })

  it('finds an existing page by alias without creating anything', async () => {
    await repo.tx(async tx => {
      await tx.create({id: LONE, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Inbox'})
      await tx.setProperty(LONE, aliasesProp, ['Inbox'])
    }, {scope: ChangeScope.BlockDefault})
    expect(await resolveAgentTarget(repo, '[[Inbox]]', 'test'))
      .toEqual({id: LONE, kind: 'page', created: false})
    expect(await resolveAgentTarget(repo, 'Inbox', 'test'))
      .toEqual({id: LONE, kind: 'page', created: false})
  })

  it('creates a daily note only for an explicit date — a word that merely parses as one finds an existing note', async () => {
    await expect(resolveAgentTarget(repo, 'weekend', 'test')).rejects.toThrow(/does not exist.*\[\[weekend\]\]/s)
    await expect(resolveAgentTarget(repo, 'May', 'test')).rejects.toThrow(/does not exist/)
    expect(await sharedDb.db.getAll(
      `SELECT id FROM blocks WHERE json_extract(properties_json, '$."daily-note:date"') IS NOT NULL`,
    )).toEqual([])
    for (const explicit of ['today', '2026-03-04', 'next monday', 'March 4th, 2026']) {
      expect(await resolveAgentTarget(repo, explicit, 'test')).toMatchObject({kind: 'daily'})
    }
  })

  it('creates a missing page at the alias seat a wikilink would mint', async () => {
    const resolved = await resolveAgentTarget(repo, '[[Project X]]', 'test')
    expect(resolved).toEqual({id: computeAliasSeatId('Project X', WS, 0), kind: 'page', created: true})
    const page = (await repo.load(resolved.id))!
    expect(page.parentId).toBeNull()
    expect(getBlockTypes(page)).toContain(PAGE_TYPE)
    expect(page.properties[aliasesProp.name]).toEqual(['Project X'])
  })

  // A block target is held to the workspace the call started in too: a switch
  // to the block's own workspace mid-call must not let the write through.
  it('refuses a block target in another workspace even after the app switched to it', async () => {
    await seed([{id: LONE, workspaceId: OTHER_WS}])
    let reads = 0
    const spy = vi.spyOn(repo, 'activeWorkspaceId', 'get')
      .mockImplementation(() => (reads++ === 0 ? WS : OTHER_WS))
    try {
      await expect(resolveAgentTarget(repo, LONE, 'test')).rejects.toThrow(/changed from ws-1 to ws-other/)
    } finally {
      spy.mockRestore()
    }
  })

  it('creates nothing when a bare name\'s alias is gone by the second lookup', async () => {
    // The alias answers the resolver's lookup, then is gone for the page path's.
    const original = repo.query
    let calls = 0
    const writable = repo as unknown as {query: unknown}
    writable.query = new Proxy(original, {
      get: (target, name) => name !== 'aliasLookup' ? Reflect.get(target, name) : (args: never) => {
        calls += 1
        return calls === 1 ? {load: async () => ({id: LONE})} : original.aliasLookup(args)
      },
    })
    try {
      await expect(resolveAgentTarget(repo, 'Vanishing', 'test')).rejects.toThrow(/no page named/)
    } finally {
      writable.query = original
    }
    expect(await sharedDb.db.getAll('SELECT block_id FROM block_aliases WHERE alias = ?', ['Vanishing'])).toEqual([])
  })

  // The page is pinned to the workspace active when the call started; its
  // seat must not be minted after the user switched away (the type registry
  // the mint reads is the ACTIVE workspace's).
  it('refuses to mint a page when the active workspace moved since it was pinned', async () => {
    let reads = 0
    const spy = vi.spyOn(repo, 'activeWorkspaceId', 'get')
      .mockImplementation(() => (reads++ === 0 ? WS : 'ws-elsewhere'))
    try {
      await expect(resolveAgentTarget(repo, '[[Drifted]]', 'test'))
        .rejects.toThrow(/not the active one/)
    } finally {
      spy.mockRestore()
    }
    expect(await sharedDb.db.getAll('SELECT block_id FROM block_aliases WHERE alias = ?', ['Drifted'])).toEqual([])
  })

  it('refuses an existing page when the active workspace moved during its lookup', async () => {
    await resolveAgentTarget(repo, '[[Settled]]', 'test')
    let active = WS
    const spy = vi.spyOn(repo, 'activeWorkspaceId', 'get').mockImplementation(() => active)
    const original = repo.query
    const writable = repo as unknown as {query: unknown}
    writable.query = new Proxy(original, {
      get: (target, name) => name !== 'aliasLookup' ? Reflect.get(target, name) : (args: never) => ({
        load: async () => {
          const found = await original.aliasLookup(args).load()
          active = 'ws-elsewhere'
          return found
        },
      }),
    })
    try {
      await expect(resolvePageTarget(repo, 'Settled', 'test')).rejects.toThrow(/not the active one/)
    } finally {
      writable.query = original
      spy.mockRestore()
    }
  })

  it('never resolves an id field by page name — the page is not touched', async () => {
    await repo.tx(async tx => {
      await tx.create({id: LONE, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Inbox'})
      await tx.setProperty(LONE, aliasesProp, ['Inbox'])
    }, {scope: ChangeScope.BlockDefault})
    await expect(run({type: 'delete-block', id: 'Inbox'})).rejects.toThrow(/does not exist/)
    expect((await repo.load(LONE))?.deleted).toBe(false)
  })

  it('routes a date-literal page name and a bare date expression to the daily note', async () => {
    const iso = '2026-10-15'
    const literal = await resolveAgentTarget(repo, `[[${iso}]]`, 'test')
    expect(literal).toEqual({id: dailyNoteBlockId(WS, iso), kind: 'daily', created: true})
    expect((await repo.load(literal.id))!.parentId).toBe(journalBlockId(WS))

    const bare = await resolveAgentTarget(repo, 'October 15th, 2026', 'test')
    expect(bare).toEqual({...literal, created: false})
  })

  it('refuses to create from a bare name — that takes [[Name]]', async () => {
    await expect(resolveAgentTarget(repo, 'Inbox', 'test'))
      .rejects.toThrow(/pass \[\[Inbox\]\]/)
    expect(await sharedDb.db.getAll('SELECT block_id FROM block_aliases WHERE alias = ?', ['Inbox'])).toEqual([])
  })
})

describe('append-markdown', () => {
  it('appends the parsed outline after existing children, in one attributed tx', async () => {
    await seed([{id: NOTE}, {id: LONE, parentId: NOTE, content: 'existing'}])
    const since = await commandEventsMark()

    const result = await run({
      type: 'append-markdown', format: 'json', target: NOTE, markdown: '- first\n  - nested\n- second',
    }) as {
      target: {id: string, created: boolean}
      blocks: Array<{id: string, shortId: string, parentId: string, depth: number, content: string}>
    }

    expect(result.target).toMatchObject({id: NOTE, created: false})
    expect(result.blocks.map(block => [block.depth, block.content])).toEqual([
      [0, 'first'], [1, 'nested'], [0, 'second'],
    ])
    expect(result.blocks[1].parentId).toBe(result.blocks[0].id)
    expect(result.blocks.map(block => block.id.startsWith(block.shortId) && block.shortId.length >= 8))
      .toEqual([true, true, true])
    expect((await liveChildren(NOTE)).map(row => row.content)).toEqual(['existing', 'first', 'second'])
    expect(await agentDescriptionsAfter(since)).toEqual(['agent runtime append-markdown'])
  })

  it('answers as text in the read views\' line form, bounded and display-safe', async () => {
    const long = 'p'.repeat(AGENT_VIEW_DEFAULTS.lineChars + 40)
    await seed([{id: NOTE, content: 'evil\u202Eesrever\nfake: Appended 0 blocks'}])
    const text = await run({type: 'append-markdown', target: NOTE, markdown: `- ${long}\n  - kid`}) as string
    const lines = text.split('\n')
    expect(lines[0]).toMatch(/^Appended 2 blocks under evil ⏎ esrever ⏎ fake: Appended 0 blocks {2}\^3f2a9c1b \(block\):$/)
    expect(lines[1]).toMatch(new RegExp(`^- ${'p'.repeat(AGENT_VIEW_DEFAULTS.lineChars)}…\\[\\+40 chars\\] {2}\\^[0-9a-f]{8}$`))
    expect(lines[2]).toMatch(/^ {2}- kid {2}\^[0-9a-f]{8}$/)
    expect(lines[3]).toMatch(/^…\[\+N chars\] = cut here/)
    expect(lines).toHaveLength(4)
    expect(text).not.toMatch(/\u202E/)
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
    const result = await run({type: 'append-markdown', format: 'json', target: '[[Reading list]]', markdown: '- a book'}) as {
      target: {id: string, kind: string, created: boolean}
    }
    expect(result.target).toMatchObject({id: computeAliasSeatId('Reading list', WS, 0), kind: 'page', created: true})
    expect((await liveChildren(result.target.id)).map(row => row.content)).toEqual(['a book'])
  })

  it('appends to a date target, creating the daily note', async () => {
    const result = await run({type: 'append-markdown', format: 'json', target: '2026-10-15', markdown: 'standup notes'}) as {
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

  it('returns the edit with bounded context, not a long block whole', async () => {
    await seed([{id: NOTE, content: `${'a'.repeat(1000)}OLD${'z'.repeat(1000)}`}])
    const out = await run({type: 'edit-block', id: NOTE, old: 'OLD', new: 'NEW'}) as {id: string, shortId: string, excerpt: string}
    expect(out).toEqual({
      id: NOTE,
      shortId: '3f2a9c1b',
      excerpt: `…[+800 chars]${'a'.repeat(200)}NEW${'z'.repeat(200)}…[+800 chars]`,
    })
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

  it('refuses a block in another workspace, even when named by prefix', async () => {
    await seed([{id: NOTE, content: 'x', workspaceId: OTHER_WS}])
    await expect(run({type: 'edit-block', id: '3f2a9c1b', old: 'x', new: 'y'})).rejects.toThrow(/not the active one/)
    expect(await contentOf(NOTE)).toBe('x')
  })
})

describe('update-block compare-and-set', () => {
  it('writes when expectedContent still matches', async () => {
    await seed([{id: NOTE, content: 'v1'}])
    await run({type: 'update-block', id: NOTE, content: 'v2', expectedContent: 'v1'})
    expect(await contentOf(NOTE)).toBe('v2')
  })

  it('refuses — content AND properties — when the content is not the expectedContent', async () => {
    await seed([{id: NOTE, content: 'edited elsewhere'}])
    await expect(run({
      type: 'update-block', id: NOTE, content: 'mine', properties: {flag: true}, expectedContent: 'what I read',
    })).rejects.toThrow(/not the expectedContent.*edited elsewhere/s)
    const after = (await repo.load(NOTE))!
    expect(after.content).toBe('edited elsewhere')
    expect(after.properties.flag).toBeUndefined()
  })

  it('echoes a long current content cut, with the read views\' marker', async () => {
    await seed([{id: NOTE, content: 'z'.repeat(1100)}])
    await expect(run({type: 'update-block', id: NOTE, content: 'mine', expectedContent: 'what I read'}))
      .rejects.toThrow(`"${'z'.repeat(1000)}"…[+100 chars]`)
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

  it('refuses a name no wikilink could reach, as typing that link would create nothing', async () => {
    const name = 'a'.repeat(MAX_ALIAS_LENGTH + 1)
    await expect(run({type: 'create-page', name})).rejects.toThrow()
    await expect(run({type: 'append-markdown', target: `[[${name}]]`, markdown: '- x'})).rejects.toThrow()
    expect(await sharedDb.db.getAll('SELECT block_id FROM block_aliases WHERE alias = ?', [name])).toEqual([])
  })

  it('answers with a bounded line of the page, not its whole content', async () => {
    await repo.tx(async tx => {
      await tx.create({id: LONE, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'q'.repeat(5000)})
      await tx.setProperty(LONE, aliasesProp, ['Big'])
    }, {scope: ChangeScope.BlockDefault})
    const out = await run({type: 'create-page', name: 'Big'}) as {id: string, content: string, cut: number}
    expect(out).toMatchObject({id: LONE, cut: 5000 - AGENT_VIEW_DEFAULTS.lineChars})
    expect(out.content).toBe(`${'q'.repeat(AGENT_VIEW_DEFAULTS.lineChars)}…[+${(5000 - AGENT_VIEW_DEFAULTS.lineChars).toLocaleString('en-US')} chars]`)
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

  it('create-block refuses an explicit id that exists before creating a [[page]] parent', async () => {
    await seed([{id: NOTE, content: 'taken'}])
    await expect(run({type: 'create-block', parentId: '[[Fresh]]', content: 'x', data: {id: NOTE}}))
      .rejects.toThrow(/already exists/)
    expect(await sharedDb.db.getAll('SELECT block_id FROM block_aliases WHERE alias = ?', ['Fresh'])).toEqual([])
  })

  it('create-block refuses an empty parentId rather than writing a top-level block', async () => {
    await expect(run({type: 'create-block', parentId: '', content: 'loose'})).rejects.toThrow(/empty/)
    expect(await sharedDb.db.getAll('SELECT id FROM blocks WHERE content = ?', ['loose'])).toEqual([])
  })

  it('create-block takes a null parentId as a top-level block, as move-block does', async () => {
    const created = await run({type: 'create-block', parentId: null, content: 'loose'}) as {parentId: string | null, workspaceId: string}
    expect(created).toMatchObject({parentId: null, workspaceId: WS})
  })
})

interface ChangesOut {
  truncated: boolean
  txs: Array<{
    description: string | null
    incomplete?: true
    changes: Array<{blockId: string, kind: string, changed: string[], content?: {before?: string, after?: string}}>
  }>
}

describe('recent-changes', () => {
  const userEdit = async (id: string, content: string, scope: ChangeScope = ChangeScope.BlockDefault) =>
    repo.tx(async tx => { await tx.update(id, {content}) }, {scope, description: 'typing'})

  it('lists agent transactions newest first with the blocks each changed, skipping user edits', async () => {
    await seed([{id: NOTE, content: 'draft'}])
    await userEdit(NOTE, 'draft by user')
    const appended = await run({type: 'append-markdown', format: 'json', target: NOTE, markdown: '- added'}) as {
      blocks: Array<{id: string}>
    }
    await run({type: 'edit-block', id: NOTE, old: 'user', new: 'agent'})

    const out = await run({type: 'recent-changes'}) as ChangesOut
    expect(out.txs.map(tx => tx.description)).toEqual([
      'agent runtime edit-block',
      'agent runtime append-markdown',
    ])
    expect(out.txs[0].changes).toEqual([{
      blockId: NOTE, shortId: '3f2a9c1b', kind: 'update', changed: ['content'],
      content: {before: 'draft by user', after: 'draft by agent'},
    }])
    expect(out.txs[1].changes.map(change => [change.blockId, change.kind])).toContainEqual(
      [appended.blocks[0].id, 'create'],
    )
  })

  it('lists no change for a block a tx changed and changed back', async () => {
    await seed([{id: NOTE, content: 'same'}, {id: LONE, content: 'before'}])
    // Outside any tx, so not listed; the round trip below then moves the stamps.
    await sharedDb.db.execute('UPDATE blocks SET updated_at = 1, user_updated_at = 1 WHERE id = ?', [NOTE])
    await repo.tx(async tx => {
      await tx.update(NOTE, {content: 'detour'})
      await tx.update(NOTE, {content: 'same'})
      await tx.update(LONE, {content: 'after'})
    }, agentTxOptions('update-block'))
    const out = await run({type: 'recent-changes'}) as ChangesOut
    expect(out.txs[0].changes.map(change => change.blockId)).toEqual([LONE])
  })

  it('leaves a tx with no net change out of the page, so it never displaces a real one', async () => {
    await seed([{id: NOTE, content: 'same'}, {id: LONE, content: 'before'}])
    await run({type: 'update-block', id: LONE, content: 'after'})
    await repo.tx(async tx => {
      await tx.update(NOTE, {content: 'detour'})
      await tx.update(NOTE, {content: 'same'})
    }, agentTxOptions('update-block'))
    const out = await run({type: 'recent-changes', limit: 1}) as ChangesOut & {truncated: boolean}
    expect(out.txs.map(tx => tx.changes.map(change => change.blockId))).toEqual([[LONE]])
    expect(out.truncated).toBe(false)
  })

  it('clips listed content with the read views\' cut marker', async () => {
    await seed([{id: NOTE, content: 'short'}])
    await run({type: 'update-block', id: NOTE, content: 'y'.repeat(250)})
    const out = await run({type: 'recent-changes'}) as ChangesOut
    expect(out.txs[0].changes[0].content?.after).toBe(`${'y'.repeat(200)}…[+50 chars]`)
  })

  it('lists at most MAX_LISTED_CHANGES blocks per call, newest tx first, and flags a tx it cut', async () => {
    await seed([{id: NOTE, content: 'draft'}])
    const bullets = Array.from({length: MAX_LISTED_CHANGES + 3}, (_, i) => `- item ${i}`).join('\n')
    await run({type: 'append-markdown', target: NOTE, markdown: bullets})
    await run({type: 'edit-block', id: NOTE, old: 'draft', new: 'final'})

    const out = await run({type: 'recent-changes', limit: 2}) as ChangesOut
    expect(out.txs.map(tx => [tx.description, tx.changes.length, tx.incomplete])).toEqual([
      ['agent runtime edit-block', 1, undefined],
      ['agent runtime append-markdown', MAX_LISTED_CHANGES - 1, true],
    ])
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
  it('cuts each snapshot\'s content at BLOCK_HISTORY_CONTENT_CHARS, marked', async () => {
    const long = 'w'.repeat(BLOCK_HISTORY_CONTENT_CHARS + 30)
    await seed([{id: NOTE, content: long}])
    await run({type: 'update-block', id: NOTE, content: 'short'})
    const out = await run({type: 'block-history', id: NOTE}) as {events: Array<{content?: {before?: string, after?: string}}>}
    expect(out.events[0].content).toEqual({before: `${'w'.repeat(BLOCK_HISTORY_CONTENT_CHARS)}…[+30 chars]`, after: 'short'})
  })

  it('marks a content cut at a NUL character, which SQLite text functions stop at', async () => {
    await seed([{id: NOTE, content: 'before\u0000after'}])
    await run({type: 'update-block', id: NOTE, content: 'plain'})
    const out = await run({type: 'block-history', id: NOTE}) as {events: Array<{content?: {before?: string, after?: string}}>}
    expect(out.events[0].content).toEqual({before: 'before…[cut at a NUL character]', after: 'plain'})
  })

  it('never loads a long content whole — both history views read a bounded head from SQL', async () => {
    const huge = 'h'.repeat(50_000)
    await seed([{id: NOTE, content: huge}])
    await run({type: 'update-block', id: NOTE, content: `${huge}!`})
    const getAll = vi.spyOn(repo.db, 'getAll')
    try {
      await run({type: 'block-history', id: NOTE})
      await run({type: 'recent-changes'})
      const results = await Promise.all(getAll.mock.results.map(result => result.value as Promise<unknown[]>))
      const longest = Math.max(0, ...results.flat().flatMap(row => Object.values(row as object))
        .map(value => typeof value === 'string' ? value.length : 0))
      expect(longest).toBeLessThan(BLOCK_HISTORY_CONTENT_CHARS + 100)
    } finally {
      getAll.mockRestore()
    }
  })

  // A raw write fires no references processor, so the bags stay as written.
  const writeBags = (id: string, properties: object, references: unknown[]) =>
    sharedDb.db.writeTransaction(async db => {
      await db.execute(
        'UPDATE blocks SET properties_json = ?, references_json = ? WHERE id = ?',
        [JSON.stringify(properties), JSON.stringify(references), id],
      )
    })

  it('never loads a property bag or a reference list whole', async () => {
    const huge = 'p'.repeat(50_000)
    await seed([{id: NOTE, content: 'v1'}])
    await writeBags(NOTE, {big: huge}, [{id: LONE, alias: huge}])
    await run({type: 'update-block', id: NOTE, content: 'v2'})
    const getAll = vi.spyOn(repo.db, 'getAll')
    try {
      await run({type: 'block-history', id: NOTE})
      await run({type: 'recent-changes'})
      const results = await Promise.all(getAll.mock.results.map(result => result.value as Promise<unknown[]>))
      const longest = Math.max(0, ...results.flat().flatMap(row => Object.values(row as object))
        .map(value => typeof value === 'string' ? value.length : 0))
      expect(longest).toBeLessThan(BLOCK_HISTORY_CONTENT_CHARS + 100)
    } finally {
      getAll.mockRestore()
    }
  })

  it('names exactly the properties an update changed, added or removed, and flags changed references', async () => {
    await seed([{id: NOTE}])
    await writeBags(NOTE, {keep: 'same', edit: 'old', gone: 1, flag: 1}, [])
    await writeBags(NOTE, {keep: 'same', edit: 'new', added: {a: [1]}, flag: true}, [{id: LONE}])
    const out = await run({type: 'block-history', id: NOTE}) as {
      events: Array<{kind: string, changed: string[], properties?: string[]}>
    }
    expect(out.events[0]).toMatchObject({
      kind: 'update', changed: ['properties', 'references'], properties: ['added', 'edit', 'flag', 'gone'],
    })
  })

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

// The route the km MCP tool descriptions document for todos.
describe('todo writes through the raw property bag', () => {
  it('create-block with types:[todo] + status makes a todo; update-block marks it done', async () => {
    await seed([{id: NOTE}])
    const created = await run({
      type: 'create-block', parentId: NOTE, content: 'buy milk',
      properties: {types: ['todo'], status: 'open'},
    }) as {id: string}

    expect(getBlockTypes((await repo.load(created.id))!)).toContain('todo')
    const typed = await sharedDb.db.getAll<{block_id: string}>(
      "SELECT block_id FROM block_types WHERE type = 'todo'",
    )
    expect(typed.map(row => row.block_id)).toEqual([created.id])

    await run({type: 'update-block', id: created.id, properties: {status: 'done'}})
    const done = (await repo.load(created.id))!
    expect(done.properties.status).toBe('done')
    expect(getBlockTypes(done)).toContain('todo')
  })
})

describe('review round 1', () => {
  it('resolve-block-id expands a short id the way the write verbs do, and never takes a name', async () => {
    await seed([{id: NOTE}])
    expect(await run({type: 'resolve-block-id', ref: '^3f2a9c1b'})).toEqual({id: NOTE})
    expect(await run({type: 'resolve-block-id', ref: 'no-such'})).toEqual({id: 'no-such'})
    await expect(run({type: 'resolve-block-id', ref: '[[Inbox]]'})).rejects.toThrow(/expected a block id/)
  })

  it('promotes a daily-note seat a date wikilink minted, instead of appending under it at root', async () => {
    const iso = '2026-10-15'
    await repo.tx(async tx => {
      await ensureDailyNoteTarget(tx, repo, iso, WS)
    }, {scope: ChangeScope.BlockDefault})
    const seatId = dailyNoteBlockId(WS, iso)
    expect((await repo.load(seatId))!.parentId).toBeNull()

    for (const target of [iso, `[[${iso}]]`]) {
      const result = await run({type: 'append-markdown', format: 'json', target, markdown: '- note'}) as {
        target: {id: string, kind: string, created: boolean}
      }
      expect(result.target).toMatchObject({id: seatId, kind: 'daily', created: false})
    }
    expect((await repo.load(seatId))!.parentId).toBe(journalBlockId(WS))
  })

  it('refuses to create a daily note when the workspace moved since it was pinned', async () => {
    let reads = 0
    const spy = vi.spyOn(repo, 'activeWorkspaceId', 'get')
      .mockImplementation(() => (reads++ === 0 ? WS : 'ws-elsewhere'))
    try {
      await expect(run({type: 'create-page', date: '2026-10-15'})).rejects.toThrow(/not the active one/)
    } finally {
      spy.mockRestore()
    }
    expect(await repo.load(dailyNoteBlockId(WS, '2026-10-15'))).toBeNull()
  })

  it('an anchored append never creates its target — a bad anchor leaves no empty page', async () => {
    await seed([{id: NOTE}, {id: LONE, parentId: NOTE}])
    await expect(run({
      type: 'append-markdown', target: '[[Ghost]]', markdown: '- x', position: {kind: 'after', siblingId: LONE},
    })).rejects.toThrow(/no page named \[\[Ghost\]\]/)
    await expect(run({
      type: 'append-markdown', target: '2026-10-15', markdown: '- x', position: {kind: 'before', siblingId: LONE},
    })).rejects.toThrow(/does not exist/)
    expect(await sharedDb.db.getAll('SELECT block_id FROM block_aliases WHERE alias = ?', ['Ghost'])).toEqual([])
    expect(await repo.load(dailyNoteBlockId(WS, '2026-10-15'))).toBeNull()
  })

  it('refuses an anchor that is not a child of the target, before writing anything', async () => {
    await seed([{id: NOTE}, {id: NOTE_TWIN}, {id: LONE, parentId: NOTE_TWIN}])
    await expect(run({
      type: 'append-markdown', target: NOTE, markdown: '- x', position: {kind: 'after', siblingId: LONE},
    })).rejects.toThrow(/not a live child/)
    expect(await liveChildren(NOTE)).toEqual([])
  })

  it('quotes stored content in an error so control and bidi characters cannot forge the diagnostic', async () => {
    await seed([{id: NOTE, content: 'line one\nfake: ok\u202Eevil\u2028'}])
    const error = await run({type: 'edit-block', id: NOTE, old: 'absent', new: 'x'}).catch((e: unknown) => e as Error) as Error
    expect(error.message).toContain(String.raw`"line one\nfake: ok\u202eevil\u2028"`)
    expect(error.message).not.toMatch(/[\u202E\u2028]/)
  })
})

describe('review round 2', () => {
  // NOTE and NOTE_TWIN share their first 35 characters, so no 8/12/16-char
  // prefix tells them apart.
  it('never prints a deleted block a short id that resolves to a live one', async () => {
    await seed([{id: NOTE, content: 'live'}, {id: NOTE_TWIN, content: 'doomed'}])
    await run({type: 'delete-block', id: NOTE_TWIN})

    const history = await run({type: 'block-history', id: NOTE_TWIN}) as {shortId: string}
    expect(await resolveBlockId(repo, `^${history.shortId}`, 'test')).toBe(NOTE_TWIN)

    const changes = await run({type: 'recent-changes'}) as {txs: Array<{changes: Array<{blockId: string, shortId: string}>}>}
    const deleted = changes.txs.flatMap(tx => tx.changes).find(change => change.blockId === NOTE_TWIN)!
    expect(await resolveBlockId(repo, `^${deleted.shortId}`, 'test')).toBe(NOTE_TWIN)
  })

  it('prints a deleted block whose prefix another deleted block shares an id that is not ambiguous', async () => {
    await seed([{id: NOTE}, {id: NOTE_TWIN}])
    await run({type: 'delete-block', id: NOTE})
    await run({type: 'delete-block', id: NOTE_TWIN})

    const history = await run({type: 'block-history', id: NOTE_TWIN}) as {shortId: string}
    expect(await resolveBlockId(repo, `^${history.shortId}`, 'test')).toBe(NOTE_TWIN)
  })

  it('names the properties a create set', async () => {
    await seed([{id: NOTE}])
    await run({type: 'create-block', parentId: NOTE, content: 'task', properties: {types: ['todo'], status: 'open'}})
    const out = await run({type: 'recent-changes'}) as {
      txs: Array<{changes: Array<{kind: string, changed: string[], properties?: string[]}>}>
    }
    const created = out.txs[0].changes.find(change => change.kind === 'create')!
    expect(created.changed).toContain('properties')
    expect(created.properties).toEqual(expect.arrayContaining(['status', 'types']))
  })

  it('refuses a missing append target before parsing the markdown', async () => {
    vi.mocked(parseMarkdownToBlocks).mockClear()
    await expect(run({type: 'append-markdown', target: '^7d41e0aa', markdown: '- a\n- b'}))
      .rejects.toThrow(/No block matches/)
    expect(parseMarkdownToBlocks).not.toHaveBeenCalled()
  })

  it('refuses a full id that names no block before parsing — a UUID resolves without a lookup', async () => {
    vi.mocked(parseMarkdownToBlocks).mockClear()
    await expect(run({type: 'append-markdown', target: LONE, markdown: '- a\n- b'})).rejects.toThrow(/not found/)
    expect(parseMarkdownToBlocks).not.toHaveBeenCalled()
  })

  it('refuses an anchor that is missing or not a live child of the target before parsing', async () => {
    await seed([{id: NOTE}, {id: LONE}, {id: 'kid', parentId: LONE}])
    vi.mocked(parseMarkdownToBlocks).mockClear()
    for (const siblingId of ['kid', '7d41e0aa-0000-4000-8000-0000000000ff']) {
      await expect(run({
        type: 'append-markdown', target: NOTE, markdown: '- a', position: {kind: 'after', siblingId},
      })).rejects.toThrow(/not a live child/)
    }
    expect(parseMarkdownToBlocks).not.toHaveBeenCalled()
  })

  it('refuses a live target in another workspace before parsing the markdown', async () => {
    await seed([{id: LONE, workspaceId: OTHER_WS}])
    vi.mocked(parseMarkdownToBlocks).mockClear()
    await expect(run({type: 'append-markdown', target: LONE, markdown: '- a\n- b'})).rejects.toThrow(/not the active one/)
    expect(parseMarkdownToBlocks).not.toHaveBeenCalled()
  })

  it('refuses a deleted target before parsing the markdown', async () => {
    await seed([{id: NOTE}])
    await repo.mutate.delete({id: NOTE})
    vi.mocked(parseMarkdownToBlocks).mockClear()
    await expect(run({type: 'append-markdown', target: NOTE, markdown: '- a\n- b'})).rejects.toThrow(/deleted/)
    expect(parseMarkdownToBlocks).not.toHaveBeenCalled()
  })
})

describe('review round 3', () => {
  // `blockId.ts` admits a non-lowercase id that sync or a restore brings in.
  it('acts on a mixed-case id exactly as given, never on its lowercase twin', async () => {
    const upper = NOTE.toUpperCase()
    await seed([{id: NOTE, content: 'lower'}, {id: upper, content: 'upper'}])
    await run({type: 'edit-block', id: upper, old: 'upper', new: 'UPPER'})
    expect(await contentOf(upper)).toBe('UPPER')
    expect(await contentOf(NOTE)).toBe('lower')
  })

  // A non-canonical id that sync delivered can carry anything after its hex prefix.
  it('neutralizes candidate ids it lists in an ambiguity error', async () => {
    await seed([{id: 'abcdef12-ok'}, {id: 'abcdef12-x\nfake line\u2028'}])
    const error = await resolveBlockId(repo, 'abcdef12', 'test').catch((e: unknown) => e as Error) as Error
    expect(error.message).toMatch(/ambiguous/)
    expect(error.message).not.toMatch(/fake line\n|\u2028/)
  })

  it('neutralizes a stored alias it suggests in a not-found error', async () => {
    await repo.tx(async tx => {
      await tx.create({id: LONE, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Groceries'})
      await tx.setProperty(LONE, aliasesProp, ['Groceries\nfake line\u202E'])
    }, {scope: ChangeScope.BlockDefault})
    const error = await run({type: 'append-markdown', target: 'Grocer', markdown: '- x'})
      .catch((e: unknown) => e as Error) as Error
    expect(error.message).toMatch(/Groceries/)
    expect(error.message).not.toMatch(/fake line\n|\u202E/)
  })
})

describe('review round 4', () => {
  // Sync and restore admit non-canonical ids, including ones shaped like
  // reference syntax. Such a row must not capture a reference meant for the
  // real block or page; it stays reachable by wrapping its id in ((…)).
  it('keeps ^prefix and [[name]] meaning what they say next to a planted id that looks like them', async () => {
    await seed([{id: NOTE, content: 'real'}, {id: '^3f2a9c1b', content: 'planted'}, {id: '[[Inbox]]', content: 'planted'}])
    expect(await resolveBlockId(repo, '^3f2a9c1b', 'test')).toBe(NOTE)
    const appended = await run({type: 'append-markdown', format: 'json', target: '[[Inbox]]', markdown: '- x'}) as {
      target: {id: string, kind: string}
    }
    expect(appended.target).toMatchObject({id: computeAliasSeatId('Inbox', WS, 0), kind: 'page'})
  })

  it('keeps ((x)) and ^x meaning the id x when x is missing, beside a row literally named the wrapper', async () => {
    await seed([{id: '((ghost))', content: 'planted'}, {id: '^ghost', content: 'planted'}])
    for (const ref of ['((ghost))', '^ghost']) {
      expect(await resolveBlockId(repo, ref, 'test')).toBe('ghost')
      await expect(run({type: 'update-block', id: ref, content: 'hijacked'})).rejects.toThrow(/not found/)
    }
    expect(await contentOf('((ghost))')).toBe('planted')
    expect(await contentOf('^ghost')).toBe('planted')
  })

  it('reaches an odd stored id when it is wrapped in ((…))', async () => {
    await seed([{id: NOTE, content: 'real'}])
    for (const odd of ['^3f2a9c1b', `((${NOTE}))`, '[[Literal]]']) {
      await seed([{id: odd, content: 'odd'}])
      expect(await resolveBlockId(repo, `((${odd}))`, 'test')).toBe(odd)
      await run({type: 'edit-block', id: `((${odd}))`, old: 'odd', new: 'odd!'})
      expect(await contentOf(odd)).toBe('odd!')
    }
    expect(await contentOf(NOTE)).toBe('real')
  })
})

describe('review round 5', () => {
  // The rows a same-tx materialization writes for a property are storage for
  // the owner's property, which the owner's own change already names.
  it('leaves property field/value rows out of recent-changes', async () => {
    await seed([{id: 'defn', content: 'status'}, {id: NOTE, content: 'Owner'}])
    await sharedDb.db.execute(
      "INSERT OR IGNORE INTO block_types (block_id, workspace_id, type) VALUES ('defn', ?, 'property-schema')",
      [WS],
    )
    await repo.tx(async tx => {
      await tx.update(NOTE, {properties: {status: 'open'}})
      await tx.create({
        id: 'field', workspaceId: WS, parentId: NOTE, orderKey: 'a0',
        content: '::((defn))', referenceTargetId: 'defn',
      })
      await tx.create({id: 'value', workspaceId: WS, parentId: 'field', orderKey: 'a0', content: 'open'})
    }, agentTxOptions('update-block'))

    const out = await run({type: 'recent-changes'}) as {txs: Array<{changes: Array<{blockId: string}>}>}
    expect(out.txs[0].changes.map(change => change.blockId)).toEqual([NOTE])

    // A storage row changed with NO change to its owner's properties is not
    // covered by the owner's line, so it is shown rather than hidden.
    await repo.tx(async tx => {
      await tx.update('value', {content: 'done'})
    }, agentTxOptions('edit-block'))
    const after = await run({type: 'recent-changes'}) as {txs: Array<{changes: Array<{blockId: string}>}>}
    expect(after.txs[0].changes.map(change => change.blockId)).toEqual(['value'])
  })

  it('spends the listing cap on real changes before property storage', async () => {
    await seed([{id: 'defn', content: 'status'}, {id: NOTE, content: 'Owner'}])
    await sharedDb.db.execute(
      "INSERT OR IGNORE INTO block_types (block_id, workspace_id, type) VALUES ('defn', ?, 'property-schema')",
      [WS],
    )
    // Storage written first, the owner's change last: by write order alone
    // the storage rows would fill the cap and push the owner out.
    await repo.tx(async tx => {
      for (let i = 0; i <= MAX_LISTED_CHANGES; i++) {
        await tx.create({
          id: `field-${i}`, workspaceId: WS, parentId: NOTE, orderKey: `a${i}`,
          content: '::((defn))', referenceTargetId: 'defn',
        })
      }
      await tx.update(NOTE, {properties: {status: 'open'}})
    }, agentTxOptions('update-block'))

    const out = await run({type: 'recent-changes'}) as ChangesOut
    expect(out.txs[0].changes.map(change => change.blockId)).toEqual([NOTE])
    // Only storage was cut, but a cut is never reported as a complete list.
    expect(out.txs[0].incomplete).toBe(true)
  })
})

describe('review round 6', () => {
  it('attributes a daily note it creates, so recent-changes shows it', async () => {
    const created = await run({type: 'create-page', date: '2026-10-15'}) as {id: string, created: boolean}
    expect(created.created).toBe(true)
    const out = await run({type: 'recent-changes'}) as {
      txs: Array<{description: string, changes: Array<{blockId: string, kind: string}>}>
    }
    const changes = out.txs.filter(tx => tx.description === 'agent runtime create-page').flatMap(tx => tx.changes)
    expect(changes).toContainEqual(expect.objectContaining({blockId: created.id, kind: 'create'}))
  })
})

describe('review round 7', () => {
  // `exactIds` says the id fields are already stored ids — km-mcp resolves
  // before its write guard and must not have the write read them as refs again.
  it('acts on exactIds values as stored ids, never re-reading them as refs', async () => {
    await seed([
      {id: NOTE, content: 'real'},
      {id: '^3f2a9c1b', content: 'odd'},
      {id: LONE, content: 'parent'},
      {id: 'kid', parentId: LONE, content: 'kid'},
    ])
    await run({type: 'update-block', id: '^3f2a9c1b', content: 'odd 2', exactIds: true})
    await run({type: 'edit-block', id: '^3f2a9c1b', old: '2', new: '3', exactIds: true})
    expect(await contentOf('^3f2a9c1b')).toBe('odd 3')
    await run({type: 'move-block', id: '^3f2a9c1b', parentId: LONE, position: {kind: 'after', siblingId: 'kid'}, exactIds: true})
    expect((await liveChildren(LONE)).map(row => row.id)).toEqual(['kid', '^3f2a9c1b'])
    await run({type: 'append-markdown', target: LONE, markdown: '- x', position: {kind: 'before', siblingId: '^3f2a9c1b'}, exactIds: true})
    expect((await liveChildren(LONE)).map(row => row.content)).toEqual(['kid', 'x', 'odd 3'])
    await run({type: 'delete-block', id: '^3f2a9c1b', exactIds: true})
    await run({type: 'restore-block', id: '^3f2a9c1b', exactIds: true})
    expect(await contentOf(NOTE)).toBe('real')
  })

  // Read as refs, '^7d41e0aa' would name LONE and '^3f2a9c1b' NOTE.
  it('moves under an exactIds parent and after an exactIds sibling', async () => {
    await seed([
      {id: NOTE}, {id: LONE},
      {id: '^7d41e0aa', content: 'odd parent'},
      {id: '^3f2a9c1b', parentId: '^7d41e0aa', content: 'odd sibling'},
      {id: 'mover', content: 'mover'},
    ])
    await run({
      type: 'move-block', id: 'mover', parentId: '^7d41e0aa',
      position: {kind: 'after', siblingId: '^3f2a9c1b'}, exactIds: true,
    })
    expect((await liveChildren('^7d41e0aa')).map(row => row.id)).toEqual(['^3f2a9c1b', 'mover'])
  })

  it('names a stored id with surrounding whitespace exactly; a ref is trimmed', async () => {
    await seed([{id: ' victim ', content: 'spaced'}, {id: 'victim', content: 'plain'}])
    await run({type: 'update-block', id: ' victim ', content: 'spaced!', exactIds: true})
    expect(await contentOf(' victim ')).toBe('spaced!')
    expect(await contentOf('victim')).toBe('plain')
  })
})

describe('review round 8', () => {
  /** Reads of `parentId`'s children inside the txs `run` opens. */
  const countChildReads = async (parentId: string, action: () => Promise<unknown>): Promise<number> => {
    const original = repo.tx.bind(repo)
    let reads = 0
    const spy = vi.spyOn(repo, 'tx').mockImplementation(((fn, opts) => original(async tx => {
      const childrenOf = tx.childrenOf.bind(tx)
      tx.childrenOf = ((id, ...rest) => {
        if (id === parentId) reads += 1
        return childrenOf(id, ...rest)
      }) as typeof tx.childrenOf
      return fn(tx)
    }, opts)) as Repo['tx'])
    try {
      await action()
    } finally {
      spy.mockRestore()
    }
    return reads
  }

  it('reports one net change per block per transaction', async () => {
    // Page creation mints the seat, then sets its alias and type in the same tx.
    const created = await run({type: 'create-page', name: 'Net change'}) as {id: string}
    const out = await run({type: 'recent-changes'}) as {
      txs: Array<{description: string, changes: Array<{blockId: string, kind: string, changed: string[]}>}>
    }
    const pageChanges = out.txs.flatMap(tx => tx.changes).filter(change => change.blockId === created.id)
    expect(pageChanges).toHaveLength(1)
    expect(pageChanges[0]).toMatchObject({kind: 'create'})
    expect(pageChanges[0].changed).toContain('properties')
  })

  it('names the references a create carried', async () => {
    await seed([{id: NOTE}, {id: LONE}])
    await run({type: 'create-block', parentId: NOTE, data: {content: 'see', references: [{id: LONE, alias: LONE}]}})
    const out = await run({type: 'recent-changes'}) as {txs: Array<{changes: Array<{kind: string, changed: string[]}>}>}
    const create = out.txs.flatMap(tx => tx.changes).find(change => change.kind === 'create')!
    expect(create.changed).toContain('references')
  })

  it('reads the target\'s children a fixed number of times, however many roots it appends', async () => {
    await seed([{id: NOTE}])
    const bullets = (n: number) => Array.from({length: n}, (_, i) => `- item ${i}`).join('\n')
    const few = await countChildReads(NOTE, () => run({type: 'append-markdown', target: NOTE, markdown: bullets(2)}))
    const many = await countChildReads(NOTE, () => run({type: 'append-markdown', target: NOTE, markdown: bullets(20)}))
    expect(many).toBe(few)
    expect((await liveChildren(NOTE))).toHaveLength(22)
  })
})
