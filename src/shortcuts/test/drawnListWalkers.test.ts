// @vitest-environment happy-dom
/**
 * The outline's data walkers read the list the surface DRAWS: a property row
 * the display mode shows is a row to step onto, a merge neighbour, a child
 * that makes its owner "have children", exactly as on screen. In mode `none`
 * the same walks pass it by.
 *
 *   page
 *     owner
 *       a
 *       status::   (drawn in `non-hidden`) → draft
 *       b
 *     solo
 *       status::   → todo
 *     after
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorView } from '@codemirror/view'
import { ChangeScope, seedProperty, type BlockData, type User } from '@/data/api'
import { definitionSeedsFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { outlineSurfaceOf, type OutlineSurface } from '@/data/outlineSurface'
import type { PropertyDisplayScopeLevels } from '@/data/propertyDisplayMode'
import {
  focusBlock,
  isCollapsedProp,
  isEditingProp,
  peekFocusedBlockLocation,
  selectionStateProp,
} from '@/data/properties'
import type { Repo } from '@/data/repo'
import { structuralEditPolicyForBlock } from '@/data/structuralEditPolicy'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo, isBlockDeleted } from '@/data/test/createTestRepo'
import { extendBlockSelectionAction } from '@/extensions/blockSelectionAction'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { pasteMultilineText } from '@/paste/operations'
import { extendSelectionDown } from '@/shortcuts/blockActions'
import { getDefaultActions } from '@/shortcuts/defaultShortcuts'
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionTrigger,
  type CodeMirrorEditModeDependencies,
} from '@/shortcuts/types'
import {
  blockAfterSubtreeRemoval,
  caretNeighbour,
  getBlocksInRange,
  getLastVisibleDescendant,
  nextVisibleBlock,
  previousVisibleBlock,
} from '@/utils/selection'

const USER: User = {id: 'user-1', name: 'Alice'}
const WS = 'ws-drawn-list-walkers'
const NON_HIDDEN: PropertyDisplayScopeLevels = {childBacked: true, workspace: 'non-hidden', panel: 'inherit'}
const NONE: PropertyDisplayScopeLevels = {childBacked: true, workspace: 'none', panel: 'inherit'}
const surface = (propertyDisplay: PropertyDisplayScopeLevels): OutlineSurface =>
  outlineSurfaceOf({scopeRootId: 'page', propertyDisplay})!
const DRAWN = surface(NON_HIDDEN)
const HIDDEN = surface(NONE)

const statusProp = seedProperty({
  seedKey: 'test/property/drawn-walker-status', revision: 1, name: 'drawn-walker:status',
  preset: 'string', defaultValue: '', changeScope: ChangeScope.BlockDefault,
})

let sharedDb: TestDb
let repo: Repo
let statusRow: string
let draftRow: string
let soloStatusRow: string
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

const allChildren = async (id: string): Promise<BlockData[]> =>
  await repo.runQuery('core.children', {id}) as BlockData[]
const contentOf = async (id: string): Promise<string | undefined> => (await repo.load(id))?.content
const parentOf = async (id: string): Promise<string | null> => (await repo.load(id))?.parentId ?? null

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  await sharedDb.db.execute(
    `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time,
       encryption_mode, wk_canary, properties_migration)
     VALUES (?, 'test ws', ?, 1, 1, 'none', NULL, 'children')`, [WS, USER.id])
  repo = createTestRepo({db: sharedDb.db, user: USER}).repo
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    definitionSeedsFacet.of(statusProp, {source: 'test'}),
  ]))
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'page'})
    await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0', content: ''})
    await tx.create({id: 'owner', workspaceId: WS, parentId: 'page', orderKey: 'a0', content: 'owner'})
    await tx.create({id: 'a', workspaceId: WS, parentId: 'owner', orderKey: 'a0', content: 'a'})
    await tx.create({id: 'b', workspaceId: WS, parentId: 'owner', orderKey: 'a2', content: 'b'})
    await tx.create({id: 'solo', workspaceId: WS, parentId: 'page', orderKey: 'a1', content: 'solo'})
    await tx.create({id: 'after', workspaceId: WS, parentId: 'page', orderKey: 'a2', content: 'after'})
  }, {scope: ChangeScope.BlockDefault})
  await vi.waitFor(() => expect(repo.propertySchemas.has(statusProp.name)).toBe(true))
  await repo.block('owner').set(statusProp, 'draft')
  await repo.block('solo').set(statusProp, 'todo')
  statusRow = (await allChildren('owner')).find(child => child.isFieldForm)!.id
  await repo.tx(tx => tx.move(statusRow, {parentId: 'owner', orderKey: 'a1'}), {scope: ChangeScope.BlockDefault})
  draftRow = (await allChildren(statusRow))[0]!.id
  soloStatusRow = (await allChildren('solo')).find(child => child.isFieldForm)!.id
})

const editorAt = (content: string, cursor: number): EditorView => {
  let text = content
  const view = {
    dispatch: vi.fn((spec: {changes?: {from: number; to: number; insert: string}}) => {
      if (spec.changes) text = text.slice(0, spec.changes.from) + spec.changes.insert + text.slice(spec.changes.to)
    }),
  }
  Object.defineProperty(view, 'state', {
    get: () => ({
      selection: {main: {empty: true, from: cursor, to: cursor, anchor: cursor, head: cursor}},
      doc: {length: text.length, toString: () => text, sliceString: (from: number, to = text.length) => text.slice(from, to)},
    }),
  })
  return view as unknown as EditorView
}

const pressInEditor = async (
  actionId: string,
  blockId: string,
  cursor: 'start' | 'end',
  propertyDisplay: PropertyDisplayScopeLevels,
): Promise<void> => {
  const action = getDefaultActions({repo}).find(
    (candidate): candidate is ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> =>
      candidate.id === actionId && candidate.context === ActionContextTypes.EDIT_MODE_CM)!
  const content = (await contentOf(blockId))!
  await action.handler({
    block: repo.block(blockId),
    editorView: editorAt(content, cursor === 'start' ? 0 : content.length),
    uiStateBlock: repo.block('ui'),
    scopeRootId: 'page',
    propertyDisplay,
  } satisfies CodeMirrorEditModeDependencies, {preventDefault: vi.fn()} as unknown as ActionTrigger)
}

describe('range selection and the data walker step onto drawn property rows', () => {
  it('next: the drawn row follows `a`, and its value follows it', async () => {
    expect((await nextVisibleBlock(repo.block('a'), DRAWN))?.id).toBe(statusRow)
    expect((await nextVisibleBlock(repo.block(statusRow), DRAWN))?.id).toBe(draftRow)
    expect((await nextVisibleBlock(repo.block(draftRow), DRAWN))?.id).toBe('b')
  })

  it('previous: `b` is preceded by the drawn row\'s last value', async () => {
    expect((await previousVisibleBlock(repo.block('b'), DRAWN))?.id).toBe(draftRow)
    expect((await previousVisibleBlock(repo.block(draftRow), DRAWN))?.id).toBe(statusRow)
    expect((await previousVisibleBlock(repo.block(statusRow), DRAWN))?.id).toBe('a')
  })

  it('next steps into a first child that is a drawn row', async () => {
    expect((await nextVisibleBlock(repo.block('solo'), DRAWN))?.id).toBe(soloStatusRow)
    expect((await nextVisibleBlock(repo.block('solo'), HIDDEN))?.id).toBe('after')
  })

  it('mode none passes the row by in both directions', async () => {
    expect((await nextVisibleBlock(repo.block('a'), HIDDEN))?.id).toBe('b')
    expect((await previousVisibleBlock(repo.block('b'), HIDDEN))?.id).toBe('a')
  })

  it('the last visible descendant of a block ending in a drawn row is that row\'s value', async () => {
    const todoRow = (await allChildren(soloStatusRow))[0]!.id
    expect((await getLastVisibleDescendant(repo.block('solo'), DRAWN)).id).toBe(todoRow)
    expect((await getLastVisibleDescendant(repo.block('solo'), HIDDEN)).id).toBe('solo')
  })

  it('a range from `a` to `b` covers the drawn row between them', async () => {
    expect(await getBlocksInRange('a', 'b', DRAWN, repo)).toEqual(['a', statusRow, 'b'])
    expect(await getBlocksInRange('a', 'b', HIDDEN, repo)).toEqual(['a', 'b'])
  })

  it('Shift+Down extends onto the drawn row', async () => {
    const ui = repo.block('ui')
    await focusBlock(ui, 'a')
    await extendSelectionDown(ui, repo, DRAWN)
    await extendSelectionDown(ui, repo, DRAWN)
    expect(ui.peekProperty(selectionStateProp)?.selectedBlockIds).toEqual(['a', statusRow])
  })

  it('focus after a delete goes to the drawn neighbour', async () => {
    expect((await blockAfterSubtreeRemoval(repo.block(statusRow), DRAWN))?.id).toBe('b')
    expect((await blockAfterSubtreeRemoval(repo.block('a'), DRAWN))?.id).toBe(statusRow)
    expect((await blockAfterSubtreeRemoval(repo.block('a'), HIDDEN))?.id).toBe('b')
  })

  it('a row its listing leaves out counts from where the outline draws it', async () => {
    await repo.tx(tx => tx.create({id: 'c', workspaceId: WS, parentId: 'owner', orderKey: 'a4', content: 'c'}),
      {scope: ChangeScope.BlockDefault})
    // Mode none lists [a, b, c]; the row sorts between a and b, so `b` takes its place.
    expect((await blockAfterSubtreeRemoval(repo.block(statusRow), HIDDEN))?.id).toBe('b')
    expect((await blockAfterSubtreeRemoval(repo.block(statusRow), HIDDEN, new Set(['b', 'c'])))?.id).toBe('a')
  })

  it('shift-click ranges over the drawn row', async () => {
    const ui = repo.block('ui')
    await focusBlock(ui, 'a')
    await extendBlockSelectionAction.handler({
      block: repo.block('b'), uiStateBlock: ui, scopeRootId: 'page', propertyDisplay: NON_HIDDEN,
      targetElement: document.createElement('div'),
    }, {kind: 'test'} as never)
    expect(ui.peekProperty(selectionStateProp)?.selectedBlockIds).toEqual(['a', statusRow, 'b'])
  })
})

describe('the edit-mode caret passes a row drawn as a property\'s name', () => {
  const focusedId = (): string | undefined => peekFocusedBlockLocation(repo.block('ui'))?.blockId

  it('ArrowRight at the end of `a` lands in the value, not on the name row', async () => {
    await pressInEditor('move_right_from_cm_end', 'a', 'end', NON_HIDDEN)
    expect(focusedId()).toBe(draftRow)
  })

  it('ArrowLeft at the start of the value lands in `a`', async () => {
    await pressInEditor('move_left_from_cm_start', draftRow, 'start', NON_HIDDEN)
    expect(focusedId()).toBe('a')
  })

  it('Backspace on an emptied value lands in `a`', async () => {
    await repo.tx(tx => tx.update(draftRow, {content: ''}), {scope: ChangeScope.BlockDefault})
    await pressInEditor('delete_empty_block_cm', draftRow, 'start', NON_HIDDEN)
    expect(focusedId()).toBe('a')
  })
})

describe('the caret leaving a block for its neighbour', () => {
  it('passes name rows in both directions', async () => {
    const todoRow = (await allChildren(soloStatusRow))[0]!.id
    expect((await caretNeighbour(repo.block('solo'), DRAWN, 'next'))?.id).toBe(todoRow)
    expect((await caretNeighbour(repo.block(todoRow), DRAWN, 'previous'))?.id).toBe('solo')
  })
})

describe('merge targets are the drawn neighbours', () => {
  it('Backspace at the start of `b` joins it onto the value drawn above it', async () => {
    await pressInEditor('delete_empty_block_cm', 'b', 'start', NON_HIDDEN)
    expect(await contentOf(draftRow)).toBe('draftb')
    expect(await contentOf('a')).toBe('a')
  })

  it('in mode none the same Backspace joins `b` onto `a`', async () => {
    await pressInEditor('delete_empty_block_cm', 'b', 'start', NONE)
    expect(await contentOf('a')).toBe('ab')
    expect(await contentOf(draftRow)).toBe('draft')
  })

  it('Delete at the end of `a` folds in the name row drawn below it, not `b`', async () => {
    const rowText = await contentOf(statusRow)
    await pressInEditor('merge_next_block_cm', 'a', 'end', NON_HIDDEN)
    expect(await contentOf('a')).toBe(`a${rowText}`)
    expect(await isBlockDeleted(repo, statusRow)).toBe(true)
    expect(await parentOf('b')).toBe('owner')
    expect(await contentOf('b')).toBe('b')
  })

  it('an empty block that folds in a name row becomes it, and leaves edit mode', async () => {
    const ui = repo.block('ui')
    await repo.tx(tx => tx.update('a', {content: ''}), {scope: ChangeScope.BlockDefault})
    await focusBlock(ui, 'a', {edit: true})
    await pressInEditor('merge_next_block_cm', 'a', 'end', NON_HIDDEN)
    expect((await repo.load('a'))?.isFieldForm).toBe(true)
    expect(await parentOf(draftRow)).toBe('a')
    await vi.waitFor(() => expect(ui.peekProperty(isEditingProp)).toBe(false))
  })

  it('in mode none the same Delete folds `b` into `a`', async () => {
    await pressInEditor('merge_next_block_cm', 'a', 'end', NONE)
    expect(await contentOf('a')).toBe('ab')
  })

  it('Backspace below a collapsed name row folds the block onto it', async () => {
    await repo.block(statusRow).set(isCollapsedProp, true)
    const rowText = await contentOf(statusRow)
    await pressInEditor('delete_empty_block_cm', 'b', 'start', NON_HIDDEN)
    expect(await contentOf(statusRow)).toBe(`${rowText}b`)
    expect(await contentOf('a')).toBe('a')
  })

  it('a block showing only drawn property rows is not folded into a block with children of its own', async () => {
    await repo.block('owner').set(isCollapsedProp, true)
    await pressInEditor('delete_empty_block_cm', 'solo', 'start', NON_HIDDEN)
    expect(await contentOf('owner')).toBe('owner')
    expect(await parentOf(soloStatusRow)).toBe('solo')
  })

  it('in mode none that block shows no children, and folds in', async () => {
    await repo.block('owner').set(isCollapsedProp, true)
    await pressInEditor('delete_empty_block_cm', 'solo', 'start', NONE)
    expect(await contentOf('owner')).toBe('ownersolo')
  })

  it('Delete at the end of a drawn value folds the next drawn row into it', async () => {
    await pressInEditor('merge_next_block_cm', draftRow, 'end', NON_HIDDEN)
    expect(await contentOf(draftRow)).toBe('draftb')
  })
})

describe('a block whose only drawn children are property rows has children', () => {
  it('Enter at its end creates a first child', async () => {
    expect((await structuralEditPolicyForBlock(repo.block('solo'), DRAWN)).createBelowPlacement).toBe('child-first')
  })

  it('in mode none it has none, and Enter creates a sibling', async () => {
    expect((await structuralEditPolicyForBlock(repo.block('solo'), HIDDEN)).createBelowPlacement).toBe('sibling-below')
  })

  it('a paste after it lands in its child list', async () => {
    const [pasted] = await pasteMultilineText('pasted', repo.block('solo'), repo,
      {position: 'after', scopeRootId: 'page', propertyDisplay: NON_HIDDEN})
    expect(await parentOf(pasted!.id)).toBe('solo')
  })

  it('in mode none the same paste lands beside it', async () => {
    const [pasted] = await pasteMultilineText('pasted', repo.block('solo'), repo,
      {position: 'after', scopeRootId: 'page', propertyDisplay: NONE})
    expect(await parentOf(pasted!.id)).toBe('page')
  })
})
