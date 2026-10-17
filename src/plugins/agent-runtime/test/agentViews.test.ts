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
import { AGENT_VIEW_DEFAULTS } from '@knowledge-medium/agent-cli/protocol'
import { createAgentRuntimeContext, executeCommand } from '../commands'
import type { AgentRuntimeContext } from '../protocol'
import { resolveBlockRef, shortIds } from '../agentViews/resolveRef'
import type { OutlineView } from '../agentViews/outline'
import type { BlockView } from '../agentViews/block'
import { renderBacklinksView, type BacklinksView, type GroupedBacklinksView } from '../agentViews/backlinks'
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
interface NewBlock {
  id: string
  content?: string
  parentId?: string | null
  references?: BlockReference[]
  properties?: BlockProperties
}
/** In one transaction, in order: for trees too big to create a tx per block. */
const createAll = async (blocks: readonly NewBlock[]) => {
  await repo.tx(async tx => {
    for (const args of blocks) {
      orderCounter += 1
      await tx.create({
        id: args.id,
        workspaceId: WS,
        parentId: args.parentId ?? null,
        orderKey: `k${orderCounter.toString().padStart(6, '0')}`,
        content: args.content ?? args.id,
        references: args.references ?? [],
        ...(args.properties ? {properties: args.properties} : {}),
      })
    }
  }, {scope: ChangeScope.BlockDefault})
}
const create = (args: NewBlock) => createAll([args])

/** A `workspaces` row, which a read naming a workspace requires on this device. */
const knownWorkspace = (id: string) => sharedDb.db.execute(
  `INSERT OR REPLACE INTO workspaces
     (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary)
   VALUES (?, ?, ?, 1, 1, 'none', NULL)`,
  [id, id, USER.id],
)

const view = async <T,>(command: Record<string, unknown>): Promise<T> =>
  await executeCommand({commandId: 'v', ...command} as never, context) as T

/** Run `body` while every `repo.db.getAll` also runs `hook` around the read —
 *  for changing the database between a view's reads, as sync can. Calls the
 *  unspied method (`repo.db` is a timing proxy that would re-enter the spy). */
const duringReads = async <T,>(
  hook: {before?: (sql: string, params: unknown) => Promise<void>, after?: (sql: string, params: unknown) => Promise<void>},
  body: () => Promise<T>,
): Promise<T> => {
  const target = sharedDb.db
  const original = Object.getPrototypeOf(target).getAll as typeof target.getAll
  const spy = vi.spyOn(repo.db, 'getAll').mockImplementation(async (sql: string, params?: unknown[]) => {
    await hook.before?.(sql, params)
    const rows = await original.call(target, sql, params)
    await hook.after?.(sql, params)
    return rows
  })
  try {
    return await body()
  } finally {
    spy.mockRestore()
  }
}

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
      .toEqual({id: dailyNoteBlockId(WS, '2026-06-18'), via: 'date', iso: '2026-06-18'})
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

  it('describes an ambiguous candidate by its content head, past leading whitespace', async () => {
    await create({id: uuid('a1b2c3d4', 7), content: `${' '.repeat(300)}Real head ${'x'.repeat(5000)}`})
    const message = await resolveBlockRef(repo, 'a1b2c3d4', {workspaceId: WS}).then(() => '', (error: Error) => error.message)
    expect(message).toContain('Real head xxx')
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

  it('keeps a wrapped ref meaning its target when a stored id spells the ref itself', async () => {
    const planted = ['[[Project Alpha]]', '^a1b2c3d4', `((${PAGE}))`]
    for (const id of planted) await create({id, content: 'planted'})
    expect(await resolveBlockRef(repo, '[[Project Alpha]]', {workspaceId: WS})).toEqual({id: PAGE, via: 'alias'})
    expect(await resolveBlockRef(repo, '^a1b2c3d4', {workspaceId: WS})).toEqual({id: PAGE, via: 'prefix'})
    expect(await resolveBlockRef(repo, `((${PAGE}))`, {workspaceId: WS})).toEqual({id: PAGE, via: 'id'})
    for (const id of planted) {
      expect(await resolveBlockRef(repo, `((${id}))`, {workspaceId: WS})).toEqual({id, via: 'id'})
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
    expect(lines[1]).toBe('- First child ⏎ second line  groupWith:: [[Other page]] ^00000002  snapshot-history:: [2 items]  ^00000003')
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

    // A collapsed root still shows its children, as the app does when zoomed into it.
    const asRoot = await view<string>({type: 'view-outline', ref: collapsed})
    expect(asRoot).toContain('- Hidden under fold  ^000000c1')
  })

  it('counts the root children after reading the page, so a child added meanwhile leaves a continuation', async () => {
    await create({id: ROOT, content: 'Root'})
    for (let i = 0; i < 3; i++) await create({id: uuid('0000e000', i), parentId: ROOT, content: `c${i}`})
    let added = false
    const out = await duringReads({
      after: async sql => {
        if (added || !sql.includes('AS child_count')) return
        added = true
        await create({id: uuid('0000e000', 9), parentId: ROOT, content: 'late'})
      },
    }, () => view<OutlineView>({type: 'view-outline', ref: ROOT, limit: 3, depth: 1, format: 'json'}))
    expect(out.rows.map(row => row.content)).toEqual(['c0', 'c1', 'c2'])
    expect(out.nextOffset).toBe(3)
  })

  it('never reports fewer children than it shows when sync adds some mid-walk', async () => {
    await create({id: ROOT, content: 'Root'})
    const a = uuid('0000e200', 1)
    await create({id: a, parentId: ROOT, content: 'A'})
    await create({id: uuid('0000e200', 3), parentId: a, content: 'counted with A'})
    let added = false
    const out = await duringReads({
      after: async sql => {
        if (added || !sql.includes('AS child_count')) return
        added = true
        await create({id: uuid('0000e200', 2), parentId: a, content: 'arrived after A was counted'})
      },
    }, () => view<OutlineView>({type: 'view-outline', ref: ROOT, depth: 2, format: 'json'}))
    const rowA = out.rows.find(row => row.id === a)!
    expect(out.rows).toHaveLength(3)
    expect(rowA).toMatchObject({childCount: 2, hiddenChildren: 0})
  })

  it('never reports the root with fewer children than it shows when sync removes one', async () => {
    await create({id: ROOT, content: 'Root'})
    const doomed = uuid('0000e300', 1)
    await create({id: doomed, parentId: ROOT, content: 'deleted after the page was read'})
    let removed = false
    const out = await duringReads({
      after: async sql => {
        if (removed || !sql.includes('AS child_count')) return
        removed = true
        await sharedDb.db.execute('UPDATE blocks SET deleted = 1 WHERE id = ?', [doomed])
      },
    }, () => view<OutlineView>({type: 'view-outline', ref: ROOT, depth: 1, format: 'json'}))
    expect(out.rows).toHaveLength(1)
    expect(out.root.childCount).toBe(1)
  })

  it('reports the real child count for an offset past the last child', async () => {
    await create({id: ROOT, content: 'Root'})
    for (let i = 0; i < 2; i++) await create({id: uuid('0000e400', i), parentId: ROOT, content: `c${i}`})
    const out = await view<OutlineView>({type: 'view-outline', ref: ROOT, offset: 100, format: 'json'})
    expect(out.rows).toEqual([])
    expect(out.root.childCount).toBe(2)
    expect(out.nextOffset).toBeNull()
  })

  it('lists children of the viewed workspace even if sync moves the root mid-view', async () => {
    await create({id: ROOT, content: 'Root'})
    const child = uuid('0000e100', 1)
    await create({id: child, parentId: ROOT, content: 'moved with its parent'})
    const out = await duringReads({
      before: async sql => {
        if (!sql.includes('AS child_count')) return
        await sharedDb.db.execute('UPDATE blocks SET workspace_id = ? WHERE id IN (?, ?)', ['ws-2', ROOT, child])
      },
    }, () => view<OutlineView>({type: 'view-outline', ref: ROOT, format: 'json'}))
    expect(out.rows).toEqual([])
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
    }, {scope: ChangeScope.BlockDefault, allowUnloadedWorkspace: true})
    await expect(view({type: 'view-block', ref: foreign})).rejects.toThrow(/not the one open.*workspaceId ws-2.*--raw/s)
  })

  // A pinned client names a workspace on every call, and the bridge falls back
  // to another workspace's tab when none has it open.
  it('refuses a view naming a workspace other than the open one, and serves one naming it', async () => {
    await create({id: ROOT, content: 'Root page'})
    await create({id: uuid('0f0f0f10', 1), parentId: ROOT, content: 'here'})
    await expect(view({type: 'view-outline', ref: ROOT, workspaceId: 'ws-2'}))
      .rejects.toThrow(/Workspace ws-2 is not the one open/)
    await expect(view({type: 'view-search', query: 'here', workspaceId: 'ws-2'}))
      .rejects.toThrow(/Workspace ws-2 is not the one open/)
    expect(await view<string>({type: 'view-outline', ref: ROOT, workspaceId: ` ${WS} `})).toContain('- here')
  })

  it('says a dated daily note that does not exist yet has not been created', async () => {
    await expect(view({type: 'view-outline', ref: '2026-06-18'})).rejects.toThrow(/has not been created yet/)
  })

  describe('the output budget', () => {
    /** Ids whose first 8 hex chars differ, so each prints as an 8-char short id. */
    const seriesId = (series: string, i: number): string => uuid(`${series}${i.toString(16).padStart(6, '0')}`, i)
    /** A property bag that prints about 15k characters with properties: full. */
    const bigProperties = (): BlockProperties =>
      Object.fromEntries(Array.from({length: 50}, (_, i) => [`p${i.toString().padStart(2, '0')}`, 'v'.repeat(300)]))
    /** The lines the budget counts: the header (one line here) and the rows. */
    const countedChars = (text: string, rows: number): number =>
      text.split('\n').slice(0, 1 + rows).reduce((sum, line) => sum + line.length + 1, 0)

    it('keeps the breadth-first prefix whose printed lines fit, and continues by offset from there', async () => {
      await create({id: ROOT, content: 'Root', properties: bigProperties()})
      const children = Array.from({length: 400}, (_, i) => ({id: seriesId('b1', i), parentId: ROOT, content: `entry ${i}`}))
      await createAll(children.flatMap((child, i) => [child, {id: seriesId('b2', i), parentId: child.id, content: 'under'}]))

      const command = {type: 'view-outline', ref: ROOT, depth: 1, limit: 400, properties: 'full'}
      const out = await view<OutlineView>({...command, format: 'json'})
      const kept = out.rows.length
      expect(kept).toBeGreaterThan(0)
      expect(out.budgetDropped).toBe(400 - kept)
      expect(out.rows.map(row => row.content)).toEqual(children.slice(0, kept).map(child => child.content))
      expect(out.rows.every(row => row.hiddenChildren === 1)).toBe(true)
      expect(out.nextOffset).toBe(kept)

      const text = await view<string>(command)
      const rowLines = text.split('\n').slice(1, 1 + kept)
      expect(rowLines.map(line => /\^(\w+) {2}\(\+1 child\)$/.exec(line)?.[1])).toEqual(out.rows.map(row => row.shortId))
      // Counted as printed: the root's line, each row's with its hidden-children
      // note, and every line break; one more row would not have fit.
      const counted = countedChars(text, kept)
      expect(counted).toBeLessThanOrEqual(AGENT_VIEW_DEFAULTS.outlineChars)
      expect(counted + Math.max(...rowLines.map(line => line.length + 1))).toBeGreaterThan(AGENT_VIEW_DEFAULTS.outlineChars)
      expect(text).toContain(`continue with offset=${kept}`)
      expect(text).toMatch(new RegExp(`\\n… ${400 - kept} more selected blocks not shown, past the [\\d,]+-character output budget `
        + '— narrow with properties=none, a lower limit or depth, or search with under=\\^00000001\\n'))

      const next = await view<OutlineView>({...command, offset: kept, format: 'json'})
      expect(next.rows[0].content).toBe(`entry ${kept}`)
    })

    it('drops the deepest selected blocks first, and counts each as its parent\'s hidden child', async () => {
      await create({id: ROOT, content: 'Root'})
      const children = Array.from({length: 100}, (_, i) => ({id: seriesId('c1', i), parentId: ROOT, content: `c${i}`}))
      const grandchildren = children.map((child, i) => ({id: seriesId('c2', i), parentId: child.id, content: 'x'.repeat(400)}))
      await createAll([...children, ...grandchildren])

      const out = await view<OutlineView>({type: 'view-outline', ref: ROOT, depth: 2, limit: 200, format: 'json'})
      const shown = out.rows.filter(row => row.depth === 2).length
      expect(shown).toBeGreaterThan(0)
      expect(shown).toBeLessThan(100)
      expect(out.budgetDropped).toBe(100 - shown)
      expect(out.nextOffset).toBeNull()
      expect(out.rows.filter(row => row.depth === 1)).toHaveLength(100)
      expect(out.rows.map(row => row.id)).toEqual(children.flatMap((child, i) =>
        i < shown ? [child.id, grandchildren[i].id] : [child.id]))
      for (const [i, child] of children.entries()) {
        expect(out.rows.find(row => row.id === child.id)).toMatchObject({childCount: 1, hiddenChildren: i < shown ? 0 : 1})
      }
    })

    it('keeps the first row whatever its length, so a continuation always moves forward', async () => {
      await create({id: ROOT, content: 'Root', properties: bigProperties()})
      for (let i = 0; i < 2; i++) await create({id: seriesId('d1', i), parentId: ROOT, content: `long ${i}`, properties: bigProperties()})
      const out = await view<OutlineView>({type: 'view-outline', ref: ROOT, depth: 1, properties: 'full', format: 'json'})
      expect(out.rows.map(row => row.content)).toEqual(['long 0'])
      expect(out.nextOffset).toBe(1)
      expect(out.budgetDropped).toBe(1)
    })

    it('says nothing about the budget when everything fits', async () => {
      await create({id: ROOT, content: 'Root'})
      await create({id: seriesId('e1', 0), parentId: ROOT, content: 'only'})
      const out = await view<OutlineView>({type: 'view-outline', ref: ROOT, format: 'json'})
      expect(out.budgetDropped).toBe(0)
      expect(await view<string>({type: 'view-outline', ref: ROOT})).not.toContain('output budget')
    })
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

  it('a capped search ends its listing at the window, never offering an unreachable offset', async () => {
    const hit = (i: number) => ({
      id: `hit-${i}`, workspaceId: WS, parentId: null, orderKey: `h${i}`, content: `distinct ${i}`,
      properties: {}, references: [], createdAt: 1, updatedAt: 1, userUpdatedAt: 1,
      createdBy: USER.id, updatedBy: USER.id, deleted: false,
    })
    repo.setRuntimeContributions(searchSourcesFacet, 'test:many', [{
      id: 'test.many',
      search: async (_repo, args) => Array.from({length: args.limit}, (_, i) => ({block: hit(i) as never, score: 1000})),
    }])
    const out = await view<SearchView>({type: 'view-search', query: 'distinct', offset: 1990, limit: 10, format: 'json'})
    expect(out.hits).toHaveLength(10)
    expect(out.nextOffset).toBeNull()
    expect(out.windowCap).toBe(2000)
  })

  it('calls a duplicate count a lower bound while matches continue past the window', async () => {
    const row = (i: number, content: string) => ({
      id: `row-${i}`, workspaceId: WS, parentId: null, orderKey: `r${i}`, content,
      properties: {}, references: [], createdAt: 1, updatedAt: 1, userUpdatedAt: 1,
      createdBy: USER.id, updatedBy: USER.id, deleted: false,
    })
    // Always a full window: two identical rows, then distinct ones.
    repo.setRuntimeContributions(searchSourcesFacet, 'test:endless', [{
      id: 'test.endless',
      search: async (_repo, args) => Array.from({length: args.limit}, (_, i) =>
        ({block: row(i, i < 2 ? 'twin text' : `other text ${i}`) as never, score: 1000})),
    }])
    const out = await view<SearchView>({type: 'view-search', query: 'text', format: 'json'})
    expect(out.duplicateCountsComplete).toBe(false)
    expect(out.hits[0].duplicateCount).toBe(1)
    const text = await view<string>({type: 'view-search', query: 'text'})
    expect(text).toContain('(+1 or more identical: ^row-1)')
  })

  it('search drops a candidate a source answers with from another workspace', async () => {
    const row = (id: string, workspaceId: string) => ({
      id, workspaceId, parentId: null, orderKey: id, content: `papaya ${id}`,
      properties: {}, references: [], createdAt: 1, updatedAt: 1, userUpdatedAt: 1,
      createdBy: USER.id, updatedBy: USER.id, deleted: false,
    })
    repo.setRuntimeContributions(searchSourcesFacet, 'test:stale', [{
      id: 'test.stale',
      search: async () => [row('here', WS), row('moved', 'ws-2')].map(block => ({block: block as never, score: 1000})),
    }])
    const out = await view<SearchView>({type: 'view-search', query: 'papaya', format: 'json'})
    expect(out.hits.map(hit => hit.id)).toEqual(['here'])
  })

  it('search refuses an `under` block from another workspace', async () => {
    const foreign = uuid('5e5e5e5f', 1)
    await repo.tx(async tx => {
      await tx.create({id: foreign, workspaceId: 'ws-2', parentId: null, orderKey: 'a0', content: 'elsewhere', references: []})
    }, {scope: ChangeScope.BlockDefault, allowUnloadedWorkspace: true})
    await expect(view({type: 'view-search', query: 'anything', under: foreign})).rejects.toThrow(/not the one open/)
  })

  it('search scopes by an `under` block\'s id, never reading its whole row, and refuses a deleted one', async () => {
    const scope = uuid('5d5d5d5d', 1)
    await create({id: scope, content: `Archive ${'x'.repeat(5000)}`, properties: {'importer:payload': 'y'.repeat(100_000)}})
    await create({id: uuid('5d5d5d5e', 2), parentId: scope, content: 'quince note'})

    const getAll = vi.spyOn(repo.db, 'getAll')
    const out = await view<SearchView>({type: 'view-search', query: 'quince', under: scope, limit: 1, format: 'json'})
    const wholeRowReads = getAll.mock.calls.filter(([sql, params]) =>
      /SELECT (b\.)?\*/.test(sql) && JSON.stringify(params ?? []).includes(scope))
    getAll.mockRestore()
    expect(out.hits.map(hit => hit.id)).toEqual([uuid('5d5d5d5e', 2)])
    expect(wholeRowReads).toEqual([])

    await repo.mutate.delete({id: scope})
    await expect(view({type: 'view-search', query: 'quince', under: scope})).rejects.toThrow(/is deleted; restore-block/)
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
    for (const [i, target] of targets.entries()) await create({id: target, content: `r${i}`, properties: {alias: [`r${i}`]}})
    const holder = uuid('7f7f7f7f', 1)
    await create({id: holder, content: 'holder', properties: {groupWith: targets}})
    const getAll = vi.spyOn(repo.db, 'getAll')
    const out = await view<BlockView>({type: 'view-block', ref: holder, format: 'json'})
    const titleQuery = getAll.mock.calls.find(call => /, 400\) AS content/.test(call[0]))
    getAll.mockRestore()
    expect(JSON.parse(titleQuery![1]![0] as string)).toHaveLength(20)
    const value = out.properties.find(property => property.name === 'groupWith')!.value
    const [, shown, rest] = value.match(/^((?:\[\[r\d+\]\] \^7e7e7e\d\d, )+)…\+(\d+) more$/)!
    expect(shown.split(', ').length - 1 + Number(rest)).toBe(25)
  })

  it('shows a ref whole or counts it, never cutting its id, when prefixes collide', async () => {
    const first = uuid('7a7b7c7d', 1)
    const second = uuid('7a7b7c7d', 2)
    for (const id of [first, second]) await create({id, content: `Twin ${id.slice(-1)}`})
    const root = uuid('7a7b7c7e', 1)
    await create({id: root, content: 'root'})
    await create({id: uuid('7a7b7c7f', 1), parentId: root, content: 'one', properties: {groupWith: [first]}})
    await create({id: uuid('7a7b7c7f', 2), parentId: root, content: 'two', properties: {groupWith: [first, second]}})
    // Every shorter prefix of these ids is shared, so each prints whole (36 characters).
    const text = await view<string>({type: 'view-outline', ref: root})
    expect(text).toContain(`- one  groupWith:: ^${first}  `)
    expect(text).toContain('- two  groupWith:: [2 refs]  ')
  })

  it('counts only the refs that decode, not malformed list entries', async () => {
    const target = uuid('7f9f0001', 1)
    await create({id: target, content: 'Target', properties: {alias: ['Target']}})
    const holder = uuid('7f9f0002', 2)
    await create({id: holder, content: 'holder'})
    // Sync can deliver a list the codec would never write.
    await sharedDb.db.execute(
      `UPDATE blocks SET properties_json = json_set(properties_json, '$.groupWith', json(?)) WHERE id = ?`,
      [JSON.stringify([target, 42]), holder],
    )
    const out = await view<BlockView>({type: 'view-block', ref: holder, format: 'json'})
    const line = out.properties.find(property => property.name === 'groupWith')!
    expect(line.value).toBe('[[Target]] ^7f9f0001')
    expect(line.refIds).toEqual([target])
  })

  it('gives JSON the exact ids of a ref property, which the text bounds', async () => {
    const target = uuid('7f8f0001', 1)
    await create({id: target, content: 'Target', properties: {alias: ['Target']}})
    const dangling = `dangling-${'z'.repeat(100)}`
    const holder = uuid('7f8f0002', 2)
    await create({id: holder, content: 'holder', properties: {groupWith: [target, dangling]}})
    const out = await view<BlockView>({type: 'view-block', ref: holder, format: 'json'})
    const line = out.properties.find(property => property.name === 'groupWith')!
    expect(line.refIds).toEqual([target, dangling])
    expect(line.value).toMatch(/^\[\[Target\]\] \^7f8f0001, \(\(dangling-z+…\)\)$/)
  })

  it('gives an aliased ref its id: an alias two pages claim resolves to the older one', async () => {
    const older = uuid('7e8e0001', 1)
    const younger = uuid('7e8e0002', 2)
    await create({id: older, content: 'Plans', properties: {alias: ['Plans']}})
    // A local write refuses a claimed alias; sync applies one verbatim.
    await create({id: younger, content: 'Plans'})
    await sharedDb.db.execute(
      `UPDATE blocks SET properties_json = json_set(properties_json, '$.alias', json(?)) WHERE id = ?`,
      ['["Plans"]', younger],
    )
    const holder = uuid('7e8e0003', 3)
    await create({id: holder, content: 'holder', properties: {groupWith: [younger]}})
    expect((await resolveBlockRef(repo, '[[Plans]]', {workspaceId: WS})).id).toBe(older)

    const out = await view<BlockView>({type: 'view-block', ref: holder, format: 'json'})
    expect(out.properties.find(property => property.name === 'groupWith')!.value).toBe('[[Plans]] ^7e8e0002')
    expect((await resolveBlockRef(repo, '^7e8e0002', {workspaceId: WS})).id).toBe(younger)
  })

  it('names a ref to a block with no alias by its content and a short id that resolves back', async () => {
    const task = uuid('7a7a7a7a', 1)
    const content = `Write the quarterly report${' and more'.repeat(20)}`
    await create({id: task, content})
    const page = uuid('7b7b7b7b', 1)
    await create({id: page, content: 'Plans', properties: {alias: ['Plans']}})
    const root = uuid('7c7c7c7c', 1)
    await create({id: root, content: 'root'})
    const holder = uuid('7d7d7d7d', 1)
    await create({id: holder, parentId: root, content: 'holder', properties: {groupWith: [task, page]}})

    const out = await view<BlockView>({type: 'view-block', ref: holder, format: 'json'})
    expect(out.properties.find(property => property.name === 'groupWith')!.value)
      .toBe(`"${content}" ^7a7a7a7a, [[Plans]] ^7b7b7b7b`)
    expect((await resolveBlockRef(repo, '^7a7a7a7a', {workspaceId: WS})).id).toBe(task)
    // A brief line is 40 characters: the label gives way, never the id.
    const outline = await view<string>({type: 'view-outline', ref: root})
    expect(outline).toMatch(/groupWith:: "Write the[^"]*…" \^7a7a7a7a, …\+1 more/)
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
    }, {scope: ChangeScope.BlockDefault, allowUnloadedWorkspace: true})
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
    }, {scope: ChangeScope.BlockDefault, allowUnloadedWorkspace: true})
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
    }, {scope: ChangeScope.BlockDefault, allowUnloadedWorkspace: true})
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

  it('page previews a candidate by a head of its content, never the whole of it', async () => {
    await create({id: uuid('7d1d1d1d', 1), content: 'y'.repeat(5000), properties: {alias: ['Long document']}})
    const out = await executeCommand({commandId: 'p', type: 'page', name: 'Long doc'}, context) as {candidates: Array<{content: string}>}
    expect(out.candidates[0].content).toBe('y'.repeat(500))
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
    for (const [i, target] of targets.entries()) await create({id: target, content: `t${i}`, properties: {alias: [`t${i}`]}})
    const id = uuid('8c8c8c8c', 1)
    await create({id, content: 'lists', properties: {
      groupWith: [...targets, ...Array.from({length: 200_000}, (_, i) => uuid('8d8d8d8d', i))],
      numbers: Array.from({length: 200_000}, (_, i) => i),
      history: [{at: 1}, ...Array.from({length: 200_000}, (_, i) => i)],
    }})
    const out = await view<BlockView>({type: 'view-block', ref: id, format: 'json'})
    const value = (name: string) => out.properties.find(property => property.name === name)!.value
    expect(value('groupWith')).toMatch(/^\[\[t0\]\] \^8b8b8b80, \[\[t1\]\] \^8b8b8b81, \[\[t2\]\] \^8b8b8b82, .*, …\+\d+ more$/)
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
    }, {scope: ChangeScope.BlockDefault, allowUnloadedWorkspace: true})
    for (let i = 0; i < 2; i++) {
      await create({id: uuid('9c1c1c1c', i), content: `src ${i}`, references: [{id: target, alias: 'T'}, {id: foreign, alias: 'F'}]})
    }
    const out = await view<GroupedBacklinksView>({type: 'view-grouped-backlinks', ref: target, format: 'json'})
    expect(out.groups.map(group => group.label)).not.toContain('Foreign topic')

    // Nor through a context block's groupWith.
    const context = uuid('9e1e1e1e', 3)
    await create({id: context, content: 'Context', properties: {groupWith: [foreign]}, references: [{id: foreign, alias: 'F', sourceField: 'groupWith'}]})
    for (let i = 0; i < 2; i++) {
      await create({id: uuid('9f1f1f1f', i), content: `ctx src ${i}`, references: [{id: target, alias: 'T'}, {id: context, alias: 'C'}]})
    }
    const viaGroupWith = await view<GroupedBacklinksView>({type: 'view-grouped-backlinks', ref: target, limit: 50, format: 'json'})
    expect(viaGroupWith.groups.map(group => group.label)).toContain('Context')
    expect(viaGroupWith.groups.map(group => group.label)).not.toContain('Foreign topic')
  })

  it('a group context walk stops at a foreign ancestor', async () => {
    const target = uuid('a0a0a0a0', 1)
    const outerRoot = uuid('a1a1a1a1', 2)
    const foreignParent = uuid('a2a2a2a2', 3)
    await create({id: target, content: 'Target'})
    await create({id: outerRoot, content: 'Outer root'})
    await repo.tx(async tx => {
      await tx.create({id: foreignParent, workspaceId: 'ws-2', parentId: null, orderKey: 'a0', content: 'bridge', references: []})
    }, {scope: ChangeScope.BlockDefault, allowUnloadedWorkspace: true})
    await sharedDb.db.execute('UPDATE blocks SET parent_id = ? WHERE id = ?', [outerRoot, foreignParent])
    for (let i = 0; i < 2; i++) {
      const source = uuid('a3a3a3a3', i)
      await create({id: source, content: `src ${i}`, references: [{id: target, alias: 'T'}]})
      await sharedDb.db.execute('UPDATE blocks SET parent_id = ? WHERE id = ?', [foreignParent, source])
    }
    const out = await view<GroupedBacklinksView>({type: 'view-grouped-backlinks', ref: target, format: 'json'})
    expect(out.groups.map(group => group.label)).not.toContain('Outer root')
  })

  it('treats a field or type group as no block, even when a stored id spells its group id', async () => {
    const target = uuid('a4a4a4a4', 1)
    await create({id: target, content: 'Target', properties: {alias: ['Target']}})
    await create({id: 'field:reviewer', content: 'planted'})
    await create({id: uuid('a5a5a5a5', 1), content: 'src', references: [{id: target, alias: 'Target', sourceField: 'reviewer'}]})
    const out = await view<GroupedBacklinksView>({type: 'view-grouped-backlinks', ref: target, format: 'json'})
    expect(out.groups.find(group => group.label === 'reviewer')).toMatchObject({groupId: null, shortId: null})
  })

  it('reads only a head of a huge types list, counting the rest', async () => {
    const id = uuid('9d1d1d1d', 1)
    await create({id, content: 'typed', properties: {types: Array.from({length: 200_000}, (_, i) => `kind-${i}`)}})
    const out = await view<BlockView>({type: 'view-block', ref: id, format: 'json'})
    expect(out.types).toHaveLength(11)
    expect(out.types.at(-1)).toBe('+199,990 more')
  })

  it('folds only exactly identical text into one search hit', async () => {
    await create({id: uuid('b0b0b0b0', 1), content: 'Const Value'})
    await create({id: uuid('b0b0b0b1', 2), content: 'const value'})
    await create({id: uuid('b0b0b0b2', 3), content: 'const value'})
    const out = await view<SearchView>({type: 'view-search', query: 'const value', format: 'json'})
    expect(out.hits).toHaveLength(2)
    expect(out.hits.map(hit => hit.duplicateCount).sort()).toEqual([0, 1])
  })

  it('numbers backlinks by the positions consumed, a deleted one included', () => {
    const row = (id: string, position: number) => ({
      id, shortId: id, content: `row ${id}`, cut: 0, types: [], properties: [], omittedProperties: 0,
      position, parentId: null, breadcrumb: [], childCount: 0, viaProperties: [],
    })
    const text = renderBacklinksView({
      target: {id: 't', shortId: 't', title: 'Target'},
      total: 5, offset: 0, nextOffset: 3, filter: null,
      rows: [row('a', 1), row('c', 3)],
    })
    expect(text.split('\n')[0]).toContain('1–3 of 5 (next: offset=3)')
    expect(text).toContain('3. ^c')
  })

  it("a backlinks page whose sources were all deleted still points to the next one", async () => {
    const lines = renderBacklinksView({
      target: {id: 't', shortId: 't', title: 'Target'},
      total: 5,
      offset: 0,
      nextOffset: 2,
      filter: null,
      rows: [],
    })
    expect(lines).toContain('(next: offset=2)')
  })

  it('a cycle row is not counted as a hidden child', async () => {
    const root = uuid('c0c0c0c0', 1)
    const child = uuid('c1c1c1c1', 2)
    await create({id: root, content: 'Root'})
    await create({id: child, parentId: root, content: 'Child'})
    await sharedDb.db.execute('UPDATE blocks SET parent_id = ? WHERE id = ?', [child, root])
    const out = await view<OutlineView>({type: 'view-outline', ref: root, depth: 3, format: 'json'})
    expect(out.rows).toMatchObject([{content: 'Child', hiddenChildren: 0}])
  })

  it('clips an over-long id when printing it, even in a hint', async () => {
    const longId = `id-${'x'.repeat(300)}`
    const properties: Record<string, unknown> = {}
    for (let i = 0; i < 60; i++) properties[`field-${i}`] = i
    await create({id: longId, content: 'odd id', properties})
    const text = await view<string>({type: 'view-block', ref: longId})
    expect(text).not.toContain('x'.repeat(100))
    expect(text).toContain("[this block's id from format")
    const json = await view<BlockView>({type: 'view-block', ref: longId, format: 'json'})
    expect(json.id).toBe(longId)
  })

  it('grouped backlinks share one member budget across the page', async () => {
    const target = uuid('d0d0d0d0', 1)
    await create({id: target, content: 'Target'})
    const topics = [uuid('d1d1d1d1', 1), uuid('d2d2d2d2', 2)]
    for (const [n, topic] of topics.entries()) await create({id: topic, content: `Topic ${n}`})
    await repo.tx(async tx => {
      for (let i = 0; i < 520; i++) {
        const topic = topics[i % 2]
        await tx.create({
          id: uuid('d3d3d3d3', i), workspaceId: WS, parentId: null, orderKey: `m${i}`, content: `member ${i}`,
          references: [{id: target, alias: 'T'}, {id: topic, alias: 'Topic'}],
        })
      }
    }, {scope: ChangeScope.BlockDefault})
    const out = await view<GroupedBacklinksView>({type: 'view-grouped-backlinks', ref: target, membersPerGroup: 500, format: 'json'})
    expect(out.groups.length).toBeGreaterThanOrEqual(2)
    for (const group of out.groups) expect(group.members.length).toBeLessThanOrEqual(250)
  })

  it("a title-only alias takes no property slot", async () => {
    const id = uuid('e0e0e0e0', 1)
    await create({id, content: 'Page Title', properties: {alias: ['Page Title'], a: 1, b: 2, c: 3, d: 4}})
    const line = (await view<string>({type: 'view-outline', ref: id})).split('\n')[0]
    expect(line).toContain('a:: 1  b:: 2  c:: 3  +1 props')
  })

  it('clips a long id listed in an ambiguous-prefix error', async () => {
    await create({id: `e1e1e1e1-${'f'.repeat(300)}`, content: 'long'})
    await create({id: uuid('e1e1e1e1', 2), content: 'short'})
    const message = await resolveBlockRef(repo, 'e1e1e1e1', {workspaceId: WS}).then(() => '', (error: Error) => error.message)
    expect(message).toMatch(/ambiguous/)
    expect(message).not.toContain('f'.repeat(100))
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

  it('reads the user\'s grouping and filter preferences without creating them', async () => {
    await create({id: TARGET, content: 'Target', properties: {alias: ['Target']}})
    await create({id: uuid('6d000001', 1), content: 'mention of [[Target]]', references: [{id: TARGET, alias: 'Target'}]})
    const blockCount = async () => (await sharedDb.db.getAll<{n: number}>('SELECT count(*) AS n FROM blocks'))[0].n
    const before = await blockCount()

    const grouped = await view<GroupedBacklinksView>({type: 'view-grouped-backlinks', ref: TARGET, format: 'json'})
    const flat = await view<BacklinksView>({type: 'view-backlinks', ref: TARGET, filter: 'effective', format: 'json'})
    expect(grouped.total).toBe(1)
    expect(flat.total).toBe(1)
    expect(await blockCount()).toBe(before)
  })

  it('quotes no self-parented label\'s own children as its siblings', async () => {
    await create({id: TARGET, content: 'Target', properties: {alias: ['Target']}})
    const label = uuid('6f100001', 1)
    await create({id: label, content: '[[Target]]', references: [{id: TARGET, alias: 'Target'}]})
    await create({id: uuid('6f100002', 2), parentId: label, content: 'with [[Target]] account', references: [{id: TARGET, alias: 'Target'}]})
    await create({id: uuid('6f100003', 3), parentId: label, content: 'child line of the label'})
    // Sync applies parent ids verbatim, so a block can be its own parent.
    await sharedDb.db.execute('UPDATE blocks SET parent_id = id WHERE id = ?', [label])

    const out = await view<BacklinksView>({type: 'view-backlinks', ref: TARGET, format: 'json'})
    expect(out.rows.find(row => row.id === label)).not.toHaveProperty('siblings')
  })

  it('plans every lookup by an id list with the list as the outer loop', async () => {
    await create({id: TARGET, content: 'Target', properties: {alias: ['Target']}})
    const meeting = uuid('6f200001', 1)
    await create({id: meeting, content: '[[Meeting]]'})
    await create({id: uuid('6f200002', 2), parentId: meeting, content: 'with [[Target]]', references: [{id: TARGET, alias: 'Target'}]})
    const lookups: Array<{sql: string, params: unknown[]}> = []
    await duringReads({
      before: async (sql, params) => {
        if (/FROM json_each\(\?\) j\s+(CROSS )?JOIN blocks b/.test(sql)) lookups.push({sql, params: params as unknown[]})
      },
    }, async () => {
      await view({type: 'view-backlinks', ref: TARGET})
      await view({type: 'view-search', query: 'Target'})
    })
    expect(lookups.length).toBeGreaterThan(0)
    for (const {sql, params} of lookups) {
      // Without table stats the planner may drive from a workspace index and
      // rescan the id list for every block in the workspace.
      const plan = await sharedDb.db.getAll<{detail: string}>(`EXPLAIN QUERY PLAN ${sql}`, params)
      const first = plan.find(step => /^(SCAN|SEARCH)/.test(step.detail))
      expect(first?.detail, sql).toMatch(/json_each|\bj\b/)
    }
  })

  it('prints no sibling line for a sibling that is only whitespace', async () => {
    await create({id: TARGET, content: 'Target', properties: {alias: ['Target']}})
    const meeting = uuid('6f000001', 1)
    await create({id: meeting, content: '[[Meeting]]'})
    const line = uuid('6f000002', 2)
    await create({id: line, parentId: meeting, content: 'with [[Target]]', references: [{id: TARGET, alias: 'Target'}]})
    await create({id: uuid('6f000003', 3), parentId: meeting, content: '\u00a0\u2003'})
    await create({id: uuid('6f000004', 4), parentId: meeting, content: 'topic: renewal'})

    const out = await view<BacklinksView>({type: 'view-backlinks', ref: TARGET, format: 'json'})
    // Accepted: the blank sibling still takes one of the two slots the query reads.
    expect(out.rows[0].siblings).toEqual(['topic: renewal'])
  })

  it('gives a source under a label the first other lines of its record', async () => {
    await create({id: TARGET, content: 'Target', properties: {alias: ['Target']}})
    const meeting = uuid('6a000001', 1)
    await create({id: meeting, content: '[[Meeting]]'})
    const line = uuid('6a000002', 2)
    await create({id: line, parentId: meeting, content: 'with [[Target]] account team', references: [{id: TARGET, alias: 'Target'}]})
    await create({id: uuid('6a000003', 3), parentId: meeting, content: '   '})
    await create({id: uuid('6a000004', 4), parentId: meeting, content: 'topic: contract renewal terms'})
    await create({id: uuid('6a000005', 5), parentId: meeting, content: `notes: ${'n'.repeat(100_000)}`})
    await create({id: uuid('6a000006', 6), parentId: meeting, content: 'a third line'})
    const prose = uuid('6a000007', 7)
    await create({id: prose, content: 'Discussed the roadmap'})
    await create({id: uuid('6a000008', 8), parentId: prose, content: 'mention of [[Target]] in prose', references: [{id: TARGET, alias: 'Target'}]})
    await create({id: uuid('6a000009', 9), parentId: prose, content: 'a line beside it'})

    const out = await view<BacklinksView>({type: 'view-backlinks', ref: TARGET, format: 'json'})
    const row = out.rows.find(candidate => candidate.id === line)!
    expect(row.siblings).toHaveLength(2)
    expect(row.siblings![0]).toBe('topic: contract renewal terms')
    expect(row.siblings![1]).toMatch(/^notes: n+…$/)
    expect(row.siblings![1].length).toBeLessThanOrEqual(160)
    expect(out.rows.find(candidate => candidate.id !== line)).not.toHaveProperty('siblings')

    const text = await view<string>({type: 'view-backlinks', ref: TARGET})
    expect(text).toContain('   ↳ sibling: topic: contract renewal terms')
  })

  it('judges a label by all of its text: no reference, words, or links past the length it reads make it a parent', async () => {
    await create({id: TARGET, content: 'Target', properties: {alias: ['Target']}})
    const parents = [
      uuid('6b000001', 1),
      uuid('6b000002', 2),
      uuid('6b000003', 3),
      uuid('6b000004', 4),
      uuid('6b000005', 5),
      uuid('6b000006', 6),
      uuid('6b000007', 7),
      uuid('6b000008', 8),
      uuid('6b000009', 9),
      uuid('6b00000a', 10),
    ]
    await create({id: parents[0], content: 'ok'})
    // 200 characters of links, then words: a parent past that length is no label.
    await create({id: parents[1], content: `${'[[tag]] '.repeat(25)}then the actual words`})
    // No reference at all: bare punctuation, and a word.
    await create({id: parents[2], content: '-'})
    await create({id: parents[3], content: 'OK:'})
    // A link plus a short title is a titled parent, not a bare label.
    await create({id: parents[4], content: '[[Meeting]] Q1'})
    // Link delimiters the reference parser does not read as references.
    await create({id: parents[5], content: '[[]]'})
    await create({id: parents[6], content: '((notes))'})
    // A bare tag is text here: only wikilinks and block refs are references.
    await create({id: parents[7], content: '#standup'})
    // Links only, but 205 characters: past the length a label may have.
    await create({id: parents[8], content: `${'[[tag]] '.repeat(25)}[[x]]`})
    // A block embed shows its target's content: no bare link.
    await create({id: parents[9], content: `!((${TARGET}))`})
    for (const [index, parent] of parents.entries()) {
      await create({id: uuid('6b00001' + index, 10 + index), parentId: parent, content: `line ${index} of [[Target]]`, references: [{id: TARGET, alias: 'Target'}]})
      await create({id: uuid('6b00002' + index, 20 + index), parentId: parent, content: 'a line beside it'})
    }

    const out = await view<BacklinksView>({type: 'view-backlinks', ref: TARGET, format: 'json'})
    expect(out.rows).toHaveLength(10)
    expect(out.rows.filter(row => row.siblings)).toEqual([])
  })

  it('quotes a link-only source\'s neighbours from a bounded head, never their whole rows', async () => {
    await create({id: TARGET, content: 'Target', properties: {alias: ['Target']}})
    const parent = uuid('9b9b9b9b', 1)
    await create({id: parent, content: `Big parent ${'p'.repeat(100_000)}`})
    const source = uuid('9b9b9b9c', 2)
    await create({id: source, parentId: parent, content: '[[Target]]', references: [{id: TARGET, alias: 'Target'}]})
    await create({id: uuid('9b9b9b9d', 3), parentId: source, content: `Big child ${'c'.repeat(100_000)}`})
    const wholeRowReads: string[] = []
    const out = await duringReads({
      before: async (sql, params) => {
        if (/\b(b|child)\.\*/.test(sql) && JSON.stringify(params).includes(parent)) wholeRowReads.push(sql)
      },
    }, () => view<BacklinksView>({type: 'view-backlinks', ref: TARGET, format: 'json'}))
    expect(out.rows[0].parentContent).toMatch(/^Big parent p+…$/)
    expect(out.rows[0].firstChildContent).toMatch(/^Big child c+…$/)
    expect(out.rows[0].parentContent!.length).toBeLessThanOrEqual(160)
    expect(wholeRowReads).toEqual([])
  })

  it('takes no group from another workspace when sync moves sources before the grouping walk', async () => {
    await create({id: TARGET, content: 'Target', properties: {alias: ['Target']}})
    const movers = [uuid('5200000a', 1), uuid('5200000b', 2)]
    for (const id of movers) {
      await create({id, content: `mention of [[Target]] ${id.slice(0, 8)}`, references: [{id: TARGET, alias: 'Target'}]})
    }
    const foreignRoot = uuid('5200000c', 3)
    await repo.tx(async tx => {
      await tx.create({id: foreignRoot, workspaceId: 'ws-2', parentId: null, orderKey: 'a0', content: 'Foreign root', references: []})
    }, {scope: ChangeScope.BlockDefault, allowUnloadedWorkspace: true})
    let fired = false
    const out = await duringReads({
      before: async sql => {
        if (fired || !sql.includes('ancestor_chain(source_id')) return
        fired = true
        for (const id of movers) {
          await sharedDb.db.execute('UPDATE blocks SET workspace_id = ?, parent_id = ? WHERE id = ?', ['ws-2', foreignRoot, id])
        }
      },
    }, () => view<GroupedBacklinksView>({type: 'view-grouped-backlinks', ref: TARGET, format: 'json'}))
    expect(fired).toBe(true)
    expect(out.groups.map(group => group.label)).not.toContain('Foreign root')
  })

  it('drops a source that leaves the workspace between being listed and being read', async () => {
    await create({id: TARGET, content: 'Target', properties: {alias: ['Target']}})
    const mover = uuid('5100000a', 1)
    const stayer = uuid('5100000b', 2)
    for (const id of [mover, stayer]) {
      await create({id, content: `mention of [[Target]] ${id.slice(0, 8)}`, references: [{id: TARGET, alias: 'Target'}]})
    }
    // Sync rewrites the mover's workspace once its id is listed, before it is read.
    const moveOnRead = {
      before: async (sql: string, params: unknown) => {
        if (!sql.includes('SELECT b.* FROM json_each') || !String((params as unknown[])[0]).includes(mover)) return
        await sharedDb.db.execute('UPDATE blocks SET workspace_id = ? WHERE id = ?', ['ws-2', mover])
      },
    }
    const flat = await duringReads(moveOnRead, () => view<BacklinksView>({type: 'view-backlinks', ref: TARGET, format: 'json'}))
    await sharedDb.db.execute('UPDATE blocks SET workspace_id = ? WHERE id = ?', [WS, mover])
    const grouped = await duringReads(moveOnRead, () =>
      view<GroupedBacklinksView>({type: 'view-grouped-backlinks', ref: TARGET, format: 'json'}))
    expect(flat.rows.map(row => row.id)).toEqual([stayer])
    expect(grouped.groups.flatMap(group => group.members.map(member => member.id))).toEqual([stayer])
  })

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
    expect(text).toMatch(/^2\. \^/m)
    const second = await view<string>({type: 'view-backlinks', ref: TARGET, limit: 2, offset: 2})
    expect(second).toMatch(/^3\. \^/m)
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
  it('says where each folded duplicate is', async () => {
    const vendors = ['Kestrel', 'Copperline']
    for (const [index, name] of vendors.entries()) {
      const vendor = uuid(`6e00000${index}`, index)
      await create({id: vendor, content: name, properties: {alias: [name]}})
      await create({id: uuid(`6e00001${index}`, 10 + index), parentId: vendor, content: 'status: renewal due'})
    }

    const out = await view<SearchView>({type: 'view-search', query: 'renewal due', format: 'json'})
    expect(out.hits).toHaveLength(1)
    const [hit] = out.hits
    expect([hit.breadcrumb.at(-1), hit.duplicates[0].place].sort()).toEqual(['Copperline', 'Kestrel'])
    const text = await view<string>({type: 'view-search', query: 'renewal due'})
    expect(text).toContain(`identical: ^${hit.duplicates[0].shortId} in ${hit.duplicates[0].place})`)
  })

  it('takes no label from another workspace, so a line under one folds and shows no siblings', async () => {
    const foreign = uuid('6c100001', 1)
    await repo.tx(async tx => {
      await tx.create({id: foreign, workspaceId: 'ws-2', parentId: null, orderKey: 'a0', content: '[[Meeting]]', references: []})
    }, {scope: ChangeScope.BlockDefault, allowUnloadedWorkspace: true})
    const strayLine = uuid('6c100002', 2)
    await create({id: strayLine, content: 'with the kestrel account team'})
    await create({id: uuid('6c100003', 3), content: 'with the kestrel account team'})
    const straySibling = uuid('6c100004', 4)
    await create({id: straySibling, content: 'topic: renewal terms'})
    // Sync applies parent ids verbatim, so a row can point at a parent in another workspace.
    await sharedDb.db.execute('UPDATE blocks SET parent_id = ? WHERE id IN (?, ?)', [foreign, strayLine, straySibling])

    const out = await view<SearchView>({type: 'view-search', query: 'kestrel account', format: 'json'})
    expect(out.hits).toHaveLength(1)
    expect(out.hits[0].duplicateCount).toBe(1)
    expect(out.hits[0]).not.toHaveProperty('siblings')
  })

  it('takes no label from a property field row, so property values fold', async () => {
    const definition = uuid('6c300000', 0)
    for (const [index, owner] of ['Kestrel', 'Copperline'].entries()) {
      const page = uuid(`6c30001${index}`, 10 + index)
      await create({id: page, content: owner, properties: {alias: [owner]}})
      const field = uuid(`6c30002${index}`, 20 + index)
      await create({id: field, parentId: page, content: `::((${definition}))`})
      await create({id: uuid(`6c30003${index}`, 30 + index), parentId: field, content: 'renewal due'})
      await create({id: uuid(`6c30004${index}`, 40 + index), parentId: field, content: 'second value'})
    }
    // A raw write: the field-form bit is derived, and no processor runs here to stamp it.
    await sharedDb.db.execute("UPDATE blocks SET is_field_form = 1 WHERE content LIKE '::((%'")

    const out = await view<SearchView>({type: 'view-search', query: 'renewal due', format: 'json'})
    expect(out.hits).toHaveLength(1)
    expect(out.hits[0].duplicateCount).toBe(1)
    expect(out.hits[0]).not.toHaveProperty('siblings')
  })

  it('reads no long parent\'s content to judge whether it is a label', async () => {
    const parent = uuid('6c600000', 0)
    await create({id: parent, content: `${'#tag '.repeat(10)}${'x'.repeat(100_000)}`})
    await create({id: uuid('6c600001', 1), parentId: parent, content: 'needle line'})
    // SQLite's text length() and substr() stop at a NUL; the rest still counts.
    const nulTailed = uuid('6c600002', 2)
    await create({id: nulTailed, content: `[[Meeting]]\u0000${'y'.repeat(100_000)}`})
    await create({id: uuid('6c600003', 3), parentId: nulTailed, content: 'needle again'})

    const getAll = vi.spyOn(repo.db, 'getAll')
    await view({type: 'view-search', query: 'needle'})
    const sizes = await Promise.all(getAll.mock.results.map(async result => JSON.stringify(await result.value).length))
    getAll.mockRestore()
    expect(Math.max(...sizes)).toBeLessThan(100_000)
  })

  it('reads a tag link or a block ref as a label', async () => {
    const target = uuid('7b7b7b7b', 1)
    await create({id: target, content: 'Target', properties: {alias: ['Target']}})
    const labels = [uuid('6b100001', 1), uuid('6b100002', 2)]
    await create({id: labels[0], content: '#[[Meeting]]'})
    await create({id: labels[1], content: `((${target}))`})
    for (const [index, label] of labels.entries()) {
      await create({id: uuid(`6b10001${index}`, 10 + index), parentId: label, content: `line ${index} of [[Target]]`, references: [{id: target, alias: 'Target'}]})
      await create({id: uuid(`6b10002${index}`, 20 + index), parentId: label, content: `topic ${index}`})
    }

    const out = await view<BacklinksView>({type: 'view-backlinks', ref: target, format: 'json'})
    expect(out.rows.filter(row => row.content.startsWith('line ')).map(row => row.siblings).sort())
      .toEqual([['topic 0'], ['topic 1']])
  })

  it('keeps a breadcrumb step that is literally named …', async () => {
    const page = uuid('6c700000', 0)
    await create({id: page, content: 'Projects', properties: {alias: ['Projects']}})
    for (const index of [1, 2]) {
      const section = uuid(`6c70000${index}`, index)
      await create({id: section, parentId: page, content: '…'})
      await create({id: uuid(`6c70001${index}`, 10 + index), parentId: section, content: 'ellipsis notes'})
    }

    const out = await view<SearchView>({type: 'view-search', query: 'ellipsis', format: 'json'})
    expect(out.hits[0].duplicates.map(duplicate => duplicate.place)).toEqual(['Projects › …'])
  })

  it('names a duplicate\'s place by the last two steps of its breadcrumb', async () => {
    const page = uuid('6c500000', 0)
    await create({id: page, content: 'Projects', properties: {alias: ['Projects']}})
    for (const [index, section] of ['Alpha', 'Beta'].entries()) {
      const heading = uuid(`6c50000${index + 1}`, index + 1)
      await create({id: heading, parentId: page, content: section})
      await create({id: uuid(`6c50001${index}`, 10 + index), parentId: heading, content: 'kickoff notes'})
    }

    const out = await view<SearchView>({type: 'view-search', query: 'kickoff', format: 'json'})
    expect(out.hits[0].duplicates.map(duplicate => duplicate.place)).toEqual([
      out.hits[0].breadcrumb.join(' › ') === 'Projects › Alpha' ? 'Projects › Beta' : 'Projects › Alpha',
    ])
  })

  it('gives a duplicate whose breadcrumb could not be read no place', async () => {
    const page = uuid('6c400000', 0)
    await create({id: page, content: 'Archive', properties: {alias: ['Archive']}})
    for (const index of [1, 2]) {
      const mid = uuid(`6c40000${index}`, index)
      await create({id: mid, parentId: page, content: `section ${index}`})
      await create({id: uuid(`6c40001${index}`, 10 + index), parentId: mid, content: 'zebra crossing'})
    }
    // Tombstoned with no cascade, as sync can leave a chain.
    await sharedDb.db.execute('UPDATE blocks SET deleted = 1 WHERE id IN (?, ?)', [uuid('6c400001', 1), uuid('6c400002', 2)])

    const out = await view<SearchView>({type: 'view-search', query: 'zebra', format: 'json'})
    expect(out.hits[0].breadcrumb).toEqual(['…'])
    expect(out.hits[0].duplicates.map(duplicate => duplicate.place)).toEqual([null])
  })

  it('folds a record line only with its own record, whatever the text holds', async () => {
    const meeting = uuid('6c200001', 1)
    await create({id: meeting, content: '[[Meeting]]'})
    await create({id: uuid('6c200002', 2), parentId: meeting, content: 'kestrel line'})
    // Content built to match a record line's grouping key, were it a joined string.
    await create({id: uuid('6c200003', 3), content: `${meeting}\u0000kestrel line`})

    const out = await view<SearchView>({type: 'view-search', query: 'kestrel', format: 'json'})
    expect(out.hits).toHaveLength(2)
    expect(out.hits.map(hit => hit.duplicateCount)).toEqual([0, 0])
  })

  it('keeps identical lines of different records apart, each with its record', async () => {
    const days = [uuid('6c000001', 1), uuid('6c000002', 2)]
    for (const [index, day] of days.entries()) {
      await create({id: day, content: `June ${index + 4}th, 2026`})
      const meeting = uuid(`6c00001${index}`, 10 + index)
      await create({id: meeting, parentId: day, content: '[[Meeting]]'})
      await create({id: uuid(`6c00002${index}`, 20 + index), parentId: meeting, content: 'with the kestrel account team'})
      await create({id: uuid(`6c00003${index}`, 30 + index), parentId: meeting, content: index === 0 ? 'topic: renewal terms' : 'topic: pricing tiers'})
    }

    const out = await view<SearchView>({type: 'view-search', query: 'kestrel account', format: 'json'})
    expect(out.hits).toHaveLength(2)
    expect(out.hits.map(hit => hit.duplicateCount)).toEqual([0, 0])
    expect(out.hits.map(hit => hit.siblings).sort()).toEqual([['topic: pricing tiers'], ['topic: renewal terms']])
    const text = await view<string>({type: 'view-search', query: 'kestrel account'})
    expect(text).toContain('   ↳ sibling: topic: pricing tiers')
  })

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
    expect(split.duplicates).toHaveLength(1)
    expect(out.nextOffset).toBeNull()

    const firstPage = await view<SearchView>({type: 'view-search', query: 'banana', limit: 1, format: 'json'})
    expect(firstPage.nextOffset).toBe(1)
  })

  it('reads breadcrumb ancestors as bounded projections, never whole rows', async () => {
    const page = uuid('cdcd0000', 1)
    await create({
      id: page,
      content: `${' '.repeat(300)}Imported archive ${'x'.repeat(5000)}`,
      properties: {'importer:payload': 'y'.repeat(100_000)},
    })
    const mid = uuid('cdcd0001', 2)
    await create({id: mid, parentId: page, content: 'Notes'})
    // A raw write can leave a non-list alias, which names nothing in the panel either.
    await sharedDb.db.execute(
      `UPDATE blocks SET properties_json = json_set(properties_json, '$.alias', 'Scalar') WHERE id = ?`,
      [mid],
    )
    for (let i = 0; i < 3; i++) await create({id: uuid('cdcd0002', 3 + i), parentId: mid, content: `kiwi ${i}`})

    const getAll = vi.spyOn(repo.db, 'getAll')
    const out = await view<SearchView>({type: 'view-search', query: 'kiwi', format: 'json'})
    const statements = getAll.mock.calls.map(call => call[0])
    getAll.mockRestore()
    expect(out.hits).toHaveLength(3)
    for (const hit of out.hits) {
      expect(hit.breadcrumb[0]).toMatch(/^Imported archive x+…$/)
      expect(hit.breadcrumb[1]).toBe('Notes')
    }
    expect(statements.filter(sql => /\b(parent|blocks)\.\*/.test(sql))).toEqual([])
  })

  it('marks a breadcrumb cut where an ancestor is deleted between the walk and the read', async () => {
    const page = uuid('cece0000', 1)
    await create({id: page, content: 'Live page', properties: {alias: ['Live page']}})
    const mid = uuid('cece0001', 2)
    await create({id: mid, parentId: page, content: 'Soon deleted'})
    await create({id: uuid('cece0002', 3), parentId: mid, content: 'kiwi'})
    const out = await duringReads({
      after: async sql => {
        if (!sql.includes('WITH RECURSIVE chain(start_id')) return
        await sharedDb.db.execute('UPDATE blocks SET deleted = 1 WHERE id = ?', [mid])
      },
    }, () => view<SearchView>({type: 'view-search', query: 'kiwi', format: 'json'}))
    expect(out.hits[0].breadcrumb).toEqual(['…'])
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
    expect(out.hits[0].duplicates).toHaveLength(5)
    const text = await view<string>({type: 'view-search', query: 'banana'})
    expect(text).toMatch(/\(\+109 identical: (\^[^;]+; ){5}…\+104 more\)/)
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

  it('refuses a raw read of a block outside the workspace the call names', async () => {
    await knownWorkspace(WS)
    await create({id: uuid('e3e3e3e3', 2), content: 'here'})
    const foreign = uuid('e3e3e3e3', 1)
    await repo.tx(async tx => {
      await tx.create({id: foreign, workspaceId: 'ws-2', parentId: null, orderKey: 'a0', content: 'elsewhere', references: []})
    }, {scope: ChangeScope.BlockDefault, allowUnloadedWorkspace: true})
    await expect(executeCommand({commandId: 'r', type: 'get-block', id: foreign, workspaceId: WS}, context))
      .rejects.toThrow(/is in workspace ws-2, not ws-1/)
    await expect(executeCommand({commandId: 'r', type: 'get-subtree', rootId: foreign, workspaceId: WS}, context))
      .rejects.toThrow(/is in workspace ws-2, not ws-1/)
    // Naming no workspace, a raw read by id reaches any of the user's.
    expect((await executeCommand({commandId: 'r', type: 'get-block', id: foreign}, context) as {id: string}).id).toBe(foreign)
  })

  it('resolves a ref in the workspace the call names', async () => {
    await knownWorkspace('ws-2')
    const here = uuid('e1e1e1e1', 1)
    const there = uuid('e2e2e2e2', 2)
    await create({id: here, content: 'Shared name', properties: {alias: ['Shared name']}})
    await repo.tx(async tx => {
      await tx.create({
        id: there, workspaceId: 'ws-2', parentId: null, orderKey: 'a0',
        content: 'Shared name', properties: {alias: ['Shared name']}, references: [],
      })
    }, {scope: ChangeScope.BlockDefault, allowUnloadedWorkspace: true})
    const named = {commandId: 'r', id: 'Shared name', rootId: 'Shared name', workspaceId: 'ws-2'}
    expect((await executeCommand({...named, type: 'get-block'}, context) as {id: string}).id).toBe(there)
    expect((await executeCommand({...named, type: 'get-subtree'}, context) as Array<{id: string}>)[0].id).toBe(there)
    expect((await executeCommand({commandId: 'r', type: 'get-block', id: 'Shared name'}, context) as {id: string}).id)
      .toBe(here)
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
