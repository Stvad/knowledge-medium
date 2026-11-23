// @vitest-environment node
//
// What the agent views show of a block's references: embeds expanded into
// subtree rows, and each plain `((id))` followed by its target's text.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type BlockReference, type NewBlockData } from '@/data/api'
import type { BlockProperties } from '@/types.js'
import { isCollapsedProp } from '@/data/properties.js'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { type Repo } from '@/data/repo'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { backlinksDataExtension } from '@/plugins/backlinks/dataExtension'
import { groupedBacklinksDataExtension } from '@/plugins/grouped-backlinks/dataExtension'
import { executeCommand } from '../commands'
import { createTestAgentContext } from './createTestAgentContext'
import type { AgentRuntimeContext } from '../protocol'
import type { MemoryIndexView } from '@knowledge-medium/agent-cli/protocol'
import type { OutlineView } from '../agentViews/outline'
import type { BlockView } from '../agentViews/block'
import type { BacklinksView } from '../agentViews/backlinks'
import type { SearchView } from '../agentViews/search'
import { contentMarks } from '../agentViews/refs'

const WS = 'ws-1'
const USER = {id: 'user-1', name: 'Alice'}
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
  context = createTestAgentContext(repo, WS, [kernelDataExtension, backlinksDataExtension, groupedBacklinksDataExtension])
})

let orderCounter = 0
interface NewBlock {
  id: string
  content?: string
  parentId?: string | null
  properties?: BlockProperties
  workspaceId?: string
  references?: BlockReference[]
}
const createAll = async (blocks: readonly NewBlock[]) => {
  await repo.tx(async tx => {
    await tx.createMany(blocks.map((args): NewBlockData => {
      orderCounter += 1
      return {
        id: args.id,
        workspaceId: args.workspaceId ?? WS,
        parentId: args.parentId ?? null,
        orderKey: `k${orderCounter.toString().padStart(6, '0')}`,
        content: args.content ?? args.id,
        references: args.references ?? [],
        ...(args.properties ? {properties: args.properties} : {}),
      }
    }))
  }, {scope: ChangeScope.BlockDefault, allowUnloadedWorkspace: blocks.some(block => block.workspaceId !== undefined)})
}

const view = async <T,>(command: Record<string, unknown>): Promise<T> =>
  await executeCommand({commandId: 'v', ...command} as never, context) as T

const MEMORY_A = uuid('a0000001', 1)
const MEMORY_B = uuid('b0000001', 1)
const SHARED_PAGE = uuid('5a0000ed', 1)
const SHARED = uuid('5a0000ed', 2)
const NOTE_1 = uuid('5a0000ed', 3)
const NOTE_2 = uuid('5a0000ed', 4)
const LOCAL = uuid('a0000001', 2)

/** Two watchers' memory blocks, each embedding one shared block. */
const sharedMemory = async () => {
  await createAll([
    {id: SHARED_PAGE, content: 'Agents'},
    {id: SHARED, content: 'Shared memory', parentId: SHARED_PAGE},
    {id: NOTE_1, content: 'Prefers terse replies', parentId: SHARED},
    {id: NOTE_2, content: 'Lives in Lisbon', parentId: SHARED},
    {id: MEMORY_A, content: 'Memory'},
    {id: uuid('a0000001', 3), content: `!((${SHARED}))`, parentId: MEMORY_A},
    {id: LOCAL, content: 'Only for watcher A', parentId: MEMORY_A},
    {id: MEMORY_B, content: 'Memory'},
    {id: uuid('b0000001', 2), content: `!((${SHARED}))`, parentId: MEMORY_B},
  ])
}

describe('contentMarks', () => {
  it('reads plain refs, embeds and page embeds, but not labelled refs or page links', () => {
    const id = uuid('c0000001', 1)
    const labelled = uuid('c0000001', 3)
    expect(contentMarks(`a ((${id})) b !((${id})) [label](((${labelled}))) [[Page]] ![[Shared]] ((${id}))`)).toEqual([
      {kind: 'ref', id},
      {kind: 'embed', id},
      {kind: 'page-embed', alias: 'Shared'},
    ])
  })

  it('leaves out references inside code, which the renderer shows as text', () => {
    const id = uuid('c0000001', 4)
    expect(contentMarks(`\`![[Shared]]\` and \`((${id}))\`\n\n\`\`\`\n!((${id}))\n\`\`\``)).toEqual([])
    expect(contentMarks(`>     ![[Shared]]\n\n-     ((${id}))`)).toEqual([])
    expect(contentMarks(`\`code\` then ((${id}))`)).toEqual([{kind: 'ref', id}])
  })

  it('reads an empty-label ref as a plain one, as the renderer shows it', () => {
    const id = uuid('c0000001', 2)
    expect(contentMarks(`[](((${id})))`)).toEqual([{kind: 'ref', id}])
  })
})

describe('memory index', () => {
  const ROOT = uuid('d0000000', 1)

  it('shows only note summaries, including direct block embeds and the notes on an embedded page', async () => {
    await sharedMemory()
    const host = uuid('a0000001', 4)
    await createAll([
      {id: host, content: '![[Guide]]', parentId: MEMORY_A},
      {id: ROOT, content: 'Guide', properties: {alias: ['Guide']}},
      {id: uuid('c0000001', 2), parentId: ROOT, content: 'Review checklist'},
      {id: uuid('c0000001', 3), parentId: uuid('c0000001', 2), content: 'Checklist detail'},
      {id: uuid('a0000001', 5), parentId: LOCAL, content: 'Private detail'},
    ])
    const index = await view<MemoryIndexView>({type: 'view-memory-index', ref: MEMORY_A, format: 'json'})
    expect(index.sharedRoots).toEqual([SHARED, ROOT])
    expect(index.text.split('\n')).toEqual([
      `- [shared] Shared memory (+2 children) ^${SHARED}`,
      `- Only for watcher A (+1 child) ^${LOCAL}`,
      `- [shared] Review checklist (+1 child) ^${uuid('c0000001', 2)}`,
    ])
    expect(await view({type: 'view-memory-index', ref: '[[Guide]]'}))
      .toBe(`- Review checklist (+1 child) ^${uuid('c0000001', 2)}`)
  })

  it('keeps a host with its own details or prose, and leaves unresolved embeds visible', async () => {
    const annotated = uuid('d0000001', 2)
    const prose = uuid('d0000001', 3)
    const missing = uuid('d0000001', 4)
    await createAll([
      {id: ROOT, content: 'Index'},
      {id: annotated, parentId: ROOT, content: `!((${SHARED}))`},
      {id: LOCAL, parentId: annotated, content: 'Hidden detail'},
      {id: prose, parentId: ROOT, content: `Read !((${SHARED})) before replying`},
      {id: SHARED, parentId: ROOT, content: 'Also a direct child'},
      {id: missing, parentId: ROOT, content: '![[Missing page]]'},
    ])
    const index = await view<MemoryIndexView>({type: 'view-memory-index', ref: ROOT, format: 'json'})
    expect(index.text.split('\n')).toEqual([
      `- !((${SHARED})) (+1 child) ^${annotated}`,
      `- [shared] Also a direct child ^${SHARED}`,
      `- Read !((${SHARED})) before replying ^${prose}`,
      `- ![[Missing page]] ^${missing}`,
    ])
  })

  it('keeps deleted, foreign and self embeds out of the shared comparison scope', async () => {
    const foreign = uuid('f0000001', 1)
    await createAll([
      {id: ROOT, content: 'Index'},
      {id: LOCAL, parentId: ROOT, content: `!((${foreign})) !((${ROOT})) !((${NOTE_1}))`},
      {id: NOTE_1, content: 'Deleted summary'},
    ])
    await createAll([{id: foreign, workspaceId: 'ws-2', content: 'Foreign summary'}])
    await sharedDb.db.execute('UPDATE blocks SET deleted = 1 WHERE id = ?', [NOTE_1])
    const index = await view<MemoryIndexView>({type: 'view-memory-index', ref: ROOT, format: 'json'})
    expect(index.sharedRoots).toEqual([])
    expect(index.text).toBe(`- !((${foreign})) !((${ROOT})) !((${NOTE_1})) ^${LOCAL}`)
  })

  it('spends the budget on unique notes in outline order and identifies every omission', async () => {
    const notes = Array.from({length: 102}, (_, i) => ({id: uuid('c0000001', i), content: `Summary ${i}`, parentId: ROOT}))
    await createAll([
      {id: ROOT, content: 'Guide', properties: {alias: ['Guide']}},
      {id: MEMORY_A, content: 'Memory'},
      {id: LOCAL, content: '![[Guide]]', parentId: MEMORY_A},
      {id: MEMORY_B, content: '![[Guide]]', parentId: MEMORY_A},
      ...notes,
    ])
    const index = await view<MemoryIndexView>({type: 'view-memory-index', ref: MEMORY_A, format: 'json'})
    expect(index.sharedRoots).toEqual([ROOT])
    const lines = index.text.split('\n')
    expect(lines.slice(0, -1)).toEqual(notes.slice(0, 100).map(note => `- [shared] ${note.content} ^${note.id}`))
    expect(lines.at(-1)).toBe(`Showing 100 of 102 notes. Omitted note IDs: [shared] ^${notes[100].id}, [shared] ^${notes[101].id}`)
  })
})

describe('subtree expands embeds', () => {
  it("shows the embedded block's subtree under the embedding row, with the blocks' own ids", async () => {
    await sharedMemory()
    const host = uuid('a0000001', 3)
    for (const memory of [MEMORY_A, MEMORY_B]) {
      const outline = await view<OutlineView>({type: 'view-outline', ref: memory, format: 'json'})
      const shared = outline.rows.find(row => row.id === SHARED)
      expect(shared?.embedded).toEqual({parentId: SHARED_PAGE, breadcrumb: ['Agents']})
      expect(outline.rows.filter(row => row.parentId === SHARED).map(row => row.content))
        .toEqual(['Prefers terse replies', 'Lives in Lisbon'])
      // The host's note leaves out the embed it shows as rows.
      expect(outline.rows.find(row => row.content === `!((${SHARED}))`)?.refs).toEqual([])
      expect(shared?.parentId).not.toBe(SHARED_PAGE)
      if (memory === MEMORY_A) expect(shared?.parentId).toBe(host)
    }
    const text = await view<string>({type: 'view-outline', ref: MEMORY_A})
    expect(text).toContain(`  - Shared memory  ^${SHARED}\n    ↳ embedded; lives in: Agents\n    - Prefers terse replies  ^${NOTE_1}`)
    expect(text).toContain('↳ embedded = the row above embeds this block')
  })

  it("does not count embedded rows as the host's children", async () => {
    await sharedMemory()
    const outline = await view<OutlineView>({type: 'view-outline', ref: MEMORY_A, depth: 1, format: 'json'})
    // Depth 1 shows the root's two children and the root has no embeds of its own.
    expect(outline.rows.map(row => row.id)).toEqual([uuid('a0000001', 3), LOCAL])
    expect(outline.root.childCount).toBe(2)
    expect(outline.nextOffset).toBeNull()
    const deeper = await view<OutlineView>({type: 'view-outline', ref: MEMORY_A, depth: 2, format: 'json'})
    const host = deeper.rows.find(row => row.id === uuid('a0000001', 3))!
    expect(host.childCount).toBe(0)
    expect(host.hiddenChildren).toBe(0)
  })

  it("expands the root's own embeds, before its children, on the first page only", async () => {
    const root = uuid('d0000001', 1)
    await createAll([
      {id: SHARED, content: 'Shared memory'},
      {id: NOTE_1, content: 'Prefers terse replies', parentId: SHARED},
      {id: root, content: `Memory !((${SHARED}))`},
      {id: uuid('d0000001', 2), content: 'first child', parentId: root},
      {id: uuid('d0000001', 3), content: 'second child', parentId: root},
    ])
    const first = await view<OutlineView>({type: 'view-outline', ref: root, limit: 3, format: 'json'})
    // The embed takes one of the three blocks, before the children; its own child is past the limit.
    expect(first.rows.map(row => row.content)).toEqual(['Shared memory', 'first child', 'second child'])
    expect(first.root.refs).toEqual([])
    expect(first.root.childCount).toBe(2)
    expect(first.nextOffset).toBeNull()
    const next = await view<OutlineView>({type: 'view-outline', ref: root, offset: 1, format: 'json'})
    expect(next.rows.map(row => row.content)).toEqual(['second child'])
  })

  it("reads the root's children before its embeds, so paging always moves forward", async () => {
    const root = uuid('d1000001', 1)
    await createAll([
      {id: SHARED, content: 'Shared memory'},
      {id: root, content: `Memory !((${SHARED}))`},
      {id: uuid('d1000001', 2), content: 'first child', parentId: root},
      {id: uuid('d1000001', 3), content: 'second child', parentId: root},
    ])
    const page = await view<OutlineView>({type: 'view-outline', ref: root, limit: 1, format: 'json'})
    expect(page.rows.map(row => row.content)).toEqual(['first child'])
    expect(page.nextOffset).toBe(1)
    // The embed the budget left out is noted instead.
    expect(page.root.refs).toEqual([{kind: 'embed', id: SHARED, preview: 'Shared memory'}])
  })

  it('places a block among its own siblings before any embed of it at the same level', async () => {
    const root = uuid('d2000001', 1)
    const child = uuid('d2000001', 2)
    await createAll([
      {id: root, content: `Root !((${child}))`},
      {id: child, content: 'own child', parentId: root},
      {id: uuid('d2000001', 3), content: 'sibling', parentId: root},
    ])
    const outline = await view<OutlineView>({type: 'view-outline', ref: root, format: 'json'})
    expect(outline.rows.map(row => [row.content, row.embedded === undefined])).toEqual([['own child', true], ['sibling', true]])
    expect(outline.nextOffset).toBeNull()
  })

  it("counts a child an earlier level's embed shows as hidden under its own parent", async () => {
    const root = uuid('d3000001', 1)
    const parent = uuid('d3000001', 3)
    const middle = uuid('d3000001', 4)
    const deep = uuid('d3000001', 5)
    await createAll([
      {id: root, content: 'Root'},
      {id: uuid('d3000001', 2), content: `!((${deep}))`, parentId: root},
      {id: parent, content: 'parent', parentId: root},
      {id: middle, content: 'middle', parentId: parent},
      {id: deep, content: 'deep', parentId: middle},
    ])
    const outline = await view<OutlineView>({type: 'view-outline', ref: root, format: 'json'})
    expect(outline.rows.find(row => row.id === deep)?.embedded).toBeDefined()
    expect(outline.rows.find(row => row.id === middle)?.hiddenChildren).toBe(1)
  })

  it('reads only the embed targets the budget can show', async () => {
    const root = uuid('d4000001', 1)
    const targets = Array.from({length: 40}, (_, n) => uuid('d4000002', n + 1))
    await createAll([
      ...targets.map(id => ({id, content: `t ${id}`})),
      {id: root, content: targets.map(id => `!((${id}))`).join(' ')},
    ])
    const target = sharedDb.db
    const original = Object.getPrototypeOf(target).getAll as typeof target.getAll
    const loaded: string[] = []
    const spy = vi.spyOn(repo.db, 'getAll').mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT b.* FROM json_each(?)')) loaded.push(...JSON.parse(String(params?.[0])) as string[])
      return await original.call(target, sql, params)
    })
    try {
      const outline = await view<OutlineView>({type: 'view-outline', ref: root, limit: 3, format: 'json'})
      expect(outline.rows).toHaveLength(3)
    } finally {
      spy.mockRestore()
    }
    expect(loaded.filter(id => targets.includes(id))).toEqual(targets.slice(0, 3))
  })

  it('expands a page embed by the page name', async () => {
    const page = uuid('e0000001', 1)
    const host = uuid('e0000001', 2)
    await createAll([
      {id: page, content: 'Shared', properties: {alias: ['Shared']}},
      {id: uuid('e0000001', 3), content: 'a shared note', parentId: page},
      {id: host, content: 'Memory'},
      {id: uuid('e0000001', 4), content: '![[Shared]]', parentId: host},
    ])
    const outline = await view<OutlineView>({type: 'view-outline', ref: host, format: 'json'})
    expect(outline.rows.map(row => [row.content, row.depth])).toEqual([
      ['![[Shared]]', 1], ['Shared', 2], ['a shared note', 3],
    ])
  })

  it('gives a block one row: an embed of an ancestor is left to the note', async () => {
    const root = uuid('f0000001', 1)
    const loop = uuid('f0000001', 2)
    await createAll([
      {id: root, content: 'Root'},
      {id: loop, content: `!((${root}))`, parentId: root},
    ])
    const outline = await view<OutlineView>({type: 'view-outline', ref: root, depth: 5, format: 'json'})
    expect(outline.rows.map(row => row.id)).toEqual([loop])
    expect(outline.rows[0].refs).toEqual([{kind: 'embed', id: root, preview: 'Root'}])
  })

  it('embeds under a collapsed block still expand, as the app shows them in its content', async () => {
    const root = uuid('f1000001', 1)
    const host = uuid('f1000001', 2)
    await createAll([
      {id: SHARED, content: 'Shared memory'},
      {id: root, content: 'Root'},
      {id: host, content: `!((${SHARED}))`, parentId: root, properties: {[isCollapsedProp.name]: true}},
      {id: uuid('f1000001', 3), content: 'hidden child', parentId: host},
    ])
    const outline = await view<OutlineView>({type: 'view-outline', ref: root, format: 'json'})
    expect(outline.rows.map(row => row.content)).toEqual([`!((${SHARED}))`, 'Shared memory'])
    expect(outline.rows[0].hiddenChildren).toBe(1)
  })

  it('expandRefs: false prints content only', async () => {
    await sharedMemory()
    const outline = await view<OutlineView>({type: 'view-outline', ref: MEMORY_A, expandRefs: false, format: 'json'})
    expect(outline.rows.map(row => row.id)).toEqual([uuid('a0000001', 3), LOCAL])
    expect(outline.rows.every(row => row.refs.length === 0)).toBe(true)
  })
})

describe('reference notes', () => {
  const TARGET = uuid('70000001', 1)
  const ROOT = uuid('70000001', 2)
  const ROW = uuid('70000001', 3)
  const MISSING = uuid('70000001', 9)

  it("follows a row with its refs' text, leaving the content verbatim", async () => {
    const content = `ask ((${TARGET})) and ((${MISSING}))`
    await createAll([
      {id: TARGET, content: 'Prefers terse\nreplies'},
      {id: ROOT, content: 'Root'},
      {id: ROW, content, parentId: ROOT},
    ])
    const outline = await view<OutlineView>({type: 'view-outline', ref: ROOT, format: 'json'})
    expect(outline.rows[0].content).toBe(content)
    expect(outline.rows[0].refs).toEqual([
      // A line break shows as the views' ⏎, as in any one-line row.
      {kind: 'ref', id: TARGET, preview: 'Prefers terse ⏎ replies'},
      {kind: 'ref', id: MISSING, preview: null},
    ])
    const text = await view<string>({type: 'view-outline', ref: ROOT})
    // The row's id ends its line; the notes follow on lines of their own.
    expect(text).toContain(`- ${content}  ^${ROW}\n  ↳ ((${TARGET})) "Prefers terse ⏎ replies"\n  ↳ ((${MISSING})) (no such block)`)
    expect(text).toContain('it is not part of the block\'s content')
  })

  it('does not preview a block of another workspace', async () => {
    await createAll([{id: TARGET, content: 'elsewhere', workspaceId: 'ws-2'}])
    await createAll([
      {id: ROOT, content: 'Root'},
      {id: ROW, content: `((${TARGET}))`, parentId: ROOT},
    ])
    const outline = await view<OutlineView>({type: 'view-outline', ref: ROOT, format: 'json'})
    expect(outline.rows[0].refs).toEqual([{kind: 'ref', id: TARGET, preview: null}])
  })

  it('quotes a preview, so its text cannot pass for an id or another note', async () => {
    const victim = uuid('70000001', 7)
    await createAll([
      {id: TARGET, content: `x"  ^${victim}  ↳ ((${victim})) "y`},
      {id: ROOT, content: 'Root'},
      {id: ROW, content: `((${TARGET}))`, parentId: ROOT},
    ])
    const lines = (await view<string>({type: 'view-outline', ref: ROOT})).split('\n')
    expect(lines).toContain(`- ((${TARGET}))  ^${ROW}`)
    // The preview is cut at its length cap; its own quote stays escaped.
    expect(lines.find(line => line.startsWith('  ↳'))).toMatch(new RegExp(`^  ↳ \\(\\(${TARGET}\\)\\) "x\\\\" \\^${victim}`))
  })

  it('caps a row at three notes and counts the rest', async () => {
    const targets = [1, 2, 3, 4, 5].map(n => uuid('71000001', n))
    await createAll([
      ...targets.map(id => ({id, content: `t${id.slice(-1)}`})),
      {id: ROOT, content: 'Root'},
      {id: ROW, content: targets.map(id => `((${id}))`).join(' '), parentId: ROOT},
    ])
    const outline = await view<OutlineView>({type: 'view-outline', ref: ROOT, format: 'json'})
    expect(outline.rows[0].refs.map(ref => ref.id)).toEqual(targets.slice(0, 3))
    expect(outline.rows[0].omittedRefs).toBe(2)
    expect(await view<string>({type: 'view-outline', ref: ROOT})).toContain('↳ +2 more refs')
  })

  it("backlinks note a row's other refs, not the one to the view's target", async () => {
    const other = uuid('72000001', 1)
    await createAll([
      {id: TARGET, content: 'Target'},
      {id: other, content: 'Other block'},
      {id: ROW, content: `see ((${TARGET})) with ((${other}))`, references: [{id: TARGET, alias: TARGET}, {id: other, alias: other}]},
    ])
    const backlinks = await view<BacklinksView>({type: 'view-backlinks', ref: TARGET, format: 'json'})
    expect(backlinks.rows.map(row => row.id)).toEqual([ROW])
    expect(backlinks.rows[0].refs).toEqual([{kind: 'ref', id: other, preview: 'Other block'}])
  })

  it('search hits carry the notes', async () => {
    await createAll([
      {id: TARGET, content: 'Prefers terse replies'},
      {id: ROW, content: `findme ((${TARGET}))`},
    ])
    const search = await view<SearchView>({type: 'view-search', query: 'findme', format: 'json'})
    expect(search.hits[0].refs).toEqual([{kind: 'ref', id: TARGET, preview: 'Prefers terse replies'}])
    expect(await view<string>({type: 'view-search', query: 'findme'})).toContain(`↳ ((${TARGET})) "Prefers terse replies"`)
  })

  it('get_block lists what its refs and embeds show', async () => {
    await createAll([
      {id: TARGET, content: 'Prefers terse replies'},
      {id: ROW, content: `!((${TARGET})) and ((${TARGET}))`},
    ])
    const block = await view<BlockView>({type: 'view-block', ref: ROW, format: 'json'})
    expect(block.refs).toEqual([
      {kind: 'embed', id: TARGET, preview: 'Prefers terse replies'},
      {kind: 'ref', id: TARGET, preview: 'Prefers terse replies'},
    ])
    const text = await view<string>({type: 'view-block', ref: ROW})
    expect(text).toContain(`references (not part of the content):\n↳ !((${TARGET})) "Prefers terse replies"`)
    expect((await view<BlockView>({type: 'view-block', ref: ROW, expandRefs: false, format: 'json'})).refs).toEqual([])
  })
})
