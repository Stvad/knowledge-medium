// @vitest-environment happy-dom
/**
 * Each handler that walks "the list the surface draws" gets that list from the
 * display scope in its deps. These drive the REAL handlers with a mode that
 * draws property rows (`NON_HIDDEN`) and with one that does not (`NONE`), and
 * assert the outcomes differ, so a handler that stops passing the scope on
 * fails here.
 *
 *   page
 *     owner
 *       a
 *       status::   (drawn in `non-hidden`) → draft
 *       b
 *     solo
 *       status::   → todo
 *     after
 *   ui
 *
 * Mode none order: page, owner, a, b, solo, after.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorView } from '@codemirror/view'
import { ChangeScope, seedProperty, type BlockData, type User } from '@/data/api'
import { definitionSeedsFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { outlineSurfaceOf } from '@/data/outlineSurface'
import type { PropertyDisplayScopeLevels } from '@/data/propertyDisplayMode'
import {
  focusBlock,
  isCollapsedProp,
  peekFocusedBlockLocation,
  selectionStateProp,
} from '@/data/properties'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo, isBlockDeleted } from '@/data/test/createTestRepo'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { armCut, disarmCut } from '@/paste/armedCut'
import {
  pasteArmedCut,
  pasteEditModeMultilineText,
  planEditModeMultilinePaste,
} from '@/paste/operations'
import { getVimNormalModeActions, jumpVisibleBlocks } from '@/plugins/vim-normal-mode/actions'
import { createSharedBlockActions } from '@/shortcuts/blockActions'
import { getDefaultActions } from '@/shortcuts/defaultShortcuts'
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionContextType,
  type ActionTrigger,
  type BlockShortcutDependencies,
  type CodeMirrorEditModeDependencies,
  type MultiSelectModeDependencies,
} from '@/shortcuts/types'

const USER: User = {id: 'user-1', name: 'Alice'}
const WS = 'ws-drawn-list-handlers'
const NON_HIDDEN: PropertyDisplayScopeLevels = {childBacked: true, workspace: 'non-hidden', panel: 'inherit'}
const NONE: PropertyDisplayScopeLevels = {childBacked: true, workspace: 'none', panel: 'inherit'}

const statusProp = seedProperty({
  seedKey: 'test/property/drawn-handler-status', revision: 1, name: 'drawn-handler:status',
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
/** The row ids are minted per test; cases name them by role. */
const resolveId = (name: string): string =>
  name === 'status-row' ? statusRow : name === 'draft-row' ? draftRow : name
const focusedId = (): string | undefined => peekFocusedBlockLocation(repo.block('ui'))?.blockId
const selectedIds = (): readonly string[] | undefined =>
  repo.block('ui').peekProperty(selectionStateProp)?.selectedBlockIds

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

afterEach(() => {
  disarmCut()
  vi.unstubAllGlobals()
})

const trigger = {preventDefault: vi.fn()} as unknown as ActionTrigger

const findAction = <T extends ActionContextType>(
  actions: ActionConfig<ActionContextType>[], id: string, context: T,
): ActionConfig<T> => {
  const action = actions.find(candidate => candidate.id === id && candidate.context === context)
  if (!action) throw new Error(`Action not found: ${id}`)
  return action as unknown as ActionConfig<T>
}
const defaultAction = <T extends ActionContextType>(id: string, context: T): ActionConfig<T> =>
  findAction(getDefaultActions({repo}) as ActionConfig<ActionContextType>[], id, context)

const normalDeps = (
  blockId: string, propertyDisplay: PropertyDisplayScopeLevels,
): BlockShortcutDependencies => ({
  block: repo.block(blockId), uiStateBlock: repo.block('ui'), scopeRootId: 'page', propertyDisplay,
})
const vimAction = (id: string): ActionConfig<typeof ActionContextTypes.NORMAL_MODE> =>
  findAction(getVimNormalModeActions({repo}) as ActionConfig<ActionContextType>[], id, ActionContextTypes.NORMAL_MODE)
const multiDeps = (
  blockIds: string[], propertyDisplay: PropertyDisplayScopeLevels,
): MultiSelectModeDependencies => ({
  uiStateBlock: repo.block('ui'),
  selectedBlocks: blockIds.map(id => repo.block(id)),
  anchorBlock: null,
  scopeRootId: 'page',
  propertyDisplay,
} as MultiSelectModeDependencies)

const editorAt = (content: string, cursor: number): EditorView => {
  const view = {dispatch: vi.fn()}
  Object.defineProperty(view, 'state', {
    get: () => ({
      selection: {main: {empty: true, from: cursor, to: cursor, anchor: cursor, head: cursor}},
      doc: {length: content.length, toString: () => content, sliceString: (from: number, to = content.length) => content.slice(from, to)},
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
  const action = defaultAction(actionId, ActionContextTypes.EDIT_MODE_CM)
  const content = (await contentOf(blockId))!
  await action.handler({
    block: repo.block(blockId),
    editorView: editorAt(content, cursor === 'start' ? 0 : content.length),
    uiStateBlock: repo.block('ui'),
    scopeRootId: 'page',
    propertyDisplay,
  } satisfies CodeMirrorEditModeDependencies, trigger)
}

describe('vim normal mode', () => {
  it.each([
    [NON_HIDDEN, 'status-row'],
    [NONE, 'b'],
  ] as const)('move_down from `a` lands on the next drawn row (%#)', async (display, expected) => {
    await focusBlock(repo.block('ui'), 'a')
    await vimAction('move_down').handler(normalDeps('a', display), trigger)
    await vi.waitFor(() => expect(focusedId()).toBe(resolveId(expected)))
  })

  it.each([
    [NON_HIDDEN, 'draft-row'],
    [NONE, 'a'],
  ] as const)('move_up from `b` lands on the previous drawn row (%#)', async (display, expected) => {
    await focusBlock(repo.block('ui'), 'b')
    await vimAction('move_up').handler(normalDeps('b', display), trigger)
    await vi.waitFor(() => expect(focusedId()).toBe(resolveId(expected)))
  })

  it('jumpVisibleBlocks counts drawn rows as steps', async () => {
    const jump = (display: PropertyDisplayScopeLevels, from: string, direction: 'up' | 'down') =>
      jumpVisibleBlocks(repo.block(from), outlineSurfaceOf({scopeRootId: 'page', propertyDisplay: display})!, 2, direction)
    expect((await jump(NON_HIDDEN, 'a', 'down'))?.id).toBe(draftRow)
    expect((await jump(NONE, 'a', 'down'))?.id).toBe('solo')
    expect((await jump(NON_HIDDEN, 'after', 'up'))?.id).toBe(soloStatusRow)
    expect((await jump(NONE, 'after', 'up'))?.id).toBe('b')
  })

  it('jump_many_up counts drawn rows: eight steps from `after` reach `owner` or `page`', async () => {
    await vimAction('jump_many_up').handler(normalDeps('after', NON_HIDDEN), trigger)
    await vi.waitFor(() => expect(focusedId()).toBe('owner'))
    await vimAction('jump_many_up').handler(normalDeps('after', NONE), trigger)
    await vi.waitFor(() => expect(focusedId()).toBe('page'))
  })

  it('jump_many_down counts drawn rows: eight steps from `a` stop short of the last tail block', async () => {
    await repo.tx(async tx => {
      for (let i = 1; i <= 5; i++) {
        await tx.create({id: `e${i}`, workspaceId: WS, parentId: 'page', orderKey: `a3${i}`, content: `e${i}`})
      }
    }, {scope: ChangeScope.BlockDefault})
    await vimAction('jump_many_down').handler(normalDeps('a', NON_HIDDEN), trigger)
    await vi.waitFor(() => expect(focusedId()).toBe('e1'))
    await vimAction('jump_many_down').handler(normalDeps('a', NONE), trigger)
    await vi.waitFor(() => expect(focusedId()).toBe('e5'))
  })

  it.each([
    [NON_HIDDEN, 'todo-row'],
    [NONE, 'solo'],
  ] as const)('jump_to_last_visible_block (G) under `solo` (%#)', async (display, expected) => {
    const todoRow = (await allChildren(soloStatusRow))[0]!.id
    await vimAction('jump_to_last_visible_block').handler({...normalDeps('after', display), scopeRootId: 'solo'}, trigger)
    await vi.waitFor(() => expect(focusedId()).toBe(expected === 'todo-row' ? todoRow : expected))
  })

  it.each([
    [NON_HIDDEN, 'solo'],
    [NONE, 'page'],
  ] as const)('`o` on `solo` creates a child when it draws rows, else a sibling (%#)', async (display, expectedParent) => {
    await vimAction('create_block_below_and_edit').handler(normalDeps('solo', display), trigger)
    await vi.waitFor(() => expect(focusedId()).toBeDefined())
    const newId = focusedId()!
    expect(await parentOf(newId)).toBe(expectedParent)
  })
})

describe('selection extension', () => {
  it.each([
    [NON_HIDDEN, ['a', 'status-row']],
    [NONE, ['a', 'b']],
  ] as const)('edit-mode Shift+ArrowDown at the end of `a` (%#)', async (display, expected) => {
    await focusBlock(repo.block('ui'), 'a')
    const action = defaultAction('edit.cm.extend_selection_down', ActionContextTypes.EDIT_MODE_CM)
    const deps = {
      block: repo.block('a'), editorView: editorAt('a', 1), uiStateBlock: repo.block('ui'),
      scopeRootId: 'page', propertyDisplay: display,
    } satisfies CodeMirrorEditModeDependencies
    await action.handler(deps, trigger)
    await action.handler(deps, trigger)
    expect(selectedIds()).toEqual(expected.map(id => id === 'status-row' ? statusRow : id))
  })

  it.each([
    [NON_HIDDEN, ['a', 'status-row']],
    [NONE, ['a', 'b']],
  ] as const)('normal-mode extend_selection_down (%#)', async (display, expected) => {
    await focusBlock(repo.block('ui'), 'a')
    const action = createSharedBlockActions({repo}).extendSelectionDown
    await action.handler(normalDeps('a', display), trigger)
    await action.handler(normalDeps('a', display), trigger)
    expect(selectedIds()).toEqual(expected.map(id => id === 'status-row' ? statusRow : id))
  })
})

describe('focus after a delete or a cut', () => {
  it.each([
    [NON_HIDDEN, 'status-row'],
    [NONE, 'b'],
  ] as const)('delete_block on `a` (%#)', async (display, expected) => {
    await defaultAction('delete_block', ActionContextTypes.NORMAL_MODE).handler(normalDeps('a', display), trigger)
    await vi.waitFor(() => expect(focusedId()).toBe(expected === 'status-row' ? statusRow : expected))
    expect(await isBlockDeleted(repo, 'a')).toBe(true)
  })

  it.each([
    [NON_HIDDEN, 'status-row'],
    [NONE, 'b'],
  ] as const)('multi-select delete of `a` (%#)', async (display, expected) => {
    await defaultAction('multi_select.delete_block', ActionContextTypes.MULTI_SELECT_MODE)
      .handler(multiDeps(['a'], display), trigger)
    await vi.waitFor(() => expect(focusedId()).toBe(expected === 'status-row' ? statusRow : expected))
    expect(await isBlockDeleted(repo, 'a')).toBe(true)
  })

  it.each([
    [NON_HIDDEN, 'status-row'],
    [NONE, 'b'],
  ] as const)('multi-select cut of `a` (%#)', async (display, expected) => {
    vi.stubGlobal('ClipboardItem', class { })
    vi.stubGlobal('navigator', {clipboard: {write: vi.fn(async () => {})}})
    await defaultAction('cut_selected_blocks', ActionContextTypes.MULTI_SELECT_MODE)
      .handler(multiDeps(['a'], display), trigger)
    await vi.waitFor(() => expect(focusedId()).toBe(expected === 'status-row' ? statusRow : expected))
  })
})

describe('paste entry points', () => {
  it.each([
    [NON_HIDDEN, 'solo'],
    [NONE, 'page'],
  ] as const)('edit-mode multiline paste at `solo` (%#)', async (display, expectedParent) => {
    const plan = planEditModeMultilinePaste('alpha\nbeta', 'solo', {from: 4, to: 4})!
    const result = await pasteEditModeMultilineText(plan, repo.block('solo'), repo,
      {scopeRootId: 'page', propertyDisplay: display})
    const created = result!.focusBlock.id
    expect(created).not.toBe('solo')
    expect(await parentOf(created)).toBe(expectedParent)
  })

  it.each([
    [NON_HIDDEN, 'solo'],
    [NONE, 'page'],
  ] as const)('pasting an armed cut onto `solo` (%#)', async (display, expectedParent) => {
    await armCut('cut text', {workspaceId: WS, rootIds: ['after']})
    const outcome = await pasteArmedCut('cut text', repo.block('solo'), repo,
      {position: 'after', scopeRootId: 'page', propertyDisplay: display})
    expect(outcome?.kind).toBe('moved')
    expect(await parentOf('after')).toBe(expectedParent)
  })
})

describe('the Delete merge refusal counts drawn children', () => {
  // `solo` collapsed, so the next visible row after it is `tail`. `tail` draws
  // its own property row; `solo` has its drawn row too. In mode none neither
  // draws a child, so `tail` folds into `solo`.
  it.each([
    [NON_HIDDEN, 'solo', false],
    [NONE, 'solotail', true],
  ] as const)('Delete at the end of `solo` (%#)', async (display, expectedContent, tailDeleted) => {
    await repo.tx(tx => tx.create({id: 'tail', workspaceId: WS, parentId: 'page', orderKey: 'a15', content: 'tail'}),
      {scope: ChangeScope.BlockDefault})
    await repo.block('tail').set(statusProp, 'x')
    await repo.block('solo').set(isCollapsedProp, true)
    await pressInEditor('merge_next_block_cm', 'solo', 'end', display)
    expect(await contentOf('solo')).toBe(expectedContent)
    expect(await isBlockDeleted(repo, 'tail')).toBe(tailDeleted)
  })
})
