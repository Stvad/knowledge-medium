// @vitest-environment happy-dom
/** A table host's drawn members, as the outline's walks read them: its
 *  query's field rows, its grid, then under a query its children the query
 *  does not select, drawn below the grid in the host's own scope. */
import { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { propertyDefinitionBlockId, materializePropertySeeds } from '@/data/definitionSeeds'
import { outlineSurfaceOf } from '@/data/outlineSurface'
import { focusBlock, peekFocusedBlockLocation } from '@/data/properties'
import { armCut, disarmCut, getArmedCut } from '@/paste/armedCut'
import { pasteArmedCut, pasteMultilineText } from '@/paste/operations'
import { getDefaultActions, getDefaultActionGroups } from '@/shortcuts/defaultShortcuts'
import { getVimNormalModeActions } from '@/plugins/vim-normal-mode/actions'
import { ActionContextTypes, type ActionTrigger } from '@/shortcuts/types'
import type { Repo } from '@/data/repo'
import { insertDrawnBlock } from '@/data/structuralInsert'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { drawnChildrenOf } from '@/data/visibleChildren'
import { getBlocksInRange, locationAfterSubtreeRemoval, nextDrawnStep, previousDrawnStep } from '@/utils/selection'
import { tableChildrenViews } from '../childrenViews'
import { GridController } from '../controller'
import { turnIntoTable } from '../convert'
import { tablesDataExtension } from '../dataExtension'
import { openQueryValue } from '../query/queryValue'
import { notesInScope, registerGrid, tableNotesScopeId, tableRenderScopeId } from '../registry'
import { queryProp } from '../schema'

const workspaceId = 'ws-table-children-views'
const options = {scope: ChangeScope.BlockDefault}
const PAGE = 'panel:page'
const TABLE = tableRenderScopeId(PAGE, 'host')
const ROWS = ['row-0', 'row-1']
const grid = (members: readonly string[], order: 'outline' | 'query' = 'outline') => ({
  kind: 'nested-surface', renderScopeId: TABLE, members, order, allowsNewMember: expect.any(Function),
  propertyDisplay: controller.rowsDisplayScope,
})

let db: TestDb
let repo: Repo
let controller: GridController
let releaseGrid: () => void
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
afterEach(() => releaseGrid())
beforeEach(async () => {
  await resetTestDb(db.db)
  await db.db.execute(
    `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time, encryption_mode, properties_migration)
      VALUES (?, 'test', 'test-user', 1, 1, 'none', 'children')`, [workspaceId])
  ;({repo} = createTestRepo({db: db.db, user: {id: 'user-1'}, extensions: [tablesDataExtension, tableChildrenViews]}))
  repo.setActiveWorkspaceId(workspaceId)
  await repo.tx(async tx => {
    await tx.create({id: 'ui', workspaceId, parentId: null, orderKey: 'a0'})
    await tx.create({id: 'page', workspaceId, parentId: null, orderKey: 'b0', content: 'Page'})
    await tx.create({id: 'host', workspaceId, parentId: 'page', orderKey: 'a0', content: 'Table'})
    await tx.create({id: 'after', workspaceId, parentId: 'page', orderKey: 'a1', content: 'After'})
    for (const [index, id] of ROWS.entries()) {
      await tx.create({id, workspaceId, parentId: 'host', orderKey: `a${index}`, content: `Row ${index}`})
    }
  }, options)
  await turnIntoTable(repo, 'host')
  controller = new GridController(repo.block('host'), repo.block('ui'), TABLE, PAGE)
  controller.setRows(ROWS, ROWS.length)
  controller.parentSurface = surface()
  releaseGrid = registerGrid(TABLE, controller)
})

const surface = () => outlineSurfaceOf({scopeRootId: 'page', propertyDisplay: {childBacked: true, workspace: 'none', panel: 'inherit'}, renderScopeId: PAGE})!

/** A query on the host, and two of its children the query does not select. */
const withQuery = async () => {
  await materializePropertySeeds(repo, workspaceId, [queryProp])
  const valueId = await openQueryValue(repo, 'host', propertyDefinitionBlockId(workspaceId, queryProp.seedKey))
  const fieldRowId = (await repo.load(valueId))!.parentId!
  await repo.tx(async tx => {
    await tx.create({id: 'outside-0', workspaceId, parentId: 'host', orderKey: 'a0x', content: 'outside 0'})
    await tx.create({id: 'outside-1', workspaceId, parentId: 'host', orderKey: 'a3', content: 'outside 1'})
  }, options)
  controller.setQuery([])
  return {fieldRowId, valueId}
}

describe('a table host’s drawn members', () => {
  it('without a query: walks the grid’s rows in their own scope and skips its configuration', async () => {
    expect(await drawnChildrenOf(repo.block('host'), surface())).toEqual([grid(ROWS)])
    expect(await previousDrawnStep(repo.block('after'), surface())).toMatchObject({block: {id: 'row-1'}, surface: {renderScopeId: TABLE}, crossed: true})
  })

  it('keeps a row walk bounded until its enclosing surface is available', async () => {
    const row = repo.block('row-0')
    const rowSurface = controller.rowSurface(row.id)
    expect((await previousDrawnStep(row, rowSurface)).block?.id).toBe('host')
    controller.setSurfaces(controller.rowsDisplayScope, null)
    expect((await previousDrawnStep(row, rowSurface)).block).toBeNull()
  })

  it('without a query, a child the grid does not draw (past its cap) is no child outside a query', async () => {
    controller.setRows(['row-0'], ROWS.length)
    expect(await drawnChildrenOf(repo.block('host'), surface())).toEqual([grid(['row-0'])])
  })

  it('refuses to split a retained grid row after it leaves the host', async () => {
    const row = repo.block('row-0')
    await repo.mutate.move({id: row.id, parentId: 'after', position: {kind: 'last'}})
    expect(controller.isRow(row.id)).toBe(true)

    const result = await insertDrawnBlock(row, controller.rowSurface(row.id), {
      kind: 'split', write: (_placement, commit) => commit('Row ', '0'),
    })

    expect(result).toBeNull()
    expect(await repo.query.childIds({id: 'after', propertyChildren: 'none'}).load()).toEqual([row.id])
    expect(row.peek()?.content).toBe('Row 0')
  })

  it.each([
    {name: 'plain', rows: ROWS, sorted: false},
    {name: 'sorted', rows: [...ROWS].reverse(), sorted: true},
  ])('passes an outline selection over the $name grid and refuses a grid-row endpoint', async ({rows, sorted}) => {
    controller.setSorted(sorted)
    controller.setRows(rows, rows.length)
    expect(await getBlocksInRange('host', rows[0]!, surface(), repo, TABLE)).toEqual([])
    expect(await getBlocksInRange('host', 'after', surface(), repo, PAGE)).toEqual(['host', 'after'])
  })

  it('under a query: its field row, the grid, then its children outside the query', async () => {
    const {fieldRowId} = await withQuery()
    expect(await drawnChildrenOf(repo.block('host'), surface())).toEqual([fieldRowId, grid(ROWS, 'query'), 'outside-0', 'outside-1'])
    expect(await nextDrawnStep(repo.block('outside-0'), surface())).toMatchObject({block: {id: 'outside-1'}, crossed: false})
    expect(await previousDrawnStep(repo.block('after'), surface())).toMatchObject({block: {id: 'outside-1'}, crossed: false})
    expect(await previousDrawnStep(repo.block('outside-0'), surface())).toMatchObject({block: {id: 'row-1'}, surface: {renderScopeId: TABLE}, crossed: true})
  })
})

it('releases the notes scope when the grid stops drawing query results', () => {
  const rowId = 'row-0'
  const scope = tableNotesScopeId(TABLE, rowId)
  expect(notesInScope(scope)).toBeUndefined()

  controller.setQuery([])
  expect(notesInScope(scope)).toEqual({grid: controller, rowId})
  controller.setQuery(null)
  expect(notesInScope(scope)).toBeUndefined()
})

it('walks from an unmounted query note through its declared row owner', async () => {
  await withQuery()
  await repo.tx(tx => tx.create({id: 'note', workspaceId, parentId: 'row-0', orderKey: 'a0', content: 'A note'}), options)
  const notesScope = tableNotesScopeId(TABLE, 'row-0')
  const notes = {...controller.rowSurface('row-0'), renderScopeId: notesScope}
  expect(await previousDrawnStep(repo.block('note'), notes))
    .toMatchObject({block: {id: 'row-0'}, surface: {renderScopeId: TABLE}, crossed: true})
  expect(await nextDrawnStep(repo.block('note'), notes))
    .toMatchObject({block: {id: 'row-1'}, surface: {renderScopeId: TABLE}, crossed: true})
})

const withProjectedDescendant = async () => {
  await withQuery()
  await repo.mutate.move({id: 'row-0', parentId: 'outside-1', position: {kind: 'last'}})
  await repo.mutate.move({id: 'outside-0', parentId: 'outside-1', position: {kind: 'last'}})
  controller.setRows(['row-1', 'row-0'], 2)
  const uiStateBlock = repo.block('ui')
  const block = repo.block('outside-1')
  await focusBlock(uiStateBlock, block.id, {renderScopeId: PAGE})
  expect(await previousDrawnStep(block, surface())).toMatchObject({block: {id: 'row-0'}, surface: {renderScopeId: TABLE}})
  return {block, uiStateBlock}
}

it('Delete focuses a surviving grid result when the last outside child contains the last result', async () => {
  const {block, uiStateBlock} = await withProjectedDescendant()
  const action = getDefaultActions({repo}).find(action => action.id === 'delete_block' && action.context === ActionContextTypes.NORMAL_MODE)!
  await action.handler({block, uiStateBlock, ...surface()}, {preventDefault: vi.fn()} as unknown as ActionTrigger)
  expect(await repo.load('outside-1')).toBeNull()
  expect(await repo.load('row-0')).toBeNull()
  expect(await repo.load('row-1')).toBeDefined()
  await vi.waitFor(() => expect(peekFocusedBlockLocation(uiStateBlock)).toEqual({blockId: 'row-1', renderScopeId: TABLE}))
})

it('Cut keeps focus out of the armed subtree when it projects a grid result', async () => {
  const {block, uiStateBlock} = await withProjectedDescendant()
  vi.stubGlobal('ClipboardItem', class {})
  vi.stubGlobal('navigator', {clipboard: {write: vi.fn(async () => {})}})
  try {
    const action = getDefaultActions({repo}).find(action => action.id === 'cut_block' && action.context === ActionContextTypes.NORMAL_MODE)!
    await action.handler({block, uiStateBlock, ...surface()}, {preventDefault: vi.fn()} as unknown as ActionTrigger)
    expect(getArmedCut()).toBeDefined()
    await vi.waitFor(() => expect(peekFocusedBlockLocation(uiStateBlock)).toEqual({blockId: 'row-1', renderScopeId: TABLE}))
  } finally {
    disarmCut()
    vi.unstubAllGlobals()
  }
})

it('removal recovery skips projections of descendants of other selected roots', async () => {
  await withQuery()
  await repo.mutate.move({id: 'row-0', parentId: 'outside-0', position: {kind: 'last'}})
  controller.setRows(['row-1', 'row-0'], 2)
  const landing = await locationAfterSubtreeRemoval(repo.block('outside-1'), surface(), new Set(['outside-0']))
  expect(landing).toMatchObject({block: {id: 'row-1'}, surface: {renderScopeId: TABLE}})
})

it.each([['host', 'after'], ['page', null]] as const)('removal recovery leaves the grid when removing %s', async (removed, expected) => {
  await withQuery()
  const row = repo.block('row-0')
  await repo.mutate.move({id: 'row-1', parentId: 'ui', position: {kind: 'last'}})
  const landing = await locationAfterSubtreeRemoval(
    row, controller.rowSurface(row.id), new Set([removed]),
  )
  expect(landing?.block.id ?? null).toBe(expected)
  if (expected) expect(landing?.surface.renderScopeId).toBe(PAGE)
})

it.each([false, true])('pastes into a grid row’s notes in persisted order (sorted = %s)', async sorted => {
  controller.setSorted(sorted)
  controller.setRows(sorted ? [...ROWS].reverse() : ROWS, ROWS.length)
  await repo.tx(tx => tx.create({id: 'note', workspaceId, parentId: 'row-0', orderKey: 'a0', content: 'Existing note'}), options)
  const row = repo.block('row-0')
  const [first, second] = await pasteMultilineText('First note\nSecond note', row, repo, controller.rowSurface(row.id))

  const realNotes = await repo.query.children({id: row.id, propertyChildren: 'none'}).load()
  expect(realNotes.map(({id, content, parentId}) => [id, content, parentId])).toEqual([
    [first?.id, 'First note', row.id], [second?.id, 'Second note', row.id], ['note', 'Existing note', row.id],
  ])
  const realRows = await repo.query.children({id: 'host', propertyChildren: 'none'}).load()
  expect(realRows.filter(({id}) => ROWS.includes(id)).map(({id, orderKey}) => [id, orderKey]))
    .toEqual([['row-0', 'a0'], ['row-1', 'a1']])
})

it('pastes beside the outline occurrence outside the query and inside the same block’s result occurrence', async () => {
  await withProjectedDescendant()
  const row = repo.block('row-0')
  const [sibling] = await pasteMultilineText('Outline paste', row, repo, surface())
  const [note] = await pasteMultilineText('Result paste', row, repo, {...surface(), renderScopeId: TABLE})

  expect((await repo.query.children({id: 'outside-1', propertyChildren: 'none'}).load()).map(({id}) => id))
    .toEqual(['row-0', sibling?.id, 'outside-0'])
  expect((await repo.load(sibling!.id))?.content).toBe('Outline paste')
  expect((await repo.query.children({id: row.id, propertyChildren: 'none'}).load()).map(({id, content}) => [id, content]))
    .toEqual([[note?.id, 'Result paste']])
})

it('refuses text and armed-cut paste at a vanished result occurrence', async () => {
  await withProjectedDescendant()
  const row = repo.block('row-0')
  const resultSurface = {...surface(), renderScopeId: TABLE}
  controller.setRows(['row-1'], 1)
  await armCut('Cut text', {workspaceId, rootIds: ['after']})
  try {
    expect(await pasteArmedCut('Cut text', row, repo, resultSurface)).toEqual({kind: 'refused'})
    expect(await pasteMultilineText('Stale paste', row, repo, resultSurface)).toHaveLength(0)
    expect((await repo.load('after'))?.parentId).toBe('page')
    expect((await repo.load(row.id))?.parentId).toBe('outside-1')
    expect(getArmedCut()?.rootIds).toEqual(['after'])
  } finally {
    disarmCut()
  }
})

it('keeps text out of a result’s notes after the only note becomes a grid row', async () => {
  await withQuery()
  await repo.tx(tx => tx.create({id: 'note', workspaceId, parentId: 'row-0', orderKey: 'a0', content: 'Note'}), options)
  const notesScope = tableNotesScopeId(TABLE, 'row-0')
  const noteSurface = {...controller.rowSurface('row-0'), renderScopeId: notesScope}
  controller.setRows([...ROWS, 'note'], ROWS.length + 1)
  expect(notesInScope(notesScope)).toBeDefined()

  const pasted = await pasteMultilineText('Stale paste', repo.block('note'), repo, noteSurface)

  expect(pasted).toHaveLength(0)
  expect((await repo.query.children({id: 'row-0', propertyChildren: 'none'}).load()).map(({id, content}) => [id, content]))
    .toEqual([['note', 'Note']])
})

it('selection paste refuses a stale grid result in the focused occurrence', async () => {
  const {uiStateBlock} = await withProjectedDescendant()
  const row = repo.block('row-0')
  await focusBlock(uiStateBlock, row.id, {renderScopeId: TABLE})
  controller.setRows(['row-1'], 1)
  vi.stubGlobal('navigator', {clipboard: {readText: vi.fn(async () => 'Stale paste')}})
  try {
    const action = getDefaultActions({repo}).find(action =>
      action.id === 'paste_after_selection' && action.context === ActionContextTypes.MULTI_SELECT_MODE)!
    await action.handler({uiStateBlock, selectedBlocks: [row], anchorBlock: row, ...surface()},
      {preventDefault: vi.fn()} as unknown as ActionTrigger)

    expect((await repo.query.children({id: 'outside-1', propertyChildren: 'none'}).load()).map(({id}) => id))
      .toEqual(['row-0', 'outside-0'])
    expect(await repo.query.childIds({id: row.id}).load()).toEqual([])
  } finally {
    vi.unstubAllGlobals()
  }
})

type GridMode = 'plain' | 'sorted' | 'query'
type Gesture = 'Enter' | 'split' | 'Tab' | 'Shift-Tab' | 'up' | 'down' | 'Backspace' | 'Delete' | 'above' | 'below'
interface Placement {
  id: string
  parent?: string
  /** Insert before this sibling, or at the end if omitted. */
  before?: string
  after?: string
  /** A merge consumes id and appends its content to into. */
  into?: string
}

const R0 = ROWS[0]!, R1 = ROWS[1]!, R2 = 'last-row'
const newBlock = 'new block'
const at = (id: string, parent: string, before?: string): Placement => ({id, parent, before})
const mergeInto = (id: string, into: string): Placement => ({id, into})
type MatrixCase = readonly [Gesture, string, Placement | null]
function storageCases(mode: GridMode, duplicate: boolean): MatrixCase[] {
  if (duplicate) return [
    ['Enter', R2, at(newBlock, 'middle')], ['split', R2, at(newBlock, 'middle', R2)],
    ['above', R2, at(newBlock, 'middle', R2)], ['below', R2, at(newBlock, 'middle')],
    ['Tab', R2, at(R2, 'C')], ['Shift-Tab', R2, at(R2, R0)], ['up', R2, at(R2, 'middle', 'C')],
    ['down', 'C', at('C', 'middle')], ['Backspace', R2, mergeInto(R2, 'C')], ['Delete', R2, null],
  ]
  const query = mode === 'query'
  const sorted = mode === 'sorted'
  return [
    ['Enter', R2, at(newBlock, 'host')], ['Enter', 'host', at(newBlock, 'host', query ? undefined : sorted ? R1 : R0)],
    ['Enter', R0, at(newBlock, R0, 'A')], ['split', R2, query ? null : at(newBlock, 'host', R2)],
    ['above', R2, at(newBlock, 'host', query ? undefined : R2)], ['below', R2, at(newBlock, 'host')],
    ['Tab', R2, query ? null : at(R2, sorted ? R0 : R1)], ['Shift-Tab', R2, null],
    ['Tab', 'B', at('B', 'A')], ['Shift-Tab', 'A', query ? null : {id: 'A', parent: 'host', after: R0}],
    ['up', 'B', at('B', R0, 'A')], ['down', 'A', at('A', R0, query ? 'middle' : undefined)],
    ['up', R2, mode === 'plain' ? at(R2, 'host', R1) : null],
    ['down', R0, mode === 'plain' ? at(R0, 'host', R2) : null],
    ['Backspace', R2, query ? null : mergeInto(R2, sorted ? 'B' : R1)],
  ]
}

interface StoredRow {id: string; parent_id: string | null; order_key: string; content: string}
const storedRows = () => db.db.getAll<StoredRow>(
  `WITH RECURSIVE ui(id) AS (SELECT 'ui' UNION ALL SELECT b.id FROM blocks b JOIN ui ON b.parent_id = ui.id)
   SELECT id, parent_id, order_key, content FROM blocks
   WHERE workspace_id = ? AND deleted = 0 AND id NOT IN (SELECT id FROM ui)
   ORDER BY parent_id, order_key, id`,
  [workspaceId],
)
function childLists(rows: readonly StoredRow[]): Map<string | null, string[]> {
  const lists = new Map<string | null, string[]>()
  for (const {id, parent_id} of rows) {
    if (!lists.has(parent_id)) lists.set(parent_id, [])
    lists.get(parent_id)!.push(id)
  }
  return lists
}

function expectPlacement(before: StoredRow[], after: StoredRow[], placement: Placement | null, splitAt?: string) {
  if (!placement) { expect(after).toEqual(before); return }
  const ids = new Set(before.map(row => row.id))
  const fresh = after.filter(row => !ids.has(row.id))
  expect(fresh).toHaveLength(placement.id === newBlock ? 1 : 0)
  const id = placement.id === newBlock ? fresh[0]!.id : placement.id
  const changed = new Set([id, placement.into, splitAt])
  expect(after.filter(row => !changed.has(row.id))).toEqual(before.filter(row => !changed.has(row.id)))
  const expected = childLists(before.filter(row => row.id !== id))
  if (placement.parent) {
    const siblings = expected.get(placement.parent) ?? []
    const anchor = placement.before ?? placement.after
    if (anchor !== undefined) expect(siblings).toContain(anchor)
    const index = anchor === undefined ? siblings.length : siblings.indexOf(anchor) + Number(placement.after !== undefined)
    siblings.splice(index, 0, id)
    expected.set(placement.parent, siblings)
  }
  expect(childLists(after)).toEqual(expected)
  const content = (rows: StoredRow[], target: string) => rows.find(row => row.id === target)!.content
  if (placement.into) expect(content(after, placement.into)).toBe(content(before, placement.into) + content(before, id))
  if (splitAt) {
    expect(content(after, id)).toBe(content(before, splitAt).slice(0, 1))
    expect(content(after, splitAt)).toBe(content(before, splitAt).slice(1))
  }
}

describe.each(['plain', 'sorted', 'query', 'duplicate'] as const)('%s grid stored structure', scenario => {
  const duplicate = scenario === 'duplicate'
  const mode = duplicate ? 'query' : scenario
  it.each(storageCases(mode, duplicate))('%s on %s', async (gesture, target, expected) => {
    const query = mode === 'query'
    if (query) await withQuery()
    await repo.tx(async tx => {
      await tx.create({id: 'source', workspaceId, parentId: null, orderKey: 'c0'})
      if (query) {
        await tx.move(R0, {parentId: 'source', orderKey: 'a0'})
        await tx.move(R1, {parentId: 'source', orderKey: 'a1'})
      }
      for (const [index, id] of ['A', 'B', ...(query ? ['middle'] : [])].entries()) {
        await tx.create({id, workspaceId, parentId: R0, orderKey: 'a' + index, content: id})
      }
      if (query) await tx.create({id: 'C', workspaceId, parentId: 'middle', orderKey: 'a0', content: 'C'})
      await tx.create({id: R2, workspaceId, parentId: query ? 'middle' : 'host', orderKey: 'a2', content: 'Final row'})
    }, options)
    controller.setSorted(mode === 'sorted')
    controller.setRows(mode === 'sorted' ? [R1, R0, R2] : [R0, R1, R2], 3)
    const isNote = duplicate || target === 'A' || target === 'B'
    const occurrence = target === 'host' ? surface() : isNote
      ? {...controller.rowSurface(R0), renderScopeId: controller.notesScopeId(R0)} : controller.rowSurface(target)
    const deps = {block: repo.block(target), uiStateBlock: repo.block('ui'), ...occurrence}
    await repo.awaitReprojections()
    const before = await storedRows()
    const trigger = new KeyboardEvent('keydown')
    if (gesture === 'above' || gesture === 'below') {
      const action = getVimNormalModeActions({repo}).find(a => a.id === 'create_block_' + gesture + '_and_edit')!
      await action.handler(deps, trigger)
    } else {
      const id = {Enter: 'split_block_cm', split: 'split_block_cm', Tab: 'edit.cm.indent_block', 'Shift-Tab': 'edit.cm.outdent_block',
        up: 'move_block_up_cm', down: 'move_block_down_cm', Backspace: 'delete_empty_block_cm', Delete: 'merge_next_block_cm'}[gesture]
      const action = getDefaultActionGroups({repo}).editModeCMActions.find(a => a.id === id)!
      const doc = (await deps.block.load())!.content
      const editor = new EditorView({doc, selection: {anchor: gesture === 'Backspace' ? 0 : gesture === 'split' ? 1 : doc.length}})
      try { await action.handler({...deps, editorView: editor}, trigger) }
      finally { editor.destroy() }
    }
    expectPlacement(before, await storedRows(), expected, gesture === 'split' && expected ? target : undefined)
  })
})

it.each([false, true])('refuses moving an outside cut into a foreign result (via note = %s)', async viaNote => {
  await withProjectedDescendant()
  const row = repo.block('row-0')
  await repo.tx(tx => tx.create({id: 'note', workspaceId, parentId: row.id, orderKey: 'a0', content: 'Note'}), options)
  const target = viaNote ? repo.block('note') : row
  const destination = viaNote
    ? {...controller.rowSurface(row.id), renderScopeId: tableNotesScopeId(TABLE, row.id)}
    : controller.rowSurface(row.id)
  await armCut('Outside cut', {workspaceId, rootIds: ['after']})
  try {
    expect((await pasteArmedCut('Outside cut', target, repo, destination))?.kind).toBe('refused')
    expect((await repo.load('after'))?.parentId).toBe('page')
    expect((await repo.load(row.id))?.parentId).toBe('outside-1')
    expect(await repo.query.childIds({id: row.id}).load()).toEqual(['note'])
    expect(getArmedCut()).toMatchObject({rootIds: ['after'], pasted: false})
  } finally {
    disarmCut()
  }
})

it('moves an armed note inside the same foreign result in persisted order', async () => {
  await withProjectedDescendant()
  const row = repo.block('row-0')
  await repo.tx(async tx => {
    await tx.create({id: 'first-note', workspaceId, parentId: row.id, orderKey: 'a0', content: 'First note'})
    await tx.create({id: 'last-note', workspaceId, parentId: row.id, orderKey: 'a1', content: 'Last note'})
  }, options)
  const destination = {...controller.rowSurface(row.id), renderScopeId: tableNotesScopeId(TABLE, row.id)}
  await armCut('Cut note', {workspaceId, rootIds: ['first-note']})
  try {
    expect((await pasteArmedCut('Cut note', repo.block('last-note'), repo, destination))?.kind).toBe('moved')
    expect(await repo.query.childIds({id: row.id}).load()).toEqual(['last-note', 'first-note'])
    expect((await repo.load(row.id))?.parentId).toBe('outside-1')
  } finally {
    disarmCut()
  }
})
