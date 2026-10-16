// @vitest-environment happy-dom
//
// The agent views (`view-*` commands) and the block-ref resolver, end-to-end
// against a real Repo. Same minimal runtime as dataCommands.test.ts: kernel +
// the backlinks / grouped-backlinks data extensions, with references written
// by hand (the trigger-maintained indexes project them on insert).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { searchSourcesFacet } from '@/data/facets'
import { hasLoneSurrogate } from '@/utils/string'
import { createAgentRuntimeContext, executeCommand } from '../commands'
import type { AgentRuntimeContext } from '../protocol'
import { resolveBlockRef, shortIds } from '../agentViews/resolveRef'
import type { OutlineView } from '../agentViews/outline'
import type { BlockView } from '../agentViews/block'
import type { BacklinksView, GroupedBacklinksView } from '../agentViews/backlinks'
import type { SearchView } from '../agentViews/search'

const WS = 'ws-1'
const USER = {id: 'user-1', name: 'Alice'}

/** A canonical-looking id whose first 8 hex chars are `prefix`. */
const uuid = (prefix: string, n: number): string =>
  `${prefix.padEnd(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

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

let orderCounter = 0
const create = async (args: {
  id: string
  content?: string
  parentId?: string | null
  references?: BlockReference[]
  properties?: BlockProperties
}) => {
  orderCounter += 1
  await repo.tx(async tx => {
    await tx.create({
      id: args.id,
      workspaceId: WS,
      parentId: args.parentId ?? null,
      orderKey: `k${orderCounter.toString().padStart(6, '0')}`,
      content: args.content ?? args.id,
      references: args.references ?? [],
      ...(args.properties ? {properties: args.properties} : {}),
    })
  }, {scope: ChangeScope.BlockDefault})
}

const view = async <T,>(command: Record<string, unknown>): Promise<T> =>
  await executeCommand({commandId: 'v', ...command} as never, context) as T

describe('resolveBlockRef', () => {
  const PAGE = uuid('a1b2c3d4', 1)

  beforeEach(async () => {
    await create({id: PAGE, content: 'Project Alpha', properties: {alias: ['Project Alpha']}})
  })

  it('accepts a full id, a unique prefix (bare, ^ or (( )) ), and a page name', async () => {
    const opts = {workspaceId: WS}
    expect(await resolveBlockRef(repo, PAGE, opts)).toEqual({id: PAGE, via: 'id'})
    expect(await resolveBlockRef(repo, 'a1b2c3', opts)).toEqual({id: PAGE, via: 'prefix'})
    expect(await resolveBlockRef(repo, '^A1B2C3D4', opts)).toEqual({id: PAGE, via: 'prefix'})
    expect(await resolveBlockRef(repo, '((a1b2c3d4-00))', opts)).toEqual({id: PAGE, via: 'prefix'})
    expect(await resolveBlockRef(repo, 'Project Alpha', opts)).toEqual({id: PAGE, via: 'alias'})
    expect(await resolveBlockRef(repo, '[[Project Alpha]]', opts)).toEqual({id: PAGE, via: 'alias'})
  })

  it('names a daily note by date, whether or not it exists yet', async () => {
    expect(await resolveBlockRef(repo, '2026-06-18', {workspaceId: WS}))
      .toEqual({id: dailyNoteBlockId(WS, '2026-06-18'), via: 'date'})
  })

  it('refuses an ambiguous prefix and lists the candidates', async () => {
    const twin = uuid('a1b2c3d4', 2)
    await create({id: twin, content: 'Twin'})
    await expect(resolveBlockRef(repo, 'a1b2c3d4', {workspaceId: WS}))
      .rejects.toThrow(new RegExp(`ambiguous[\\s\\S]*${PAGE}[\\s\\S]*${twin}`))
  })

  it('prefers a live block over a deleted one sharing the prefix', async () => {
    const deleted = uuid('a1b2c3d4', 3)
    await create({id: deleted, content: 'Gone'})
    await executeCommand({commandId: 'd', type: 'delete-block', id: deleted}, context)
    expect(await resolveBlockRef(repo, 'a1b2c3d4', {workspaceId: WS})).toEqual({id: PAGE, via: 'prefix'})
  })

  it('a too-short prefix is not treated as one', async () => {
    await expect(resolveBlockRef(repo, 'a1b2', {workspaceId: WS})).rejects.toThrow(/No block matches/)
  })

  it('keeps user text in its errors on one line, without bidi controls', async () => {
    await create({id: uuid('a1b2c3d4', 4), content: 'Twin\n\u202Eforged'})
    const ambiguous = await resolveBlockRef(repo, 'a1b2c3d4', {workspaceId: WS}).then(() => '', (error: Error) => error.message)
    expect(ambiguous).toContain('Twin ⏎ forged')
    expect(ambiguous).not.toMatch(/\p{Bidi_Control}/u)
    // A synced id is not guaranteed canonical either.
    await create({id: 'a1b2c3d4-x\nfake line \u202E', content: 'odd id'})
    const oddId = await resolveBlockRef(repo, 'a1b2c3d4', {workspaceId: WS}).then(() => '', (error: Error) => error.message)
    expect(oddId).toContain('a1b2c3d4-x ⏎ fake line')
    expect(oddId).not.toMatch(/fake line \u202E|\nfake/u)
    await create({id: uuid('a1b2c3d5', 5), content: 'x', properties: {alias: ['Project\nAlpha two']}})
    const missing = await resolveBlockRef(repo, 'Project', {workspaceId: WS}).then(() => '', (error: Error) => error.message)
    expect(missing).toContain('  Project ⏎ Alpha two')
  })

  it('clips a long alias in its suggestions', async () => {
    await create({id: uuid('a1b2c3d6', 6), content: 'x', properties: {alias: [`Projection ${'z'.repeat(300)}`]}})
    const message = await resolveBlockRef(repo, 'Projection', {workspaceId: WS}).then(() => '', (error: Error) => error.message)
    expect(message).toContain('Projection zzz')
    expect(message).not.toContain('z'.repeat(100))
  })

  it('suggests similar page names when nothing matches', async () => {
    await expect(resolveBlockRef(repo, 'Project', {workspaceId: WS}))
      .rejects.toThrow(/Pages with similar names:\n {2}Project Alpha/)
  })

  it("gives a deleted block a prefix only when that prefix resolves back to it", async () => {
    const live = 'cafe0001-1111-4000-8000-000000000001'
    const deletedTwin = 'cafe0001-2222-4000-8000-000000000002'
    const deletedA = 'cafe0002-1111-4000-8000-000000000003'
    const deletedB = 'cafe0002-2222-4000-8000-000000000004'
    for (const id of [live, deletedTwin, deletedA, deletedB]) await create({id})
    for (const id of [deletedTwin, deletedA, deletedB]) {
      await executeCommand({commandId: 'd', type: 'delete-block', id}, context)
    }
    const short = await shortIds(repo, [live, deletedTwin, deletedA, deletedB])
    // `cafe0001` resolves to the live block, so its deleted twin needs more characters.
    expect(short.get(live)).toBe('cafe0001')
    expect(short.get(deletedTwin)).toBe('cafe0001-222')
    // Two deleted blocks sharing a prefix tell each other apart the same way.
    expect(short.get(deletedA)).toBe('cafe0002-111')
    for (const id of [live, deletedTwin, deletedA, deletedB]) {
      expect((await resolveBlockRef(repo, short.get(id)!, {workspaceId: WS})).id).toBe(id)
    }
  })

  it('keeps a non-canonical UUID exactly as given, and never shortens one', async () => {
    const mixedCase = 'ABCDEF12-0000-4000-8000-000000000001'
    expect(await resolveBlockRef(repo, mixedCase, {workspaceId: WS})).toEqual({id: mixedCase, via: 'id'})
    expect((await shortIds(repo, [mixedCase])).get(mixedCase)).toBe(mixedCase)
  })

  it("accept:'id' refuses names, and onMissing:'verbatim' hands the ref back", async () => {
    await expect(resolveBlockRef(repo, 'Project Alpha', {workspaceId: WS, accept: 'id'}))
      .rejects.toThrow(/takes an id/)
    expect(await resolveBlockRef(repo, 'nothing-here', {workspaceId: WS, onMissing: 'verbatim'}))
      .toEqual({id: 'nothing-here', via: 'verbatim'})
  })
})

describe('shortIds', () => {
  it('uses 8 characters, more where 8 would be ambiguous (up to the whole id), and leaves non-hex ids whole', async () => {
    const a = 'feedbeef-1111-4000-8000-000000000001'
    const b = 'feedbeef-2222-4000-8000-000000000002'
    const c = uuid('0badcafe', 3)
    const d = 'feedbeef-2222-4000-8000-000000000004'
    for (const id of [a, b, c, d]) await create({id})
    await create({id: 'plain-id'})

    const short = await shortIds(repo, [a, b, c, d, 'plain-id'])
    expect(short.get(c)).toBe('0badcafe')
    expect(short.get(a)).toBe('feedbeef-111')
    expect(short.get(b)).toBe(b)
    expect(short.get('plain-id')).toBe('plain-id')
    // Every short id resolves back to its block.
    for (const id of [a, b, c, d]) {
      expect((await resolveBlockRef(repo, short.get(id)!, {workspaceId: WS})).id).toBe(id)
    }
  })
})

describe('view-outline', () => {
  const ROOT = uuid('00000001', 1)

  it('renders markdown lines, hides UI-hidden properties, summarizes structured values', async () => {
    const other = uuid('00000002', 2)
    await create({id: other, content: 'Other page', properties: {alias: ['Other page']}})
    await create({id: ROOT, content: 'Root page', properties: {alias: ['Root page']}})
    await create({
      id: uuid('00000003', 3),
      parentId: ROOT,
      content: 'First child\nsecond line',
      properties: {
        'groupWith': [other],
        'system:collapsed': false,
        'snapshot-history': [{at: 1, grade: 3}, {at: 2, grade: 4}],
      },
    })

    const text = await view<string>({type: 'view-outline', ref: 'Root page'})
    const lines = text.split('\n')
    expect(lines[0]).toBe('Root page  ^00000001  · 1 child')
    expect(lines[1]).toBe('- First child ⏎ second line  groupWith:: [[Other page]]  snapshot-history:: [2 items]  ^00000003')
    expect(text).not.toContain('system:collapsed')
  })

  it('stops at depth, marking unexpanded and collapsed children', async () => {
    await create({id: ROOT, content: 'Root'})
    const a = uuid('0000000a', 1)
    const collapsed = uuid('0000000c', 2)
    await create({id: a, parentId: ROOT, content: 'A'})
    await create({id: uuid('000000a1', 3), parentId: a, content: 'A1'})
    await create({id: uuid('000000a2', 4), parentId: uuid('000000a1', 3), content: 'A1x'})
    await create({id: collapsed, parentId: ROOT, content: 'Folded', properties: {'system:collapsed': true}})
    await create({id: uuid('000000c1', 5), parentId: collapsed, content: 'Hidden under fold'})

    const text = await view<string>({type: 'view-outline', ref: ROOT, depth: 2})
    expect(text).toContain('  - A1  ^000000a1  (+1 child)')
    expect(text).toContain('- Folded  ^0000000c  (+1 child, collapsed)')
    expect(text).not.toContain('Hidden under fold')
    expect(text).toContain('(+N children) = not expanded')

    const expanded = await view<string>({type: 'view-outline', ref: ROOT, depth: 2, expandCollapsed: true})
    expect(expanded).toContain('  - Hidden under fold  ^000000c1')
  })

  it('fills shallower levels first and pages the root children by offset', async () => {
    await create({id: ROOT, content: 'Root'})
    const children: string[] = []
    for (let i = 0; i < 5; i++) {
      const id = uuid(`1000000${i}`, i)
      children.push(id)
      await create({id, parentId: ROOT, content: `child ${i}`})
      await create({id: uuid(`2000000${i}`, i), parentId: id, content: `grandchild ${i}`})
    }

    const first = await view<OutlineView>({type: 'view-outline', ref: ROOT, limit: 3, format: 'json'})
    expect(first.rows.map(row => row.content)).toEqual(['child 0', 'child 1', 'child 2'])
    expect(first.rows.every(row => row.hiddenChildren === 1)).toBe(true)
    expect(first.nextOffset).toBe(3)

    const text = await view<string>({type: 'view-outline', ref: ROOT, limit: 3})
    expect(text).toContain('… 2 more children of the root not shown — continue with offset=3')

    const second = await view<OutlineView>({type: 'view-outline', ref: ROOT, limit: 6, offset: 3, format: 'json'})
    expect(second.rows.map(row => row.content)).toEqual(['child 3', 'grandchild 3', 'child 4', 'grandchild 4'])
    expect(second.nextOffset).toBeNull()
  })

  it('cuts long content with a char count and a pointer to the full read', async () => {
    await create({id: ROOT, content: 'Root'})
    await create({id: uuid('00000004', 4), parentId: ROOT, content: 'x'.repeat(450)})
    const text = await view<string>({type: 'view-outline', ref: ROOT})
    expect(text).toContain(`- ${'x'.repeat(200)}…[+250 chars]  ^00000004`)
    expect(text).toContain('get_block on that id reads the rest')
  })

  it("refuses a block in another workspace: it would decode with this workspace's registries", async () => {
    const foreign = uuid('0f0f0f0f', 1)
    await repo.tx(async tx => {
      await tx.create({id: foreign, workspaceId: 'ws-2', parentId: null, orderKey: 'a0', content: 'elsewhere', references: []})
    }, {scope: ChangeScope.BlockDefault})
    await expect(view({type: 'view-block', ref: foreign})).rejects.toThrow(/not the active one.*--raw/s)
  })

  it('says a dated daily note that does not exist yet has not been created', async () => {
    await expect(view({type: 'view-outline', ref: '2026-06-18'})).rejects.toThrow(/has not been created yet/)
  })
})

describe('view-block', () => {
  it('pages through long content and lists what the UI hides', async () => {
    const id = uuid('0000b10c', 1)
    await create({id, content: 'abcdefghij'.repeat(10), properties: {'system:collapsed': true, alias: ['Long']}})
    await create({id: uuid('0000b10d', 2), content: 'links', references: [{id, alias: 'Long'}]})

    const first = await view<BlockView>({type: 'view-block', ref: id, maxChars: 30, format: 'json'})
    expect(first.content).toBe('abcdefghij'.repeat(3))
    expect(first.nextContentOffset).toBe(30)
    expect(first.backlinkCount).toBe(1)
    expect(first.hiddenProperties).toEqual(['system:collapsed'])

    const rest = await view<BlockView>({type: 'view-block', ref: 'Long', contentOffset: 90, format: 'json'})
    expect(rest.content).toBe('abcdefghij')
    expect(rest.nextContentOffset).toBeNull()

    const emoji = uuid('0000b10e', 3)
    await create({id: emoji, content: 'ab\u{1F600}cd'})
    const page = (contentOffset: number, maxChars: number) =>
      view<BlockView>({type: 'view-block', ref: emoji, contentOffset, maxChars, format: 'json'})
    // A boundary inside the pair moves back; a page too short for the pair takes both halves.
    expect(await page(0, 3)).toMatchObject({content: 'ab', nextContentOffset: 2})
    expect(await page(2, 1)).toMatchObject({content: '\u{1F600}', nextContentOffset: 4})
    // An offset given inside the pair starts at the pair.
    expect(await page(3, 2)).toMatchObject({content: '\u{1F600}', contentOffset: 2})

    const text = await view<string>({type: 'view-block', ref: id, maxChars: 30})
    expect(text).toContain('…[+70 chars — continue with contentOffset=30]')
    expect(text).toContain('(hidden in the UI: system:collapsed)')
  })
})

describe('display safety', () => {
  it('no field of a text view can carry a line break or a bidi control', async () => {
    const parent = uuid('5afe0000', 1)
    const child = uuid('5afe0001', 2)
    await create({id: parent, content: 'Par\u202Eent', properties: {alias: ['Par\u202Eent']}})
    await create({id: child, parentId: parent, content: 'one\ntwo\u2028three', properties: {note: 'x\u2066y'}})

    const outline = await view<string>({type: 'view-outline', ref: child})
    const block = await view<string>({type: 'view-block', ref: child})
    for (const text of [outline, block]) {
      expect(text).not.toMatch(/[\u2028\u2029\p{Bidi_Control}]/u)
    }
    expect(outline).toContain('in: Par ⏎ ent')
    // The block view keeps the content's own line breaks and nothing else.
    expect(block).toContain('one\ntwo ⏎ three')
  })
})

describe('view-block bounds', () => {
  it('caps the property lists and names, counting what it left out', async () => {
    const id = uuid('0000b10f', 1)
    // The long name goes first, so it is inside the capped list.
    const properties: Record<string, unknown> = {[`long-${'n'.repeat(200)}`]: 'x'}
    for (let i = 0; i < 60; i++) properties[`imported-${String(i).padStart(2, '0')}`] = `v${i}`
    for (let i = 0; i < 25; i++) properties[`system:internal-${i}`] = i
    await create({id, content: 'bag', properties})

    const out = await view<BlockView>({type: 'view-block', ref: id, format: 'json'})
    expect(out.properties).toHaveLength(50)
    expect(out.omittedProperties).toBe(11)
    expect(out.hiddenProperties).toHaveLength(21)
    expect(out.hiddenProperties.at(-1)).toBe('+5 more')
    const text = await view<string>({type: 'view-block', ref: id})
    expect(text).toContain(`WHERE blocks.id = ? with params ["${id}"])`)
    expect(text).toMatch(/hidden in the UI: .*, \+5 more\)/)
    expect(text).not.toContain('n'.repeat(100))
  })

  it('bounds every per-row list of names: an outline root, type labels, a backlink\'s via-properties', async () => {
    const root = uuid('0000b110', 1)
    const rootProps: Record<string, unknown> = {
      types: Array.from({length: 15}, (_, i) => `kind-${i}`),
      summary: 'v'.repeat(200),
    }
    for (let i = 0; i < 59; i++) rootProps[`field-${i}`] = i
    await create({id: root, content: 'root', properties: rootProps})

    const outline = await view<OutlineView>({type: 'view-outline', ref: root, properties: 'full', format: 'json'})
    expect(outline.root.properties).toHaveLength(50)
    expect(outline.root.omittedProperties).toBe(10)
    expect(outline.root.types).toHaveLength(11)
    expect(outline.root.types.at(-1)).toBe('+5 more')
    // The default brief root shows three plain names, values clipped like
    // any brief line, and counts the rest.
    const header = (await view<string>({type: 'view-outline', ref: root})).split('\n')[0]
    expect(header).toContain(`summary:: ${'v'.repeat(40)}…[+160 chars]  field-0:: 0  field-1:: 1  +57 props`)

    const source = uuid('0000b111', 2)
    await create({
      id: source,
      content: 'linked many ways',
      references: Array.from({length: 7}, (_, i) => ({id: root, alias: 'root', sourceField: `rel-${i}`})),
    })
    const backlinks = await view<BacklinksView>({type: 'view-backlinks', ref: root, format: 'json'})
    expect(backlinks.rows[0].viaProperties).toEqual(['rel-0', 'rel-1', 'rel-2', 'rel-3', 'rel-4', '+2 more'])
  })
})

describe('structural edge cases', () => {
  it('an outline survives a parent cycle', async () => {
    const root = uuid('c1c1c1c1', 1)
    const child = uuid('c2c2c2c2', 2)
    await create({id: root, content: 'Root'})
    await create({id: child, parentId: root, content: 'Child'})
    // Sync applies parent ids verbatim, so a cycle can arrive from outside.
    await sharedDb.db.execute('UPDATE blocks SET parent_id = ? WHERE id = ?', [child, root])

    const out = await view<OutlineView>({type: 'view-outline', ref: root, depth: 5, format: 'json'})
    expect(out.rows.map(row => [row.content, row.depth])).toEqual([['Child', 1]])
    expect(out.nextOffset).toBeNull()
  })

  it('a grouping block with a non-UUID id is still addressable', async () => {
    const target = uuid('9e9e9e9e', 1)
    await create({id: target, content: 'Target'})
    await create({id: 'topic-page', content: 'Topic B'})
    // A group needs two members to form.
    for (let i = 0; i < 2; i++) {
      await create({id: uuid('9f9f9f9f', i), content: `src ${i}`, references: [{id: target, alias: 'T'}, {id: 'topic-page', alias: 'B'}]})
    }
    const out = await view<GroupedBacklinksView>({type: 'view-grouped-backlinks', ref: target, format: 'json'})
    const group = out.groups.find(candidate => candidate.label === 'Topic B')!
    expect(group).toMatchObject({groupId: 'topic-page', shortId: 'topic-page'})
  })

  it('search never fetches past its window cap, whatever the offset', async () => {
    await create({id: uuid('5e5e5e5e', 1), content: 'capped query'})
    const limits: number[] = []
    repo.setRuntimeContributions(searchSourcesFacet, 'test:spy', [{
      id: 'test.spy',
      search: async (_repo, args) => {
        limits.push(args.limit)
        return []
      },
    }])
    const out = await view<SearchView>({type: 'view-search', query: 'capped', offset: 1_000_000_000, format: 'json'})
    expect(Math.max(...limits)).toBeLessThanOrEqual(2000)
    expect(out.hits).toEqual([])
  })

  it('a self-parented root is not its own child, so paging ends', async () => {
    const root = uuid('5b5b5b5b', 1)
    await create({id: root, content: 'Self'})
    await create({id: uuid('5b5b5b5c', 2), parentId: root, content: 'Kid'})
    await sharedDb.db.execute('UPDATE blocks SET parent_id = ? WHERE id = ?', [root, root])
    const out = await view<OutlineView>({type: 'view-outline', ref: root, format: 'json'})
    expect(out.root.childCount).toBe(1)
    expect(out.rows.map(row => row.content)).toEqual(['Kid'])
    expect(out.nextOffset).toBeNull()
    // A one-block page must not be spent on the root itself.
    const paged = await view<OutlineView>({type: 'view-outline', ref: root, limit: 1, format: 'json'})
    expect(paged.rows.map(row => row.content)).toEqual(['Kid'])
    expect(paged.nextOffset).toBeNull()
  })

  it('a search stopped by the window cap says so, even when folding left the page empty', async () => {
    const dup = (i: number) => ({
      id: `dup-${i}`, workspaceId: WS, parentId: null, orderKey: `d${i}`, content: 'same text',
      properties: {}, references: [], createdAt: 1, updatedAt: 1, userUpdatedAt: 1,
      createdBy: USER.id, updatedBy: USER.id, deleted: false,
    })
    repo.setRuntimeContributions(searchSourcesFacet, 'test:dups', [{
      id: 'test.dups',
      search: async (_repo, args) => Array.from({length: args.limit}, (_, i) => ({block: dup(i) as never, score: 1000})),
    }])
    const out = await view<SearchView>({type: 'view-search', query: 'same', offset: 1, format: 'json'})
    expect(out.hits).toEqual([])
    expect(out.windowCap).toBe(2000)
  })

  it('search refuses an `under` block from another workspace', async () => {
    const foreign = uuid('5e5e5e5f', 1)
    await repo.tx(async tx => {
      await tx.create({id: foreign, workspaceId: 'ws-2', parentId: null, orderKey: 'a0', content: 'elsewhere', references: []})
    }, {scope: ChangeScope.BlockDefault})
    await expect(view({type: 'view-search', query: 'anything', under: foreign})).rejects.toThrow(/not the active one/)
  })

  it('search under a self-parented root never returns the root', async () => {
    const root = uuid('5c5c5c5c', 1)
    await create({id: root, content: 'loop topic'})
    await create({id: uuid('5c5c5c5d', 2), parentId: root, content: 'loop topic child'})
    await sharedDb.db.execute('UPDATE blocks SET parent_id = ? WHERE id = ?', [root, root])
    const out = await view<SearchView>({type: 'view-search', query: 'loop topic', under: root, format: 'json'})
    expect(out.hits.map(hit => hit.id)).toEqual([uuid('5c5c5c5d', 2)])
  })

  it('titles at most 20 refs of a refList, counting the rest', async () => {
    const targets = Array.from({length: 25}, (_, i) => uuid(`7e7e7e${String(i).padStart(2, '0')}`, i))
    for (const [i, target] of targets.entries()) await create({id: target, content: `r${i}`})
    const holder = uuid('7f7f7f7f', 1)
    await create({id: holder, content: 'holder', properties: {groupWith: targets}})
    const out = await view<BlockView>({type: 'view-block', ref: holder, format: 'json'})
    const value = out.properties.find(property => property.name === 'groupWith')!.value
    expect(value).toMatch(/^\[\[r0\]\], .*\[\[r19\]\], …\+5 more$/)
  })

  it('formats a huge list value only as far as its line, counting the rest', async () => {
    const id = uuid('5f5f5f5f', 1)
    await create({id, content: 'list holder', properties: {numbers: Array.from({length: 100_000}, (_, i) => i)}})
    const out = await view<OutlineView>({type: 'view-outline', ref: id, format: 'json'})
    const value = out.root.properties.find(property => property.name === 'numbers')!.value
    expect(value.length).toBeLessThanOrEqual(40)
    expect(value).toMatch(/^0, 1, .*, …\+\d+ more$/)
  })

  it('sql caps maxRows at its ceiling, whatever the caller asks', async () => {
    const getAll = vi.spyOn(repo.db, 'getAll')
    await executeCommand({commandId: 's', type: 'sql', mode: 'all', maxRows: 5_000_000, sql: 'SELECT 1 AS one'}, context)
    const executed = getAll.mock.calls.map(call => call[0]).find(sql => sql.includes('SELECT 1 AS one'))
    expect(executed).toMatch(/\) LIMIT 1001$/)
    getAll.mockRestore()
  })

  it('a line whose text starts with a long blank run still shows its text', async () => {
    const id = uuid('4a4a4a4a', 1)
    await create({id, content: `${' '.repeat(600)}${'\u0007'.repeat(10)}the real text`})
    const line = (await view<string>({type: 'view-outline', ref: id})).split('\n')[0]
    expect(line).toContain('the real text')
  })

  it('a list whose first item overflows still shows how many follow', async () => {
    const id = uuid('4b4b4b4b', 1)
    await create({id, content: 'holder', properties: {notes: ['w'.repeat(5000), 'second', 'third']}})
    const out = await view<OutlineView>({type: 'view-outline', ref: id, format: 'json'})
    const value = out.root.properties.find(property => property.name === 'notes')!.value
    expect(value).toMatch(/^w+…, …\+2 more$/)
    expect(value.length).toBeLessThanOrEqual(40)
  })

  it("titles a ref only inside the referencing block's workspace", async () => {
    const foreign = uuid('4c4c4c4c', 1)
    await repo.tx(async tx => {
      await tx.create({id: foreign, workspaceId: 'ws-2', parentId: null, orderKey: 'a0', content: 'Elsewhere', references: []})
    }, {scope: ChangeScope.BlockDefault})
    const holder = uuid('4c4c4c4d', 2)
    await create({id: holder, content: 'holder', properties: {groupWith: [foreign]}})
    const out = await view<BlockView>({type: 'view-block', ref: holder, format: 'json'})
    expect(out.properties.find(property => property.name === 'groupWith')?.value).toBe(`((${foreign}))`)
  })

  it('a deleted daily note says it is deleted, not that it was never created', async () => {
    const id = dailyNoteBlockId(WS, '2026-03-01')
    await create({id, content: 'March 1st, 2026'})
    await executeCommand({commandId: 'd', type: 'delete-block', id}, context)
    await expect(view({type: 'view-outline', ref: '2026-03-01'})).rejects.toThrow(/is deleted; restore-block/)
  })

  it("a child in another workspace is not shown or counted, and search under a root does not cross into one", async () => {
    const root = uuid('6a6a6a6a', 1)
    const foreign = uuid('6b6b6b6b', 2)
    const beyond = uuid('6c6c6c6c', 3)
    await create({id: root, content: 'Root here'})
    await repo.tx(async tx => {
      await tx.create({id: foreign, workspaceId: 'ws-2', parentId: null, orderKey: 'a0', content: 'crossing', references: []})
    }, {scope: ChangeScope.BlockDefault})
    await create({id: beyond, content: 'crossing again'})
    // Sync applies parent ids verbatim, so these edges can arrive.
    await sharedDb.db.execute('UPDATE blocks SET parent_id = ? WHERE id = ?', [root, foreign])
    await sharedDb.db.execute('UPDATE blocks SET parent_id = ? WHERE id = ?', [foreign, beyond])

    const outline = await view<OutlineView>({type: 'view-outline', ref: root, format: 'json'})
    expect(outline.root.childCount).toBe(0)
    expect(outline.rows).toEqual([])
    const out = await view<SearchView>({type: 'view-search', query: 'crossing', under: root, format: 'json'})
    expect(out.hits).toEqual([])

    // The crossing one level down is caught at the recursive step, not the seed.
    const mid = uuid('6e6e6e6e', 4)
    await create({id: mid, parentId: root, content: 'Middle'})
    await sharedDb.db.execute('UPDATE blocks SET parent_id = ? WHERE id = ?', [mid, foreign])
    const deeper = await view<SearchView>({type: 'view-search', query: 'crossing', under: root, format: 'json'})
    expect(deeper.hits).toEqual([])
  })

  it('summarizes a structured value from its first keys, each clipped', async () => {
    const id = uuid('6d6d6d6d', 1)
    await create({id, content: 'holder', properties: {payload: {[`k${'x'.repeat(300)}`]: 1, b: 2, c: 3, d: 4}}})
    const out = await view<BlockView>({type: 'view-block', ref: id, format: 'json'})
    const value = out.properties.find(property => property.name === 'payload')!.value
    expect(value).toMatch(/^\{kx+…, b, c, …\}$/)
    expect(value.length).toBeLessThanOrEqual(300)
  })

  it('neutralizes an id it echoes in an error', async () => {
    const hostile = 'deadbeef-\nforged\u202E'
    await create({id: hostile, content: 'odd'})
    await executeCommand({commandId: 'd', type: 'delete-block', id: hostile}, context)
    const message = await view({type: 'view-outline', ref: hostile}).then(() => '', (error: Error) => error.message)
    expect(message).toContain('is deleted')
    expect(message).not.toMatch(/[\n\u202E]/u)
  })

  it("a link-only backlink does not quote a parent from another workspace", async () => {
    const target = uuid('7a0a0a0a', 1)
    const source = uuid('7b0b0b0b', 2)
    const foreignParent = uuid('7c0c0c0c', 3)
    await create({id: target, content: 'Target'})
    await repo.tx(async tx => {
      await tx.create({id: foreignParent, workspaceId: 'ws-2', parentId: null, orderKey: 'a0', content: 'private elsewhere', references: []})
    }, {scope: ChangeScope.BlockDefault})
    await create({id: source, content: '[[Target]]', references: [{id: target, alias: 'Target'}]})
    await sharedDb.db.execute('UPDATE blocks SET parent_id = ? WHERE id = ?', [foreignParent, source])
    const out = await view<BacklinksView>({type: 'view-backlinks', ref: target, format: 'json'})
    expect(out.rows[0]).not.toHaveProperty('parentContent')
  })

  it('page caps its candidates, whatever limit is asked for', async () => {
    await repo.tx(async tx => {
      for (let i = 0; i < 105; i++) {
        const name = `Candidate ${String(i).padStart(3, '0')}`
        await tx.create({id: uuid('7d0d0d0d', i), workspaceId: WS, parentId: null, orderKey: `c${i}`, content: name, properties: {alias: [name]}, references: []})
      }
    }, {scope: ChangeScope.BlockDefault})
    const out = await executeCommand({commandId: 'p', type: 'page', name: 'Candidate', limit: 100_000}, context) as {candidates: unknown[]}
    expect(out.candidates).toHaveLength(100)
  })

  it('empty values never spend a slot under the property cap', async () => {
    const id = uuid('8a8a8a8a', 1)
    const properties: Record<string, unknown> = {}
    for (let i = 0; i < 60; i++) properties[`optional-${i}`] = null
    properties.status = 'done'
    await create({id, content: 'sparse', properties})
    const out = await view<BlockView>({type: 'view-block', ref: id, format: 'json'})
    expect(out.properties).toEqual([{name: 'status', value: 'done'}])
    expect(out.omittedProperties).toBe(0)
  })

  it('reads a long list only as far as its line: refs, scalars, and a list of records', async () => {
    const targets = Array.from({length: 3}, (_, i) => uuid(`8b8b8b8${i}`, i))
    for (const [i, target] of targets.entries()) await create({id: target, content: `t${i}`})
    const id = uuid('8c8c8c8c', 1)
    await create({id, content: 'lists', properties: {
      groupWith: [...targets, ...Array.from({length: 200_000}, (_, i) => uuid('8d8d8d8d', i))],
      numbers: Array.from({length: 200_000}, (_, i) => i),
      history: [{at: 1}, ...Array.from({length: 200_000}, (_, i) => i)],
    }})
    const out = await view<BlockView>({type: 'view-block', ref: id, format: 'json'})
    const value = (name: string) => out.properties.find(property => property.name === name)!.value
    expect(value('groupWith')).toMatch(/^\[\[t0\]\], \[\[t1\]\], \[\[t2\]\], .*, …\+\d+ more$/)
    expect(value('numbers')).toMatch(/…\+\d+ more$/)
    expect(value('history')).toBe('[200001 items]')
  })

  it('omits an out-of-range edit time instead of failing the view', async () => {
    const id = uuid('8e8e8e8e', 1)
    await create({id, content: 'odd clock'})
    await sharedDb.db.execute('UPDATE blocks SET user_updated_at = ? WHERE id = ?', [9e18, id])
    const out = await view<BlockView>({type: 'view-block', ref: id, format: 'json'})
    expect(out.editedAt).toBeNull()
  })

  it("a block in another workspace never heads a group", async () => {
    const target = uuid('9a1a1a1a', 1)
    const foreign = uuid('9b1b1b1b', 2)
    await create({id: target, content: 'Target'})
    await repo.tx(async tx => {
      await tx.create({id: foreign, workspaceId: 'ws-2', parentId: null, orderKey: 'a0', content: 'Foreign topic', references: []})
    }, {scope: ChangeScope.BlockDefault})
    for (let i = 0; i < 2; i++) {
      await create({id: uuid('9c1c1c1c', i), content: `src ${i}`, references: [{id: target, alias: 'T'}, {id: foreign, alias: 'F'}]})
    }
    const out = await view<GroupedBacklinksView>({type: 'view-grouped-backlinks', ref: target, format: 'json'})
    expect(out.groups.map(group => group.label)).not.toContain('Foreign topic')
  })

  it('reads only a head of a huge types list, counting the rest', async () => {
    const id = uuid('9d1d1d1d', 1)
    await create({id, content: 'typed', properties: {types: Array.from({length: 200_000}, (_, i) => `kind-${i}`)}})
    const out = await view<BlockView>({type: 'view-block', ref: id, format: 'json'})
    expect(out.types).toHaveLength(11)
    expect(out.types.at(-1)).toBe('+199,990 more')
  })

  it('sql summarizes a binary cell by its size', async () => {
    const out = await executeCommand({
      commandId: 's', type: 'sql', mode: 'all', maxRows: 1, sql: 'SELECT randomblob(10) AS b',
    }, context) as {rows: Array<{b: unknown}>, truncatedCells: number}
    expect(out.rows[0].b).toBe('[blob 10 bytes]')
    expect(out.truncatedCells).toBe(1)
  })

  it('a self-parented link-only backlink quotes neither itself as parent nor as first child', async () => {
    const target = uuid('1a1a1a1a', 1)
    const source = uuid('1b1b1b1b', 2)
    await create({id: target, content: 'Target'})
    await create({id: source, content: '[[Target]]', references: [{id: target, alias: 'Target'}]})
    await sharedDb.db.execute('UPDATE blocks SET parent_id = ? WHERE id = ?', [source, source])
    const out = await view<BacklinksView>({type: 'view-backlinks', ref: target, format: 'json'})
    expect(out.rows[0]).not.toHaveProperty('parentContent')
    expect(out.rows[0]).not.toHaveProperty('firstChildContent')
  })

  it('marks "same place" by parent identity, not by matching labels', async () => {
    const target = uuid('2a2a2a2a', 1)
    await create({id: target, content: 'Target'})
    for (const n of [1, 2]) {
      const parent = uuid(`2b2b2b2${n}`, n)
      await create({id: parent, content: 'Weekly sync'})
      await create({id: uuid(`2c2c2c2${n}`, n), parentId: parent, content: '[[Target]]', references: [{id: target, alias: 'Target'}]})
    }
    const text = await view<string>({type: 'view-backlinks', ref: target})
    expect(text).not.toContain('same place as above')
  })

  it('plain-named properties survive the cap, ahead of importer metadata', async () => {
    const id = uuid('3a3a3a3a', 1)
    const properties: Record<string, unknown> = {}
    for (let i = 0; i < 55; i++) properties[`importer:field-${i}`] = i
    properties.status = 'done'
    await create({id, content: 'imported', properties})
    const line = (await view<string>({type: 'view-outline', ref: id})).split('\n')[0]
    expect(line).toContain('status:: done  +55 props')
  })

  it('a huge value costs its line, whether alone or first in a list', async () => {
    const id = uuid('3b3b3b3b', 1)
    const huge = 'q'.repeat(1_000_000)
    await create({id, content: huge, properties: {notes: [huge, 'tail']}})
    const out = await view<OutlineView>({type: 'view-outline', ref: id, format: 'json'})
    expect(out.root.content.length).toBeLessThan(400)
    expect(out.root.cut).toBe(1_000_000 - 300)
    // Bounded by the brief budget plus at most one cut marker.
    const value = out.root.properties.find(property => property.name === 'notes')!.value
    expect(value.length).toBeLessThan(60)
  })

  it('sql cuts a long cell on a character boundary', async () => {
    await create({id: uuid('5a5a5a5a', 1), content: `${'y'.repeat(1999)}\u{1F600}${'z'.repeat(10)}`})
    const out = await executeCommand({
      commandId: 's', type: 'sql', mode: 'all', maxRows: 5,
      sql: "SELECT content FROM blocks WHERE content LIKE 'yyy%'",
    }, context) as {rows: Array<{content: string}>}
    expect(hasLoneSurrogate(out.rows[0].content)).toBe(false)
  })
})

describe('view-backlinks', () => {
  const TARGET = uuid('7a7a7a7a', 1)

  it('pages with the real total, and gives a link-only block its parent and first child', async () => {
    await create({id: TARGET, content: 'Target', properties: {alias: ['Target']}})
    const parent = uuid('9a9a9a9a', 2)
    await create({id: parent, content: 'Discussed the roadmap'})
    const linkOnly = uuid('8b8b8b8b', 3)
    await create({id: linkOnly, parentId: parent, content: '[[Target]]', references: [{id: TARGET, alias: 'Target'}]})
    await create({id: uuid('8c8c8c8c', 4), parentId: linkOnly, content: 'notes underneath'})
    for (let i = 0; i < 3; i++) {
      await create({id: uuid(`5000000${i}`, i), content: `mention ${i} of [[Target]]`, references: [{id: TARGET, alias: 'Target'}]})
    }

    const page = await view<BacklinksView>({type: 'view-backlinks', ref: 'Target', limit: 2, format: 'json'})
    expect(page.total).toBe(4)
    expect(page.rows).toHaveLength(2)
    expect(page.nextOffset).toBe(2)

    const all = await view<BacklinksView>({type: 'view-backlinks', ref: TARGET, format: 'json'})
    const row = all.rows.find(candidate => candidate.id === linkOnly)!
    expect(row.breadcrumb).toEqual(['Discussed the roadmap'])
    expect(row.parentContent).toBe('Discussed the roadmap')
    expect(row.firstChildContent).toBe('notes underneath')
    expect(all.rows.find(candidate => candidate.id !== linkOnly)?.parentContent).toBeUndefined()

    const text = await view<string>({type: 'view-backlinks', ref: TARGET, limit: 2})
    expect(text.split('\n')[0]).toBe('Backlinks of "Target" ^7a7a7a7a — 1–2 of 4 (next: offset=2)')
  })

  it('grouped: groups a page at a time with their sizes and first members', async () => {
    const topic = uuid('70b1c000', 9)
    await create({id: TARGET, content: 'Target'})
    await create({id: topic, content: 'Topic A'})
    for (let i = 0; i < 4; i++) {
      await create({
        id: uuid(`6000000${i}`, i),
        content: `src ${i}`,
        references: [{id: TARGET, alias: 'T'}, {id: topic, alias: 'A'}],
      })
    }
    const out = await view<GroupedBacklinksView>({type: 'view-grouped-backlinks', ref: TARGET, membersPerGroup: 2, format: 'json'})
    expect(out.total).toBe(4)
    expect(out.groups[0]).toMatchObject({label: 'Topic A', groupId: topic, memberCount: 4})
    expect(out.groups[0].members).toHaveLength(2)

    const text = await view<string>({type: 'view-grouped-backlinks', ref: TARGET, membersPerGroup: 2})
    expect(text).toContain('## Topic A  ^70b1c000  (4)')
    expect(text).toContain('+2 more — memberOffset=2 offset=0 limit=1 continues this group')
    const rest = await view<GroupedBacklinksView>({type: 'view-grouped-backlinks', ref: TARGET, membersPerGroup: 2, memberOffset: 2, limit: 1, format: 'json'})
    expect(rest.groups[0].members).toHaveLength(2)
    expect(new Set([...out.groups[0].members, ...rest.groups[0].members].map(member => member.id)).size).toBe(4)
  })
})

describe('view-search', () => {
  it('returns snippets with breadcrumbs, folds identical blocks, and pages honestly', async () => {
    const page = uuid('cccc0000', 1)
    await create({id: page, content: 'Recipes', properties: {alias: ['Recipes']}})
    await create({id: uuid('cccc0001', 2), parentId: page, content: `${'filler '.repeat(40)}banana bread is great`})
    await create({id: uuid('cccc0002', 3), content: 'banana split'})
    await create({id: uuid('cccc0003', 4), content: 'banana split'})

    const out = await view<SearchView>({type: 'view-search', query: 'banana', format: 'json'})
    expect(out.hits).toHaveLength(2)
    const bread = out.hits.find(hit => hit.snippet.includes('bread'))!
    expect(bread.breadcrumb).toEqual(['Recipes'])
    expect(bread.snippet.startsWith('…')).toBe(true)
    const split = out.hits.find(hit => hit.snippet === 'banana split')!
    expect(split.duplicateIds).toHaveLength(1)
    expect(out.nextOffset).toBeNull()

    const firstPage = await view<SearchView>({type: 'view-search', query: 'banana', limit: 1, format: 'json'})
    expect(firstPage.nextOffset).toBe(1)
  })

  it('grows its window past a run of identical blocks, so a distinct hit below them stays reachable', async () => {
    await repo.tx(async tx => {
      for (let i = 0; i < 110; i++) {
        await tx.create({id: uuid('bbbb0000', i), workspaceId: WS, parentId: null, orderKey: `b${i}`, content: 'banana split', references: []})
      }
    }, {scope: ChangeScope.BlockDefault})
    await create({id: uuid('bbbbffff', 1), content: 'we also like banana'})

    const out = await view<SearchView>({type: 'view-search', query: 'banana', format: 'json'})
    expect(out.hits.map(hit => hit.snippet)).toEqual(['banana split', 'we also like banana'])
    expect(out.hits[0].duplicateCount).toBe(109)
    expect(out.hits[0].duplicateIds).toHaveLength(5)
    const text = await view<string>({type: 'view-search', query: 'banana'})
    expect(text).toMatch(/\(\+109 identical: (\^[^,]+, ){5}…\+104 more\)/)
    expect(out.nextOffset).toBeNull()
  })

  it('excludes extension source unless asked, and filters by type and ancestry inside the query', async () => {
    const project = uuid('dddd0000', 1)
    await create({id: project, content: 'Project'})
    await create({id: uuid('dddd0001', 2), parentId: project, content: 'widget plan', properties: {types: ['todo']}})
    await create({id: uuid('dddd0002', 3), content: 'widget idea'})
    await create({id: uuid('dddd0003', 4), content: 'export const widget = 1', properties: {types: ['extension']}})

    const ids = async (extra: Record<string, unknown>) =>
      (await view<SearchView>({type: 'view-search', query: 'widget', format: 'json', ...extra})).hits.map(hit => hit.id).sort()

    expect(await ids({})).toEqual([uuid('dddd0001', 2), uuid('dddd0002', 3)])
    expect(await ids({includeExtensions: true})).toHaveLength(3)
    expect(await ids({types: ['todo']})).toEqual([uuid('dddd0001', 2)])
    expect(await ids({under: 'dddd0000'})).toEqual([uuid('dddd0001', 2)])
    // A selective filter must not shrink a page: it applies before the limit.
    expect(await ids({types: ['todo'], limit: 1})).toEqual([uuid('dddd0001', 2)])
  })
})

describe('raw commands accept the same refs', () => {
  it('get-block takes a prefix; a missing id still answers null', async () => {
    const id = uuid('e0e0e0e0', 1)
    await create({id, content: 'Raw'})
    const block = await executeCommand({commandId: 'r', type: 'get-block', id: 'e0e0e0e0'}, context) as {id: string}
    expect(block.id).toBe(id)
    expect(await executeCommand({commandId: 'r2', type: 'get-block', id: 'not-a-block'}, context)).toBeNull()
  })
})

describe('sql maxRows', () => {
  it('caps rows inside the statement and cuts long cells, saying so', async () => {
    for (let i = 0; i < 3; i++) await create({id: uuid(`f000000${i}`, i), content: 'y'.repeat(2500)})
    const getAll = vi.spyOn(repo.db, 'getAll')
    const out = await executeCommand({
      commandId: 's',
      type: 'sql',
      mode: 'all',
      sql: 'SELECT content FROM blocks ORDER BY id;',
      maxRows: 2,
    }, context) as {rows: Array<{content: string}>, truncated: boolean, truncatedCells: number}
    // SQLite stops after maxRows + 1 rows instead of materializing every match.
    expect(getAll.mock.calls.map(call => call[0]).find(sql => sql.includes('SELECT content FROM blocks'))).toMatch(/\) LIMIT 3$/)
    getAll.mockRestore()
    expect(out.truncated).toBe(true)
    expect(out.rows).toHaveLength(2)
    expect(out.truncatedCells).toBe(2)
    expect(out.rows[0].content.endsWith('…[+500 chars]')).toBe(true)
  })
})
