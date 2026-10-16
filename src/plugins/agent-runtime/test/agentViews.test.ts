// @vitest-environment happy-dom
//
// The agent views (`view-*` commands) and the block-ref resolver, end-to-end
// against a real Repo. Same minimal runtime as dataCommands.test.ts: kernel +
// the backlinks / grouped-backlinks data extensions, with references written
// by hand (the trigger-maintained indexes project them on insert).
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

  it('suggests similar page names when nothing matches', async () => {
    await expect(resolveBlockRef(repo, 'Project', {workspaceId: WS}))
      .rejects.toThrow(/Pages with similar names:\n {2}Project Alpha/)
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

    const text = await view<string>({type: 'view-block', ref: id, maxChars: 30})
    expect(text).toContain('…[+70 chars — continue with contentOffset=30]')
    expect(text).toContain('(hidden in the UI: system:collapsed)')
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
    expect(text).toContain('+2 more — membersPerGroup=4 offset=0 limit=1 lists them')
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
  it('caps rows and cuts long cells, saying so', async () => {
    for (let i = 0; i < 3; i++) await create({id: uuid(`f000000${i}`, i), content: 'y'.repeat(2500)})
    const out = await executeCommand({
      commandId: 's',
      type: 'sql',
      mode: 'all',
      sql: 'SELECT content FROM blocks ORDER BY id',
      maxRows: 2,
    }, context) as {rows: Array<{content: string}>, totalRows: number, truncated: boolean, truncatedCells: number}
    expect(out.totalRows).toBe(3)
    expect(out.truncated).toBe(true)
    expect(out.rows).toHaveLength(2)
    expect(out.truncatedCells).toBe(2)
    expect(out.rows[0].content.endsWith('…[+500 chars]')).toBe(true)
  })
})
