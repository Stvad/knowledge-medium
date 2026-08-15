// @vitest-environment happy-dom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const showInfoMock = vi.hoisted(() => vi.fn())
vi.mock('@/utils/toast.js', async importOriginal => {
  const actual = await importOriginal<typeof import('@/utils/toast.js')>()
  return { ...actual, showInfo: showInfoMock }
})

import { waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { ChangeScope, type User } from '@/data/api'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo, isBlockDeleted } from '@/data/test/createTestRepo'
import {
  activePanelIdProp,
  editorSelection,
  focusBlock,
  focusedBlockLocationProp,
  isCollapsedProp,
  isEditingProp,
  panelMaximizedProp,
  peekFocusedBlockLocation,
  selectionStateProp,
  topLevelBlockIdProp,
} from '@/data/properties'
import { getLayoutSessionBlock, getUIStateBlock, getUserPrefsBlock } from '@/data/stateBlocks'
import {
  CREATE_NODE_IN_ACTIVE_PANEL_ACTION_ID,
  OPEN_PREFERENCES_ACTION_ID,
  RELOAD_IN_SAFE_MODE_ACTION_ID,
  getDefaultActions,
} from '@/shortcuts/defaultShortcuts'
import { __resetLayoutSessionIdForTesting } from '@/utils/layoutSessionId'
import {
  insertPanelRow,
  panelBlockId,
  allPanelRowsInLayoutOrder,
} from '@/utils/panelLayoutProjection'
import { panelRenderScopeId } from '@/utils/renderScope'
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionTrigger,
  type BlockShortcutDependencies,
  type CodeMirrorEditModeDependencies,
  type MultiSelectModeDependencies,
} from '@/shortcuts/types'
import { createSharedBlockActions } from '@/shortcuts/blockActions'
import { blockDeletionGuardsFacet } from '@/extensions/core'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { resolveFacetRuntimeSync, type AppExtension } from '@/facets/facet'
import { recallPayloadForText, resetRememberedPayloads } from '@/paste/clipboardPayload'
import { pasteAsMoveVerb } from '@/paste/moveOnPasteVerb'
import { pasteAsMoveImpl } from '@/plugins/move-blocks/pasteAsMoveImpl'

const WS = 'ws-1'
const USER: User = {id: 'user-1'}

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const { repo } = createTestRepo({
    db: h.db,
    user: USER,
  })
  repo.setActiveWorkspaceId(WS)
  return {h, repo}
}

interface FakeEditorDispatchSpec {
  changes?: {from: number; to: number; insert: string}
  selection?: unknown
}

const makeSelection = (from: number, to = from) => ({
  main: {empty: from === to, from, to, anchor: from, head: to},
})

const codeMirrorEditorView = (
  content: string,
  cursor: number,
): EditorView => {
  let text = content
  let selection = makeSelection(cursor)

  const view = {
    dom: document.createElement('div'),
    dispatch: vi.fn((spec: FakeEditorDispatchSpec) => {
      if (spec.changes) {
        text = text.slice(0, spec.changes.from) + spec.changes.insert + text.slice(spec.changes.to)
      }

      const nextSelection = spec.selection
      if (nextSelection && typeof nextSelection === 'object') {
        if ('main' in nextSelection) {
          const main = (nextSelection as {main: {from?: number; to?: number; head?: number}}).main
          const from = main.from ?? main.head ?? 0
          selection = makeSelection(from, main.to ?? main.head ?? from)
        } else if ('anchor' in nextSelection) {
          const range = nextSelection as {anchor: number; head?: number}
          selection = makeSelection(range.anchor, range.head ?? range.anchor)
        }
      }
    }),
  }

  Object.defineProperty(view, 'state', {
    get: () => ({
      selection,
      doc: {
        length: text.length,
        toString: () => text,
        sliceString: (from: number, to = text.length) => text.slice(from, to),
      },
    }),
  })

  return view as unknown as EditorView
}

const emptyEditorView = (): EditorView => codeMirrorEditorView('', 0)

const childIds = async (parentId: string | null): Promise<string[]> => {
  const rows = parentId === null
    ? await env.h.db.getAll<{id: string}>("SELECT id FROM blocks WHERE parent_id IS NULL AND deleted = 0 ORDER BY order_key, id")
    : await env.h.db.getAll<{id: string}>("SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id", [parentId])
  return rows.map(row => row.id)
}

const findEditModeAction = (
  repo: Repo,
  id: string,
): ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> => {
  const action = getDefaultActions({repo}).find(
    (candidate): candidate is ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> =>
      candidate.id === id && candidate.context === ActionContextTypes.EDIT_MODE_CM,
  )
  if (!action) throw new Error(`Action not found: ${id}`)
  return action
}

const findMultiSelectAction = (
  repo: Repo,
  id: string,
): ActionConfig<typeof ActionContextTypes.MULTI_SELECT_MODE> => {
  const action = getDefaultActions({repo}).find(
    (candidate): candidate is ActionConfig<typeof ActionContextTypes.MULTI_SELECT_MODE> =>
      candidate.id === id && candidate.context === ActionContextTypes.MULTI_SELECT_MODE,
  )
  if (!action) throw new Error(`Action not found: ${id}`)
  return action
}

const findNormalModeAction = (
  repo: Repo,
  id: string,
): ActionConfig<typeof ActionContextTypes.NORMAL_MODE> => {
  const action = getDefaultActions({repo}).find(
    (candidate): candidate is ActionConfig<typeof ActionContextTypes.NORMAL_MODE> =>
      candidate.id === id && candidate.context === ActionContextTypes.NORMAL_MODE,
  )
  if (!action) throw new Error(`Action not found: ${id}`)
  return action
}

const findGlobalAction = (
  repo: Repo,
  id: string,
): ActionConfig<typeof ActionContextTypes.GLOBAL> => {
  const action = getDefaultActions({repo}).find(
    (candidate): candidate is ActionConfig<typeof ActionContextTypes.GLOBAL> =>
      candidate.id === id && candidate.context === ActionContextTypes.GLOBAL,
  )
  if (!action) throw new Error(`Action not found: ${id}`)
  return action
}

const seedPanelAndContent = async (): Promise<{uiStateBlock: ReturnType<Repo['block']>; block: ReturnType<Repo['block']>}> => {
  await env.repo.tx(async tx => {
    await tx.create({
      id: 'panel',
      workspaceId: WS,
      parentId: null,
      orderKey: 'a0',
      properties: {[topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode('content')},
    })
    await tx.create({
      id: 'content',
      workspaceId: WS,
      parentId: null,
      orderKey: 'b0',
      content: 'content',
    })
  }, {scope: ChangeScope.UiState})
  return {
    uiStateBlock: env.repo.block('panel'),
    block: env.repo.block('content'),
  }
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  __resetLayoutSessionIdForTesting()
  env = await setup()
  showInfoMock.mockClear()
  // The remembered-payload table (`@/paste/clipboardPayload`) is a process
  // global, so a cut left in it by one test would otherwise leak into the
  // next.
  resetRememberedPayloads()
})

/** `env.repo` with the move-blocks plugin's `pasteAsMoveVerb` impl wired in,
 *  on top of the kernel data extension `setFacetRuntime` always needs. Used
 *  by the cut→paste-as-move tests, which need `tryPasteAsMove` to actually
 *  reach `moveBlocksTo` rather than see the seam's "nothing installed"
 *  default. */
const withPasteAsMoveInstalled = (extra: readonly AppExtension[] = []): void => {
  env.repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    pasteAsMoveVerb.impl(pasteAsMoveImpl),
    ...extra,
  ]))
}

describe('default CodeMirror shortcuts', () => {
  it('prevents native CodeMirror handling for structural move shortcuts', () => {
    const moveBlockUpAction = findEditModeAction(env.repo, 'move_block_up_cm')
    const moveBlockDownAction = findEditModeAction(env.repo, 'move_block_down_cm')

    expect(moveBlockUpAction.defaultBinding?.eventOptions?.preventDefault).toBe(true)
    expect(moveBlockDownAction.defaultBinding?.eventOptions?.preventDefault).toBe(true)
  })

  // The tests below pin the edit-mode HANDLER contract (when it takes over vs.
  // stands aside). They call the handler directly, so they observe only the
  // handler's own trigger.preventDefault() — NOT the dispatcher's event-option
  // application. The dispatcher-level guarantee (a binding's preventDefault:
  // false leaves the native default intact, which is what makes Shift+Arrow
  // text-selection survive) is covered end-to-end in HotkeyReconciler.test.tsx
  // ('event options (preventDefault)').
  it('does not take over (no manual preventDefault, stays in edit mode) when the caret is mid-text', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'prev', content: 'previous'})
    await env.repo.mutate.createChild({parentId: 'root', id: 'current', content: 'current text'})
    await env.repo.mutate.createChild({parentId: 'root', id: 'next', content: 'next'})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')
    await focusBlock(uiStateBlock, 'current')
    await uiStateBlock.set(isEditingProp, true)

    const deps = {
      block: env.repo.block('current'),
      editorView: codeMirrorEditorView('current text', 4), // caret mid-text
      uiStateBlock,
      scopeRootId: 'root',
    } satisfies CodeMirrorEditModeDependencies

    const upTrigger = {preventDefault: vi.fn()} as unknown as ActionTrigger
    const downTrigger = {preventDefault: vi.fn()} as unknown as ActionTrigger
    await findEditModeAction(env.repo, 'edit.cm.extend_selection_up').handler(deps, upTrigger)
    await findEditModeAction(env.repo, 'edit.cm.extend_selection_down').handler(deps, downTrigger)

    expect(upTrigger.preventDefault).not.toHaveBeenCalled()
    expect(downTrigger.preventDefault).not.toHaveBeenCalled()
    // Still editing — block selection was not triggered. Safe to peek
    // synchronously: the mid-text path returns before any setIsEditing write,
    // so nothing races the value set above (the edge test, which does write,
    // uses waitFor).
    expect(uiStateBlock.peekProperty(isEditingProp)).toBe(true)
  })

  it('escalates to block selection (preventDefault, exits edit mode) when the caret is at the block edge — Roam-style: first press selects just the current block, next extends', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'prev', content: 'previous'})
    await env.repo.mutate.createChild({parentId: 'root', id: 'current', content: 'current'})
    await env.repo.mutate.createChild({parentId: 'root', id: 'next', content: 'next'})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')
    await focusBlock(uiStateBlock, 'current')
    await uiStateBlock.set(isEditingProp, true)

    const editDeps = {
      block: env.repo.block('current'),
      editorView: codeMirrorEditorView('current', 0), // caret at block start
      uiStateBlock,
      scopeRootId: 'root',
    } satisfies CodeMirrorEditModeDependencies

    const trigger = {preventDefault: vi.fn()} as unknown as ActionTrigger
    await findEditModeAction(env.repo, 'edit.cm.extend_selection_up').handler(editDeps, trigger)

    expect(trigger.preventDefault).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(uiStateBlock.peekProperty(isEditingProp)).toBe(false))
    // First press selects ONLY the focused block (Roam-style) — and clearEditing
    // folded the edit-mode exit into the same transaction.
    expect(uiStateBlock.peekProperty(selectionStateProp)?.selectedBlockIds).toEqual(['current'])

    // Second press now extends to the previous visible block.
    await findEditModeAction(env.repo, 'edit.cm.extend_selection_up').handler(
      editDeps,
      {preventDefault: vi.fn()} as unknown as ActionTrigger,
    )
    await waitFor(() =>
      expect(uiStateBlock.peekProperty(selectionStateProp)?.selectedBlockIds).toEqual(['prev', 'current']),
    )
  })

  it('stays in edit mode when Shift+ArrowUp at block start has no previous block to escalate into', async () => {
    // Editing the surface root itself (e.g. a zoomed-in single block): there
    // is no previous visible block, so escalation must NOT drop the user out
    // of edit mode into a dead state with nothing selected.
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'only', content: 'only'})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')
    await focusBlock(uiStateBlock, 'only')
    await uiStateBlock.set(isEditingProp, true)

    const trigger = {preventDefault: vi.fn()} as unknown as ActionTrigger
    await findEditModeAction(env.repo, 'edit.cm.extend_selection_up').handler({
      block: env.repo.block('only'),
      editorView: codeMirrorEditorView('only', 0), // caret at start
      uiStateBlock,
      scopeRootId: 'only', // focused block IS the surface root → no previous visible block
    } satisfies CodeMirrorEditModeDependencies, trigger)

    // No neighbour to escalate into → no takeover: the key is left for native
    // (a no-op at head 0) and we stay in edit mode. preventDefault is the
    // deterministic signal; isEditing is reliable here too because the
    // no-target path issues no setIsEditing write to race the value set above.
    expect(trigger.preventDefault).not.toHaveBeenCalled()
    expect(uiStateBlock.peekProperty(isEditingProp)).toBe(true)
  })

  it('selects just the current block when Shift+ArrowDown at block end has no next block (Roam-style first press)', async () => {
    // Editing the last block in a panel: there's no next visible block, but the
    // Roam-style first press still selects the current block (so you can act on
    // it) rather than no-opping.
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'first', content: 'first'})
    await env.repo.mutate.createChild({parentId: 'root', id: 'last', content: 'last'})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')
    await focusBlock(uiStateBlock, 'last')
    await uiStateBlock.set(isEditingProp, true)

    const trigger = {preventDefault: vi.fn()} as unknown as ActionTrigger
    await findEditModeAction(env.repo, 'edit.cm.extend_selection_down').handler({
      block: env.repo.block('last'),
      editorView: codeMirrorEditorView('last', 'last'.length), // caret at end
      uiStateBlock,
      scopeRootId: 'root',
    } satisfies CodeMirrorEditModeDependencies, trigger)

    expect(trigger.preventDefault).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(uiStateBlock.peekProperty(isEditingProp)).toBe(false))
    expect(uiStateBlock.peekProperty(selectionStateProp)?.selectedBlockIds).toEqual(['last'])
  })

  it('opens the root preferences block from the global action', async () => {
    const action = findGlobalAction(env.repo, OPEN_PREFERENCES_ACTION_ID)

    const rootUiState = await getUIStateBlock(env.repo, WS, USER, {})
    const layoutSession = await getLayoutSessionBlock(rootUiState, env.repo.activeLayoutSessionId)
    const prefsBlock = await getUserPrefsBlock(env.repo, WS, USER)

    await action.handler(
      {uiStateBlock: rootUiState},
      {preventDefault: vi.fn()} as unknown as ActionTrigger,
    )

    await waitFor(async () => {
      const rows = await env.repo.query.subtree({id: layoutSession.id}).load()
      const panels = allPanelRowsInLayoutOrder(layoutSession.id, rows)
      expect(panelBlockId(panels[0])).toBe(prefsBlock.id)
    })
  })

  it('closes the current panel from normal mode', async () => {
    const {uiStateBlock, block} = await seedPanelAndContent()
    const action = findNormalModeAction(env.repo, 'close_current_panel')

    await action.handler({
      block,
      uiStateBlock,
    } satisfies BlockShortcutDependencies, {preventDefault: vi.fn()} as unknown as ActionTrigger)

    expect(await isBlockDeleted(env.repo, 'panel')).toBe(true)
  })

  it('closes the current panel from CodeMirror edit mode', async () => {
    const {uiStateBlock, block} = await seedPanelAndContent()
    const action = findEditModeAction(env.repo, 'edit.cm.close_current_panel')

    await action.handler({
      block,
      editorView: emptyEditorView(),
      uiStateBlock,
    } satisfies CodeMirrorEditModeDependencies, {preventDefault: vi.fn()} as unknown as ActionTrigger)

    expect(await isBlockDeleted(env.repo, 'panel')).toBe(true)
  })

  it('registers a command-palette action for reloading in safe mode', () => {
    const action = findGlobalAction(env.repo, RELOAD_IN_SAFE_MODE_ACTION_ID)

    expect(action.description).toBe('Reload in safe mode')
  })

  it('creates a new editable child in the active panel from the global action', async () => {
    await env.repo.tx(async tx => {
      await tx.create({
        id: 'root',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        content: 'Root',
      })
      await tx.create({
        id: 'existing-child',
        workspaceId: WS,
        parentId: 'root',
        orderKey: 'a0',
        content: 'Existing',
      })
    }, {scope: ChangeScope.BlockDefault})

    const rootUiState = await getUIStateBlock(env.repo, WS, USER, {})
    const layoutSession = await getLayoutSessionBlock(rootUiState, env.repo.activeLayoutSessionId)
    const panelId = await insertPanelRow(env.repo, layoutSession, 'root')
    await env.repo.block(panelId).set(focusedBlockLocationProp, {
      blockId: 'existing-child',
      renderScopeId: 'embed:other:existing-child:0',
    })
    const action = findGlobalAction(env.repo, CREATE_NODE_IN_ACTIVE_PANEL_ACTION_ID)

    await action.handler(
      {uiStateBlock: rootUiState},
      {preventDefault: vi.fn()} as unknown as ActionTrigger,
    )

    const rootChildren = await childIds('root')
    expect(rootChildren[0]).toBe('existing-child')
    expect(rootChildren).toHaveLength(2)
    const newNodeId = rootChildren[1]

    const panelBlock = env.repo.block(panelId)
    await panelBlock.load()
    expect(peekFocusedBlockLocation(panelBlock)?.blockId).toBe(newNodeId)
    expect(panelBlock.peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: newNodeId,
      renderScopeId: panelRenderScopeId(panelId, 'root'),
    })
    expect(panelBlock.peekProperty(isEditingProp)).toBe(true)
  })

  // This action CREATES a block in whichever pane it resolves, so resolving to
  // a hidden one writes into a page the user cannot see. It used to hand-roll
  // the active-pane rule over raw row order; it now shares the navigation
  // resolver, which narrows to what is rendered.
  it('creates the node in the maximized pane, not the hidden one the pointer names', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'hidden-page', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'shown-page', workspaceId: WS, parentId: null, orderKey: 'a1'})
    }, {scope: ChangeScope.BlockDefault})

    const rootUiState = await getUIStateBlock(env.repo, WS, USER, {})
    const layoutSession = await getLayoutSessionBlock(rootUiState, env.repo.activeLayoutSessionId)
    const hiddenPanelId = await insertPanelRow(env.repo, layoutSession, 'hidden-page')
    const shownPanelId = await insertPanelRow(env.repo, layoutSession, 'shown-page')
    await env.repo.block(shownPanelId).set(panelMaximizedProp, true)
    // The pointer legitimately lags onto the hidden pane after a `;max` arrival.
    await layoutSession.set(activePanelIdProp, hiddenPanelId)

    await findGlobalAction(env.repo, CREATE_NODE_IN_ACTIVE_PANEL_ACTION_ID).handler(
      {uiStateBlock: rootUiState},
      {preventDefault: vi.fn()} as unknown as ActionTrigger,
    )

    expect(await childIds('shown-page')).toHaveLength(1)
    expect(await childIds('hidden-page')).toHaveLength(0)
  })

  it('defaults cross-block focus to the per-pane scope instead of preserving stale nested scope', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'current', content: 'current'})
    await env.repo.mutate.createChild({parentId: 'root', id: 'next', content: 'next'})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')
    await uiStateBlock.set(focusedBlockLocationProp, {
      blockId: 'current',
      renderScopeId: 'embed:parent:current:0',
    })

    await focusBlock(uiStateBlock, 'next')

    // 'ui' carries topLevelBlockIdProp, so focusBlock treats it as a panel
    // row and defaults to the per-pane scope.
    expect(uiStateBlock.peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'next',
      renderScopeId: panelRenderScopeId('ui', 'root'),
    })
  })

  it('places the cursor at the beginning of the next block after pressing right at block end', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'current', content: 'current'})
    await env.repo.mutate.createChild({parentId: 'root', id: 'next', content: 'next'})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')
    await focusBlock(uiStateBlock, 'current')

    const action = findEditModeAction(env.repo, 'move_right_from_cm_end')
    const trigger = {preventDefault: vi.fn()} as unknown as ActionTrigger

    await action.handler({
      block: env.repo.block('current'),
      editorView: codeMirrorEditorView('current', 'current'.length),
      uiStateBlock,
      scopeRootId: 'root',
    } satisfies CodeMirrorEditModeDependencies, trigger)

    expect(trigger.preventDefault).toHaveBeenCalledTimes(1)
    expect(peekFocusedBlockLocation(uiStateBlock)?.blockId).toBe('next')
    expect(uiStateBlock.peekProperty(editorSelection)).toEqual({
      blockId: 'next',
      start: 0,
    })
  })

  it('places the cursor at the end of the previous block after pressing left at block start', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'prev', content: 'previous'})
    await env.repo.mutate.createChild({parentId: 'root', id: 'current', content: 'current'})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')
    await focusBlock(uiStateBlock, 'current')

    const action = findEditModeAction(env.repo, 'move_left_from_cm_start')
    const trigger = {preventDefault: vi.fn()} as unknown as ActionTrigger

    await action.handler({
      block: env.repo.block('current'),
      editorView: codeMirrorEditorView('current', 0),
      uiStateBlock,
      scopeRootId: 'root',
    } satisfies CodeMirrorEditModeDependencies, trigger)

    expect(trigger.preventDefault).toHaveBeenCalledTimes(1)
    expect(peekFocusedBlockLocation(uiStateBlock)?.blockId).toBe('prev')
    expect(uiStateBlock.peekProperty(editorSelection)).toEqual({
      blockId: 'prev',
      start: 'previous'.length,
    })
  })

  it('places the cursor at the end of the previous block after deleting an empty block with backspace', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'prev', content: 'previous'})
    await env.repo.mutate.createChild({parentId: 'root', id: 'empty', content: ''})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')
    await focusBlock(uiStateBlock, 'empty')

    const action = findEditModeAction(env.repo, 'delete_empty_block_cm')
    const trigger = {preventDefault: vi.fn()} as unknown as ActionTrigger

    await action.handler({
      block: env.repo.block('empty'),
      editorView: emptyEditorView(),
      uiStateBlock,
      scopeRootId: 'root',
    } satisfies CodeMirrorEditModeDependencies, trigger)

    expect(trigger.preventDefault).toHaveBeenCalledTimes(1)
    expect(env.repo.block('empty').peek()).toBeNull()
    expect(env.repo.block('empty').peekRaw()?.deleted).toBe(true)
    expect(peekFocusedBlockLocation(uiStateBlock)?.blockId).toBe('prev')
    expect(uiStateBlock.peekProperty(editorSelection)).toEqual({
      blockId: 'prev',
      start: 'previous'.length,
    })
  })

  it('refuses to Backspace away the scope root even when it is empty', async () => {
    // Reachable from the keyboard: split the zoomed page at cursor 0 (its
    // content moves down), then Backspace at 0 in the now-empty root —
    // without the canMergeUp guard the handler tombstoned the whole
    // rendered surface (Codex review on the interaction fuzzer, PR #371).
    // This gates the BACKSPACE gesture, which means "consume this block and
    // put the cursor on the previous visible one" and has nowhere to land at
    // the scope root. An explicit Delete on the same block IS allowed — that's
    // page deletion (see the delete_block tests below).
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0', content: ''})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'child', content: 'child'})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')
    await focusBlock(uiStateBlock, 'root')

    const action = findEditModeAction(env.repo, 'delete_empty_block_cm')
    const trigger = {preventDefault: vi.fn()} as unknown as ActionTrigger

    await action.handler({
      block: env.repo.block('root'),
      editorView: emptyEditorView(),
      uiStateBlock,
      scopeRootId: 'root',
    } satisfies CodeMirrorEditModeDependencies, trigger)

    expect(trigger.preventDefault).not.toHaveBeenCalled()
    expect(env.repo.block('root').peek()).not.toBeNull()
    expect(env.repo.block('root').peekRaw()?.deleted).toBe(false)
  })

  it('Backspace on an empty block consults the deletion guards', async () => {
    // Not the scope root, so `canMergeUp` is true and this path used to run
    // straight to `block.delete()`. That let a daily note rendered as a child
    // (its natural place, under the Journal) be destroyed by emptying its title
    // and pressing Backspace — straight past the veto.
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'r'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'first', content: 'first'})
    await env.repo.mutate.createChild({parentId: 'root', id: 'protected', content: ''})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')
    env.repo.setFacetRuntime(resolveFacetRuntimeSync([
      // setFacetRuntime REPLACES the registries, so the kernel data
      // contribution has to be re-included or `childIds` stops resolving.
      kernelDataExtension,
      blockDeletionGuardsFacet.of(
        block => (block.id === 'protected' ? 'Nope.' : null),
        {source: 'test'},
      ),
    ]))

    const action = findEditModeAction(env.repo, 'delete_empty_block_cm')
    await action.handler({
      block: env.repo.block('protected'),
      editorView: emptyEditorView(),
      uiStateBlock,
      scopeRootId: 'root',
    } satisfies CodeMirrorEditModeDependencies, {preventDefault: vi.fn()} as unknown as ActionTrigger)

    expect(await isBlockDeleted(env.repo, 'protected')).toBe(false)
    // Focus must not have moved for a delete that never happened.
    expect(peekFocusedBlockLocation(uiStateBlock)?.blockId).not.toBe('first')
  })

  it('multi-select Delete refuses the whole selection when one block is guarded', async () => {
    // Matches cut. The fan-out is per-block, so without a batch preflight the
    // unguarded sibling was deleted and only the protected one survived —
    // `Delete` half-deleting a selection that `d` refuses wholesale.
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'r'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'ordinary', content: 'ordinary'})
    await env.repo.mutate.createChild({parentId: 'root', id: 'protected', content: 'protected'})

    const uiStateBlock = env.repo.block('ui')
    env.repo.setFacetRuntime(resolveFacetRuntimeSync([
      kernelDataExtension,
      blockDeletionGuardsFacet.of(
        block => (block.id === 'protected' ? 'Nope.' : null),
        {source: 'test'},
      ),
    ]))

    await uiStateBlock.set(selectionStateProp, {
      ...selectionStateProp.defaultValue,
      selectedBlockIds: ['ordinary', 'protected'],
    })

    const action = findMultiSelectAction(env.repo, 'multi_select.delete_block')
    await action.handler({
      uiStateBlock,
      selectedBlocks: [env.repo.block('ordinary'), env.repo.block('protected')],
      anchorBlock: null,
    } as MultiSelectModeDependencies, {preventDefault: vi.fn()} as unknown as ActionTrigger)

    expect(await isBlockDeleted(env.repo, 'protected')).toBe(false)
    expect(await isBlockDeleted(env.repo, 'ordinary')).toBe(false)
    // Refused: the selection is intact so the user can narrow it and retry.
    expect(uiStateBlock.peekProperty(selectionStateProp)?.selectedBlockIds)
      .toEqual(['ordinary', 'protected'])
  })

  it('multi-select Delete clears the selection, so the pane leaves multi-select', async () => {
    // MULTI_SELECT_MODE is modal and stays active while `selectedBlockIds` is
    // non-empty. Leaving the deleted ids there parked the pane in multi-select
    // over tombstones — nothing highlighted, every keystroke still routed to
    // multi-select handlers. `cut` cleared it; `Delete` did not.
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'r'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'one', content: 'one'})
    await env.repo.mutate.createChild({parentId: 'root', id: 'two', content: 'two'})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(selectionStateProp, {
      ...selectionStateProp.defaultValue,
      selectedBlockIds: ['one', 'two'],
    })

    const action = findMultiSelectAction(env.repo, 'multi_select.delete_block')
    await action.handler({
      uiStateBlock,
      selectedBlocks: [env.repo.block('one'), env.repo.block('two')],
      anchorBlock: null,
    } as MultiSelectModeDependencies, {preventDefault: vi.fn()} as unknown as ActionTrigger)

    expect(await isBlockDeleted(env.repo, 'one')).toBe(true)
    expect(await isBlockDeleted(env.repo, 'two')).toBe(true)
    expect(uiStateBlock.peekProperty(selectionStateProp)?.selectedBlockIds).toEqual([])
  })

  it('cut does not delete — it marks the selection as a pending move, even over a block a deletion guard would refuse', async () => {
    // `cut_selected_blocks` is bound to `d` and `$mod+x` in multi-select. It
    // used to be delete-with-a-clipboard-write, so it ran the deletion
    // guards; now it deletes nothing at all (the move happens on a LATER
    // paste, via moveBlocksTo), so there's nothing here for a deletion
    // guard to refuse — a guard the plugin still has registered (e.g. for a
    // genuine delete elsewhere) must not block a cut.
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'r'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'ordinary', content: 'ordinary'})
    await env.repo.mutate.createChild({parentId: 'root', id: 'protected', content: 'protected'})

    const uiStateBlock = env.repo.block('ui')
    env.repo.setFacetRuntime(resolveFacetRuntimeSync([
      // setFacetRuntime REPLACES the registries, so the kernel data
      // contribution has to be re-included or `childIds` stops resolving.
      kernelDataExtension,
      blockDeletionGuardsFacet.of(
        block => (block.id === 'protected' ? 'Nope.' : null),
        {source: 'test'},
      ),
    ]))

    await uiStateBlock.set(selectionStateProp, {
      ...selectionStateProp.defaultValue,
      selectedBlockIds: ['ordinary', 'protected'],
    })
    const write = vi.fn(async () => {})
    vi.stubGlobal('ClipboardItem', class { })
    vi.stubGlobal('navigator', {clipboard: {write}})

    const action = findMultiSelectAction(env.repo, 'cut_selected_blocks')
    await action.handler({
      uiStateBlock,
      selectedBlocks: [env.repo.block('ordinary'), env.repo.block('protected')],
      anchorBlock: null,
    } as MultiSelectModeDependencies, {preventDefault: vi.fn()} as unknown as ActionTrigger)

    expect(await isBlockDeleted(env.repo, 'protected')).toBe(false)
    expect(await isBlockDeleted(env.repo, 'ordinary')).toBe(false)
    expect(write).toHaveBeenCalledTimes(1)
    expect(recallPayloadForText('ordinary\nprotected')).toEqual({
      blockIds: ['ordinary', 'protected'],
      workspaceId: WS,
      intent: 'cut',
      cutId: expect.any(String),
    })
    // Successful cut exits multi-select, same as the old destructive cut did.
    expect(uiStateBlock.peekProperty(selectionStateProp)?.selectedBlockIds).toEqual([])
    vi.unstubAllGlobals()
  })

  it('does not clear a selection the user made WHILE the cut was in flight', async () => {
    // The cut resumes after serializing and writing the clipboard — long
    // enough for the user to have selected something else. Clearing
    // unconditionally erases that newer gesture, whose blocks this cut
    // never touched.
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'r'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'cut-me', content: 'cut-me'})
    await env.repo.mutate.createChild({parentId: 'root', id: 'later', content: 'later'})
    const uiStateBlock = env.repo.block('root')
    await uiStateBlock.set(selectionStateProp, {
      anchorBlockId: 'cut-me',
      selectedBlockIds: ['cut-me'],
    })

    let releaseWrite = (): void => {}
    const writeLanded = new Promise<void>(resolve => { releaseWrite = resolve })
    let writes = 0
    const write = vi.fn(async () => { writes += 1; await writeLanded })
    vi.stubGlobal('ClipboardItem', class { })
    vi.stubGlobal('navigator', {clipboard: {write}})

    const action = findMultiSelectAction(env.repo, 'cut_selected_blocks')
    const running = action.handler({
      uiStateBlock,
      selectedBlocks: [env.repo.block('cut-me')],
      anchorBlock: null,
    } as MultiSelectModeDependencies, {preventDefault: vi.fn()} as unknown as ActionTrigger)

    await vi.waitFor(() => { expect(writes).toBe(1) })
    // The user moves on to a different selection mid-cut.
    await uiStateBlock.set(selectionStateProp, {
      anchorBlockId: 'later',
      selectedBlockIds: ['later'],
    })

    releaseWrite()
    await running

    expect(uiStateBlock.peekProperty(selectionStateProp)?.selectedBlockIds).toEqual(['later'])
    vi.unstubAllGlobals()
  })

  it('normal-mode cut_block ($mod+x) marks just the focused block, without touching selection state', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'r'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'solo', content: 'solo'})

    const write = vi.fn(async () => {})
    vi.stubGlobal('ClipboardItem', class { })
    vi.stubGlobal('navigator', {clipboard: {write}})

    const action = findNormalModeAction(env.repo, 'cut_block')
    await action.handler({
      block: env.repo.block('solo'),
      uiStateBlock: env.repo.block('root'),
    } as BlockShortcutDependencies, {preventDefault: vi.fn()} as unknown as ActionTrigger)

    expect(await isBlockDeleted(env.repo, 'solo')).toBe(false)
    expect(recallPayloadForText('solo')).toEqual({
      blockIds: ['solo'],
      workspaceId: WS,
      intent: 'cut',
      cutId: expect.any(String),
    })
    vi.unstubAllGlobals()
  })

  describe('paste_after_selection completing a cut as a move', () => {
    // `cut`/the fallback tests stub `navigator` via `vi.stubGlobal`, which
    // (unlike `vi.fn()` mocks) persists across tests without
    // `unstubGlobals: true` in the vitest config — clean up so a stubbed,
    // clipboard-less `navigator` doesn't leak into later tests in this file.
    afterEach(() => { vi.unstubAllGlobals() })

    /** Seeds `src/{a,b}` (the blocks to cut) and `dest` (the paste target),
     *  all under `root`, plus the `ui` multi-select panel block. `ref`
     *  contains `((a))`, standing in for a real block-ref — since a move
     *  preserves ids, `ref`'s content is untouched by the move and still
     *  literally points at a live block afterward, which is the property
     *  that makes references survive (unlike the old delete-and-reparse
     *  cut, which minted a new id and left `((a))` pointing at a tombstone). */
    const seed = async (): Promise<void> => {
      await env.repo.tx(async tx => {
        await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
        await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
      }, {scope: ChangeScope.BlockDefault})
      await env.repo.mutate.createChild({parentId: 'root', id: 'src', content: 'src'})
      await env.repo.mutate.createChild({parentId: 'src', id: 'a', content: 'a'})
      await env.repo.mutate.createChild({parentId: 'src', id: 'b', content: 'b'})
      await env.repo.mutate.createChild({parentId: 'root', id: 'dest', content: 'dest'})
      await env.repo.mutate.createChild({parentId: 'root', id: 'existing', content: 'existing'})
      await env.repo.mutate.createChild({parentId: 'root', id: 'ref', content: 'see ((a))'})
    }

    /** Cuts `blockIds` and leaves `navigator.clipboard` stubbed so a later
     *  `readText()` (either `tryPasteAsMove`'s check, or the fallback text
     *  paste re-reading it) returns EXACTLY what was written — a fixed
     *  snapshot taken right after the cut, captured off the real
     *  `ClipboardItem` the cut wrote (identity now travels WITH the
     *  clipboard content, not through a side register — see
     *  `@/paste/clipboardPayload.js`'s module doc). */
    const cut = async (blockIds: string[]): Promise<void> => {
      let clipboardText = ''
      const write = vi.fn(async (items: ClipboardItem[]) => {
        for (const item of items) {
          if (item.types.includes('text/plain')) {
            clipboardText = await (await item.getType('text/plain')).text()
          }
        }
      })
      vi.stubGlobal('navigator', {clipboard: {write, readText: vi.fn(async () => '')}})
      const cutAction = findMultiSelectAction(env.repo, 'cut_selected_blocks')
      await cutAction.handler({
        uiStateBlock: env.repo.block('ui'),
        selectedBlocks: blockIds.map(id => env.repo.block(id)),
        anchorBlock: null,
      } as MultiSelectModeDependencies, {preventDefault: vi.fn()} as unknown as ActionTrigger)

      vi.stubGlobal('navigator', {
        clipboard: {write: vi.fn(async () => {}), readText: vi.fn(async () => clipboardText)},
      })
    }

    const pasteAfter = async (targetId: string): Promise<void> => {
      const pasteAction = findMultiSelectAction(env.repo, 'paste_after_selection')
      await pasteAction.handler({
        uiStateBlock: env.repo.block('ui'),
        selectedBlocks: [env.repo.block(targetId)],
        anchorBlock: null,
      } as MultiSelectModeDependencies, {preventDefault: vi.fn()} as unknown as ActionTrigger)
    }

    it('happy path: moves the cut blocks preserving ids, clears the register, and leaves a reference into the moved subtree resolvable', async () => {
      await seed()
      withPasteAsMoveInstalled()
      await cut(['a'])

      await pasteAfter('existing')

      // Same ids — this is the whole point (vs. the old serialize-delete-
      // reparse, which minted new ones).
      expect(env.repo.block('a').peek()?.content).toBe('a')
      expect(env.repo.block('a').peek()?.parentId).toBe('root')
      expect(await childIds('root')).toEqual(['src', 'dest', 'existing', 'a', 'ref'])
      // 'a' left 'src'; 'b' (never cut) stayed behind.
      expect(await childIds('src')).toEqual(['b'])
      // `ref` was never touched by the move, so its `((a))` still literally
      // names a live block — the reference resolves.
      expect(env.repo.block('ref').peek()?.content).toBe('see ((a))')
      expect(env.repo.block('a').peek()?.deleted).toBe(false)
    })

    it('multiple cut blocks stay in selection order, chained after the target', async () => {
      await seed()
      withPasteAsMoveInstalled()
      await cut(['a', 'b'])

      await pasteAfter('existing')

      expect(await childIds('root')).toEqual(['src', 'dest', 'existing', 'a', 'b', 'ref'])
      expect(await childIds('src')).toEqual([])
    })

    /** Ids added to `root`'s children by the paste, in position order —
     *  vs. asserting the exact list, this survives not knowing in advance
     *  how many blocks a given text splits into. */
    const addedRootChildren = async (before: readonly string[]): Promise<string[]> =>
      (await childIds('root')).filter(id => !before.includes(id))

    it('falls back to a text paste when the OS clipboard no longer matches the register (a copy happened after the cut)', async () => {
      await seed()
      withPasteAsMoveInstalled()
      await cut(['a'])
      const before = await childIds('root')

      // Something else got copied after the cut — in-app or from another
      // app; either way the clipboard text no longer matches the register.
      const readText = vi.fn(async () => 'unrelated text')
      vi.stubGlobal('navigator', {
        clipboard: {
          write: vi.fn(async () => {}),
          readText,
        },
      })

      await pasteAfter('existing')

      // The fallback actually ran: a NEW block was created from the pasted
      // text, parented per the ordinary text-paste rules — not a move (the
      // added id is neither of the cut ones).
      const added = await addedRootChildren(before)
      expect(added.map(id => env.repo.block(id).peek()?.content)).toEqual(['unrelated text'])
      // And the cut block was NOT moved — still exactly where it was.
      expect(env.repo.block('a').peek()?.parentId).toBe('src')
      // Exactly ONE clipboard read for the whole handler invocation — the
      // up-front read is threaded into the fallback's `pasteFromClipboard`
      // call rather than that function re-reading the clipboard itself.
      // Two reads could disagree (a second copy landing in between) or
      // cost a second iOS system-paste prompt.
      expect(readText).toHaveBeenCalledTimes(1)
    })

    it('falls back to a text paste when the pending move belongs to a different workspace, and toasts', async () => {
      await seed()
      withPasteAsMoveInstalled()
      await cut(['a'])
      const before = await childIds('root')

      env.repo.setActiveWorkspaceId('ws-2')
      // dest/existing/ref live in WS, but the paste action only reads
      // `selectedBlocks` — reuse the same (now cross-workspace) target ids.
      await pasteAfter('existing')

      const added = await addedRootChildren(before)
      expect(added.map(id => env.repo.block(id).peek()?.content)).toEqual(['a'])
      expect(env.repo.block('a').peek()?.parentId).toBe('src')
      expect(showInfoMock).toHaveBeenCalledTimes(1)
    })

    it('a cross-workspace mismatch does not disturb the cut — a later paste back in the original workspace still completes the move', async () => {
      // Separate from the "falls back... different workspace" test above
      // (which pastes once, in ws-2): this proves the clipboard payload is
      // actually usable afterward, not just present. Doesn't itself paste
      // in ws-2 — just switches there and back — so it can't race the
      // fallback's fire-and-forget `focusBlock` the way pasting twice
      // back-to-back across a workspace switch would.
      await seed()
      withPasteAsMoveInstalled()
      await cut(['a'])

      env.repo.setActiveWorkspaceId('ws-2')
      // still resolvable, just inapplicable here — nothing clears it on a
      // workspace mismatch, see @/paste/clipboardPayload.js's module doc.
      expect(recallPayloadForText('a')?.blockIds).toEqual(['a'])

      env.repo.setActiveWorkspaceId(WS)
      await pasteAfter('existing')

      expect(env.repo.block('a').peek()?.parentId).toBe('root')
    })

    it('moves the LIVE survivors (not a text-paste duplicate of everything) when a cut block was deleted before the paste', async () => {
      await seed()
      withPasteAsMoveInstalled()
      await cut(['a', 'b'])
      await env.repo.block('b').delete()
      const before = await childIds('root')

      await pasteAfter('existing')

      // 'a' (still live) moved with its original id — no new block was
      // minted for it. 'b' (deleted) was simply skipped, not recreated
      // from the cut markdown.
      const added = await addedRootChildren(before)
      expect(added).toEqual(['a'])
      expect(env.repo.block('a').peek()?.parentId).toBe('root')
    })

    it('refuses (no move, no text-paste duplication) when the destination is inside the cut subtree', async () => {
      await seed()
      withPasteAsMoveInstalled()
      await cut(['src']) // src has children a, b — cutting the whole subtree

      // Paste "after a" — a is a child of src, i.e. inside the moving subtree.
      await pasteAfter('a')

      // Nothing moved...
      expect(env.repo.block('src').peek()?.parentId).toBe('root')
      expect(env.repo.block('a').peek()?.parentId).toBe('src')
      // ...and nothing was duplicated via a fallback text paste either.
      expect(await childIds('src')).toEqual(['a', 'b'])
      expect(await childIds('root')).toEqual(['src', 'dest', 'existing', 'ref'])
    })
  })

  it("merges a first child with children into its parent when it is the parent's only child", async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'parent', content: 'parent '})
    await env.repo.mutate.createChild({parentId: 'parent', id: 'current', content: 'current'})
    await env.repo.mutate.createChild({parentId: 'current', id: 'child', content: 'child'})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')
    await focusBlock(uiStateBlock, 'current')

    const action = findEditModeAction(env.repo, 'delete_empty_block_cm')
    const trigger = {preventDefault: vi.fn()} as unknown as ActionTrigger

    await action.handler({
      block: env.repo.block('current'),
      editorView: codeMirrorEditorView('current', 0),
      uiStateBlock,
      scopeRootId: 'root',
    } satisfies CodeMirrorEditModeDependencies, trigger)

    expect(trigger.preventDefault).toHaveBeenCalledTimes(1)
    expect(env.repo.block('parent').peek()?.content).toBe('parent current')
    expect(env.repo.block('current').peek()).toBeNull()
    expect(env.repo.block('current').peekRaw()?.deleted).toBe(true)
    expect(await childIds('parent')).toEqual(['child'])
    expect(env.repo.block('child').peek()?.deleted).toBe(false)
    expect(peekFocusedBlockLocation(uiStateBlock)?.blockId).toBe('parent')
    expect(uiStateBlock.peekProperty(editorSelection)).toEqual({
      blockId: 'parent',
      start: 'parent '.length,
    })
  })

  it('does not merge when both blocks have independent children', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'parent', content: 'parent '})
    await env.repo.mutate.createChild({parentId: 'parent', id: 'current', content: 'current'})
    await env.repo.mutate.createChild({parentId: 'parent', id: 'sibling', content: 'sibling'})
    await env.repo.mutate.createChild({parentId: 'current', id: 'child', content: 'child'})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')
    await focusBlock(uiStateBlock, 'current')

    const action = findEditModeAction(env.repo, 'delete_empty_block_cm')
    const trigger = {preventDefault: vi.fn()} as unknown as ActionTrigger

    await action.handler({
      block: env.repo.block('current'),
      editorView: codeMirrorEditorView('current', 0),
      uiStateBlock,
      scopeRootId: 'root',
    } satisfies CodeMirrorEditModeDependencies, trigger)

    expect(trigger.preventDefault).not.toHaveBeenCalled()
    expect(env.repo.block('parent').peek()?.content).toBe('parent ')
    expect(env.repo.block('current').peek()?.deleted).toBe(false)
    expect(await childIds('parent')).toEqual(['current', 'sibling'])
    expect(await childIds('current')).toEqual(['child'])
  })

  it('a guarded next block is not merged away — and the editor is left untouched', async () => {
    // A merge DESTROYS the next block (`core.merge` soft-deletes its `from`),
    // so it needs the deletion guards. The editor assertion is the load-bearing
    // one: this handler re-arms CodeMirror with the concatenated text, and that
    // dispatch is a real doc change, so `onChange` → debounced `pushChange`
    // persists it. Guarding after the dispatch (as the first version did) left
    // a refused merge writing the merged content while the next block survived.
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'current', content: 'current'})
    await env.repo.mutate.createChild({parentId: 'root', id: 'protected', content: 'protected'})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')
    await focusBlock(uiStateBlock, 'current')
    env.repo.setFacetRuntime(resolveFacetRuntimeSync([
      kernelDataExtension,
      blockDeletionGuardsFacet.of(
        block => (block.id === 'protected' ? 'Nope.' : null),
        {source: 'test'},
      ),
    ]))

    const action = findEditModeAction(env.repo, 'merge_next_block_cm')
    const editorView = codeMirrorEditorView('current', 'current'.length)
    await action.handler({
      block: env.repo.block('current'),
      editorView,
      uiStateBlock,
      scopeRootId: 'root',
    } satisfies CodeMirrorEditModeDependencies, {preventDefault: vi.fn()} as unknown as ActionTrigger)

    expect(await isBlockDeleted(env.repo, 'protected')).toBe(false)
    expect(env.repo.block('current').peek()?.content).toBe('current')
    // No half-applied merge parked in the editor waiting to be flushed.
    expect(editorView.state.doc.toString()).toBe('current')
  })

  it('a guarded block is not merged away by Backspace at offset 0', async () => {
    // The Backspace twin of the above: this branch merges the CURRENT block
    // into the previous one, which destroys the current block.
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'first', content: 'first'})
    await env.repo.mutate.createChild({parentId: 'root', id: 'protected', content: 'protected'})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')
    await focusBlock(uiStateBlock, 'protected')
    env.repo.setFacetRuntime(resolveFacetRuntimeSync([
      kernelDataExtension,
      blockDeletionGuardsFacet.of(
        block => (block.id === 'protected' ? 'Nope.' : null),
        {source: 'test'},
      ),
    ]))

    const action = findEditModeAction(env.repo, 'delete_empty_block_cm')
    await action.handler({
      block: env.repo.block('protected'),
      editorView: codeMirrorEditorView('protected', 0),
      uiStateBlock,
      scopeRootId: 'root',
    } satisfies CodeMirrorEditModeDependencies, {preventDefault: vi.fn()} as unknown as ActionTrigger)

    expect(await isBlockDeleted(env.repo, 'protected')).toBe(false)
    expect(env.repo.block('first').peek()?.content).toBe('first')
  })

  it('merges the next block into the current block when pressing delete at block end', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'current', content: 'current'})
    await env.repo.mutate.createChild({parentId: 'root', id: 'next', content: 'next'})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')
    await focusBlock(uiStateBlock, 'current')

    const action = findEditModeAction(env.repo, 'merge_next_block_cm')
    const trigger = {preventDefault: vi.fn()} as unknown as ActionTrigger
    const editorView = codeMirrorEditorView('current', 'current'.length)

    await action.handler({
      block: env.repo.block('current'),
      editorView,
      uiStateBlock,
      scopeRootId: 'root',
    } satisfies CodeMirrorEditModeDependencies, trigger)

    expect(trigger.preventDefault).toHaveBeenCalledTimes(1)
    expect(env.repo.block('current').peek()?.content).toBe('currentnext')
    expect(env.repo.block('next').peek()).toBeNull()
    expect(env.repo.block('next').peekRaw()?.deleted).toBe(true)
    // Focus stays in this block, caret parked at the join; the editor is
    // re-armed synchronously with the merged text so a debounced flush
    // can't roll it back.
    expect(editorView.state.doc.toString()).toBe('currentnext')
    expect(editorView.state.selection.main.from).toBe('current'.length)
    expect(peekFocusedBlockLocation(uiStateBlock)?.blockId).toBe('current')
    expect(uiStateBlock.peekProperty(editorSelection)).toEqual({
      blockId: 'current',
      start: 'current'.length,
    })
  })

  it('deletes an empty next block when pressing delete at block end', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'current', content: 'current'})
    await env.repo.mutate.createChild({parentId: 'root', id: 'empty', content: ''})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')
    await focusBlock(uiStateBlock, 'current')

    const action = findEditModeAction(env.repo, 'merge_next_block_cm')
    const trigger = {preventDefault: vi.fn()} as unknown as ActionTrigger

    await action.handler({
      block: env.repo.block('current'),
      editorView: codeMirrorEditorView('current', 'current'.length),
      uiStateBlock,
      scopeRootId: 'root',
    } satisfies CodeMirrorEditModeDependencies, trigger)

    expect(trigger.preventDefault).toHaveBeenCalledTimes(1)
    expect(env.repo.block('current').peek()?.content).toBe('current')
    expect(env.repo.block('empty').peek()).toBeNull()
    expect(env.repo.block('empty').peekRaw()?.deleted).toBe(true)
  })

  it("merges an only child into its parent when pressing delete at the parent's end", async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'parent', content: 'parent '})
    await env.repo.mutate.createChild({parentId: 'parent', id: 'current', content: 'current'})
    await env.repo.mutate.createChild({parentId: 'current', id: 'child', content: 'child'})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')
    await focusBlock(uiStateBlock, 'parent')

    const action = findEditModeAction(env.repo, 'merge_next_block_cm')
    const trigger = {preventDefault: vi.fn()} as unknown as ActionTrigger

    await action.handler({
      block: env.repo.block('parent'),
      editorView: codeMirrorEditorView('parent ', 'parent '.length),
      uiStateBlock,
      scopeRootId: 'root',
    } satisfies CodeMirrorEditModeDependencies, trigger)

    expect(trigger.preventDefault).toHaveBeenCalledTimes(1)
    expect(env.repo.block('parent').peek()?.content).toBe('parent current')
    expect(env.repo.block('current').peek()).toBeNull()
    expect(env.repo.block('current').peekRaw()?.deleted).toBe(true)
    expect(await childIds('parent')).toEqual(['child'])
    expect(env.repo.block('child').peek()?.deleted).toBe(false)
    expect(peekFocusedBlockLocation(uiStateBlock)?.blockId).toBe('parent')
    expect(uiStateBlock.peekProperty(editorSelection)).toEqual({
      blockId: 'parent',
      start: 'parent '.length,
    })
  })

  it('does not merge the next block when both blocks have independent children', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'a', content: 'a'})
    await env.repo.mutate.createChild({parentId: 'a', id: 'ac', content: 'ac'})
    await env.repo.mutate.createChild({parentId: 'root', id: 'b', content: 'b'})
    await env.repo.mutate.createChild({parentId: 'b', id: 'bc', content: 'bc'})
    // Collapse `a` so its next visible block is sibling `b` (not child `ac`),
    // putting two independent child lists on either side of the boundary.
    await env.repo.block('a').set(isCollapsedProp, true)

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')
    await focusBlock(uiStateBlock, 'a')

    const action = findEditModeAction(env.repo, 'merge_next_block_cm')
    const trigger = {preventDefault: vi.fn()} as unknown as ActionTrigger

    await action.handler({
      block: env.repo.block('a'),
      editorView: codeMirrorEditorView('a', 'a'.length),
      uiStateBlock,
      scopeRootId: 'root',
    } satisfies CodeMirrorEditModeDependencies, trigger)

    expect(trigger.preventDefault).not.toHaveBeenCalled()
    expect(env.repo.block('a').peek()?.content).toBe('a')
    expect(env.repo.block('b').peek()?.deleted).toBe(false)
    expect(await childIds('a')).toEqual(['ac'])
    expect(await childIds('b')).toEqual(['bc'])
  })

  it('stands aside (no merge) when pressing delete at the end of the last visible block', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'current', content: 'current'})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')
    await focusBlock(uiStateBlock, 'current')

    const action = findEditModeAction(env.repo, 'merge_next_block_cm')
    const trigger = {preventDefault: vi.fn()} as unknown as ActionTrigger

    await action.handler({
      block: env.repo.block('current'),
      editorView: codeMirrorEditorView('current', 'current'.length),
      uiStateBlock,
      scopeRootId: 'root',
    } satisfies CodeMirrorEditModeDependencies, trigger)

    expect(trigger.preventDefault).not.toHaveBeenCalled()
    expect(env.repo.block('current').peek()?.content).toBe('current')
    expect(env.repo.block('current').peek()?.deleted).toBe(false)
  })

  it('stands aside (no merge) when the caret is not at the block end', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'current', content: 'current'})
    await env.repo.mutate.createChild({parentId: 'root', id: 'next', content: 'next'})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')
    await focusBlock(uiStateBlock, 'current')

    const action = findEditModeAction(env.repo, 'merge_next_block_cm')
    const trigger = {preventDefault: vi.fn()} as unknown as ActionTrigger

    await action.handler({
      block: env.repo.block('current'),
      // Caret mid-block, not at the end — CodeMirror's own forward-delete owns
      // this; the merge must stand aside or it would fire on every Delete.
      editorView: codeMirrorEditorView('current', 3),
      uiStateBlock,
      scopeRootId: 'root',
    } satisfies CodeMirrorEditModeDependencies, trigger)

    expect(trigger.preventDefault).not.toHaveBeenCalled()
    expect(env.repo.block('current').peek()?.content).toBe('current')
    expect(env.repo.block('next').peek()?.deleted).toBe(false)
  })

  it('stands aside (no merge) when there is a non-empty selection', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'current', content: 'current'})
    await env.repo.mutate.createChild({parentId: 'root', id: 'next', content: 'next'})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')
    await focusBlock(uiStateBlock, 'current')

    const action = findEditModeAction(env.repo, 'merge_next_block_cm')
    const trigger = {preventDefault: vi.fn()} as unknown as ActionTrigger

    const editorView = codeMirrorEditorView('current', 'current'.length)
    // A selection that reaches the block end but is NOT empty — CodeMirror's
    // delete removes the selected range, so the merge must stand aside even
    // though `sel.to === doc.length`.
    editorView.dispatch({selection: {anchor: 2, head: 'current'.length}})

    await action.handler({
      block: env.repo.block('current'),
      editorView,
      uiStateBlock,
      scopeRootId: 'root',
    } satisfies CodeMirrorEditModeDependencies, trigger)

    expect(trigger.preventDefault).not.toHaveBeenCalled()
    expect(env.repo.block('current').peek()?.content).toBe('current')
    expect(env.repo.block('next').peek()?.deleted).toBe(false)
  })

  it('stands aside (no merge) when pressing delete at the end of the scope root', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'child', content: 'child'})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')
    await focusBlock(uiStateBlock, 'root')

    const action = findEditModeAction(env.repo, 'merge_next_block_cm')
    const trigger = {preventDefault: vi.fn()} as unknown as ActionTrigger

    await action.handler({
      // The next visible block from the scope root is its own first child;
      // absorbing it up into the page/view header is refused (mirror of
      // Backspace refusing to merge the scope root upward).
      block: env.repo.block('root'),
      editorView: codeMirrorEditorView('', 0),
      uiStateBlock,
      scopeRootId: 'root',
    } satisfies CodeMirrorEditModeDependencies, trigger)

    expect(trigger.preventDefault).not.toHaveBeenCalled()
    expect(await childIds('root')).toEqual(['child'])
    expect(env.repo.block('child').peek()?.deleted).toBe(false)
  })

  it('absorbs the next block into an empty current block on delete at block end', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'current', content: ''})
    await env.repo.mutate.createChild({parentId: 'root', id: 'next', content: 'next'})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')
    await focusBlock(uiStateBlock, 'current')

    const action = findEditModeAction(env.repo, 'merge_next_block_cm')
    const trigger = {preventDefault: vi.fn()} as unknown as ActionTrigger

    await action.handler({
      // Forward-delete on an empty block pulls the next block's text up into
      // it (a text editor's Delete on an empty line) — unlike Backspace-on-
      // empty, which deletes the empty block and moves focus up.
      block: env.repo.block('current'),
      editorView: codeMirrorEditorView('', 0),
      uiStateBlock,
      scopeRootId: 'root',
    } satisfies CodeMirrorEditModeDependencies, trigger)

    expect(trigger.preventDefault).toHaveBeenCalledTimes(1)
    expect(env.repo.block('current').peek()?.content).toBe('next')
    expect(env.repo.block('next').peek()).toBeNull()
    expect(env.repo.block('next').peekRaw()?.deleted).toBe(true)
  })

  it("re-homes a folded-up child's own children in order when delete merges an only child", async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'parent', content: 'parent '})
    await env.repo.mutate.createChild({parentId: 'parent', id: 'current', content: 'current'})
    await env.repo.mutate.createChild({parentId: 'current', id: 'c1', content: 'c1'})
    await env.repo.mutate.createChild({parentId: 'current', id: 'c2', content: 'c2'})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')
    await focusBlock(uiStateBlock, 'parent')

    const action = findEditModeAction(env.repo, 'merge_next_block_cm')
    const trigger = {preventDefault: vi.fn()} as unknown as ActionTrigger

    await action.handler({
      block: env.repo.block('parent'),
      editorView: codeMirrorEditorView('parent ', 'parent '.length),
      uiStateBlock,
      scopeRootId: 'root',
    } satisfies CodeMirrorEditModeDependencies, trigger)

    expect(trigger.preventDefault).toHaveBeenCalledTimes(1)
    expect(env.repo.block('parent').peek()?.content).toBe('parent current')
    expect(env.repo.block('current').peek()).toBeNull()
    // `current` was parent's only child, so its grandchildren take its slot —
    // re-homed under parent with their relative order preserved.
    expect(await childIds('parent')).toEqual(['c1', 'c2'])
  })

  it('splits a middle block into a prefix sibling above and keeps focus on the suffix block', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'current', content: 'left right'})
    await env.repo.mutate.createChild({parentId: 'current', id: 'child', content: 'child'})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')
    await focusBlock(uiStateBlock, 'current')

    const editorView = codeMirrorEditorView('left right', 'left '.length)
    const action = findEditModeAction(env.repo, 'split_block_cm')

    await action.handler({
      block: env.repo.block('current'),
      editorView,
      uiStateBlock,
      scopeRootId: 'root',
    } satisfies CodeMirrorEditModeDependencies, {preventDefault: vi.fn()} as unknown as ActionTrigger)

    const rootChildren = await childIds('root')
    const prefixId = rootChildren[0]

    expect(rootChildren).toEqual([prefixId, 'current'])
    expect(env.repo.block(prefixId).peek()?.content).toBe('left ')
    expect(env.repo.block('current').peek()?.content).toBe('right')
    expect(await childIds(prefixId)).toEqual([])
    expect(await childIds('current')).toEqual(['child'])
    expect(editorView.state.doc.toString()).toBe('right')
    expect(editorView.state.selection.main.head).toBe(0)
    expect(peekFocusedBlockLocation(uiStateBlock)?.blockId).toBe('current')
    expect(uiStateBlock.peekProperty(editorSelection)).toEqual({
      blockId: 'current',
      start: 0,
    })
  })

  // Scope-root behaviour: when the focused block is the root of the
  // surface's visible subtree (e.g. a backlink entry's shown block,
  // where scopeRootId === the block's own id) a "new block below" must
  // land as a first child so it stays visible — a sibling would be
  // created outside the surface. These mirror what happens for a
  // panel's top-level block but now key off scopeRootId, so any nested
  // surface gets the same behaviour.
  it('creates a first child (not a sibling) when Enter is pressed at the end of a scope-root block', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'shown', content: 'shown'})

    const uiStateBlock = env.repo.block('ui')
    await focusBlock(uiStateBlock, 'shown')

    const action = findEditModeAction(env.repo, 'split_block_cm')
    await action.handler({
      block: env.repo.block('shown'),
      editorView: codeMirrorEditorView('shown', 'shown'.length),
      uiStateBlock,
      // The shown block is its own scope root (no children yet).
      scopeRootId: 'shown',
    } satisfies CodeMirrorEditModeDependencies, {preventDefault: vi.fn()} as unknown as ActionTrigger)

    // New block lands as a child of the scope root, not a sibling under root.
    expect(await childIds('root')).toEqual(['shown'])
    expect(await childIds('shown')).toHaveLength(1)
  })

  it('reveals a COLLAPSED scope-root block when Enter creates its first child', async () => {
    // A nested scope root (backlink/embed) isn't isTopLevel, so a
    // collapsed root would hide the new child inside a closed
    // Collapsible. Enter must reveal the root so the inserted+focused
    // block is visible.
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'shown', content: 'shown'})
    await env.repo.mutate.createChild({parentId: 'shown', id: 'existing', content: 'existing'})
    await env.repo.mutate.setProperty({id: 'shown', schema: isCollapsedProp, value: true})

    const uiStateBlock = env.repo.block('ui')
    await focusBlock(uiStateBlock, 'shown')

    const action = findEditModeAction(env.repo, 'split_block_cm')
    await action.handler({
      block: env.repo.block('shown'),
      editorView: codeMirrorEditorView('shown', 'shown'.length),
      uiStateBlock,
      scopeRootId: 'shown',
    } satisfies CodeMirrorEditModeDependencies, {preventDefault: vi.fn()} as unknown as ActionTrigger)

    // Root revealed, and the new block is its first child (above 'existing').
    expect(env.repo.block('shown').peek()?.properties[isCollapsedProp.name]).toBe(false)
    const children = await childIds('shown')
    expect(children).toHaveLength(2)
    expect(children[1]).toBe('existing')
  })

  it('keeps the before-text in a scope-root block and pushes the suffix into a new first child on mid-text split', async () => {
    // A normal mid-text split makes the before-text a preceding sibling;
    // at the scope root that sibling is outside the surface, so the root
    // keeps the before-text and the continuation becomes its first child.
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'shown', content: 'left right'})
    await env.repo.mutate.createChild({parentId: 'shown', id: 'existing', content: 'existing'})

    const uiStateBlock = env.repo.block('ui')
    await focusBlock(uiStateBlock, 'shown')

    const editorView = codeMirrorEditorView('left right', 'left '.length)
    const action = findEditModeAction(env.repo, 'split_block_cm')
    await action.handler({
      block: env.repo.block('shown'),
      editorView,
      uiStateBlock,
      scopeRootId: 'shown',
    } satisfies CodeMirrorEditModeDependencies, {preventDefault: vi.fn()} as unknown as ActionTrigger)

    // Root unchanged in the parent's children; before-text stays in it.
    expect(await childIds('root')).toEqual(['shown'])
    expect(env.repo.block('shown').peek()?.content).toBe('left ')

    // Suffix lands as the new first child, ahead of the existing child.
    const children = await childIds('shown')
    const suffixId = children[0]
    expect(children).toEqual([suffixId, 'existing'])
    expect(env.repo.block(suffixId).peek()?.content).toBe('right')

    // Editor and focus follow the suffix block.
    expect(editorView.state.doc.toString()).toBe('left ')
    expect(peekFocusedBlockLocation(uiStateBlock)?.blockId).toBe(suffixId)
    expect(uiStateBlock.peekProperty(editorSelection)).toEqual({blockId: suffixId, start: 0})
  })

  it('makes Tab a no-op on a scope-root block', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'first', content: 'first'})
    await env.repo.mutate.createChild({parentId: 'root', id: 'shown', content: 'shown'})

    const uiStateBlock = env.repo.block('ui')
    const action = findEditModeAction(env.repo, 'edit.cm.indent_block')
    await action.handler({
      block: env.repo.block('shown'),
      editorView: codeMirrorEditorView('shown', 0),
      uiStateBlock,
      // 'shown' is the scope root even though it has a previous sibling
      // ('first') in the real tree — indenting would escape the surface.
      scopeRootId: 'shown',
    } satisfies CodeMirrorEditModeDependencies, {preventDefault: vi.fn()} as unknown as ActionTrigger)

    // Unchanged: still a direct child of root, not reparented under 'first'.
    expect(await childIds('root')).toEqual(['first', 'shown'])
    expect(await childIds('first')).toEqual([])
  })

  it('deletes a block even without a scopeRootId (non-React action runners)', async () => {
    // scopeRootId only locates the post-delete focus target; imperative
    // runners (agent-runtime bridge) may not supply one, but the delete
    // itself must still happen.
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'victim', content: 'x'})

    const {deleteBlock} = createSharedBlockActions({repo: env.repo})
    await deleteBlock.handler(
      {block: env.repo.block('victim'), uiStateBlock: env.repo.block('ui')},
      {preventDefault: vi.fn()} as unknown as ActionTrigger,
    )

    expect(env.repo.block('victim').peek()).toBeNull()
    expect(env.repo.block('victim').peekRaw()?.deleted).toBe(true)
  })

  it('deletes the focal page when the pane is a real panel surface', async () => {
    // Delete on the panel's own page. The handler just deletes it (and its
    // subtree) — a real panel row carries a mounted PanelContentRecovery
    // watcher that navigates the pane off the tombstone separately, so the
    // handler no longer steers navigation itself.
    await env.repo.tx(async tx => {
      await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'page'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'page', id: 'child', content: 'child'})

    const rootUiState = await getUIStateBlock(env.repo, WS, USER, {})
    const layoutSession = await getLayoutSessionBlock(rootUiState, env.repo.activeLayoutSessionId)
    const panelId = await insertPanelRow(env.repo, layoutSession, 'page')
    const uiStateBlock = env.repo.block(panelId)

    const {deleteBlock} = createSharedBlockActions({repo: env.repo})
    await deleteBlock.handler(
      {block: env.repo.block('page'), uiStateBlock, scopeRootId: 'page'},
      {preventDefault: vi.fn()} as unknown as ActionTrigger,
    )

    expect(await isBlockDeleted(env.repo, 'page')).toBe(true)
    expect(await isBlockDeleted(env.repo, 'child')).toBe(true)
  })

  it('deletes the focal page headlessly too (no panel surface required)', async () => {
    // A bare UI-state block (agent bridge, fuzz harness) has no panel row and no
    // recovery watcher. The delete still goes through: deletion is not a
    // scope-relative decision, and the handler deliberately doesn't inspect the
    // surface — recovery is the surface's job, and a headless caller has no
    // surface to recover.
    await env.repo.tx(async tx => {
      await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'page'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'page')

    const {deleteBlock} = createSharedBlockActions({repo: env.repo})
    await deleteBlock.handler(
      {block: env.repo.block('page'), uiStateBlock, scopeRootId: 'page'},
      {preventDefault: vi.fn()} as unknown as ActionTrigger,
    )

    expect(await isBlockDeleted(env.repo, 'page')).toBe(true)
  })

  it('Shift+Up from the first bullet selects the whole page, and Delete then removes it', async () => {
    // Records ACCEPTED behaviour, deliberately, so it isn't left living only in
    // a fuzz-harness exclusion. `previousVisibleBlock` returns the parent even
    // when it is the scope root, and `validateSelectionHierarchy` keeps an
    // ancestor while dropping its descendants — so a second extend-up from a
    // page's first bullet COLLAPSES the selection onto the page rather than
    // growing it. Deleting then takes the page and its subtree.
    //
    // This is intended: the page renders highlighted while selected (the
    // selection background wraps `<Children/>`, so the whole subtree is
    // visibly shaded), and deleting a selected block has always taken its
    // subtree. If the collapse is ever made to stop at the scope root instead,
    // this test should fail and be rewritten — that's the point of it.
    await env.repo.tx(async tx => {
      await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'page'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'page', id: 'c1', content: 'first'})
    await env.repo.mutate.createChild({parentId: 'page', id: 'c2', content: 'second'})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'page')
    await focusBlock(uiStateBlock, 'c1')

    const {extendSelectionUp, deleteBlock} = createSharedBlockActions({repo: env.repo})
    const deps = {uiStateBlock, block: env.repo.block('c1'), scopeRootId: 'page'}
    const trigger = {preventDefault: vi.fn()} as unknown as ActionTrigger

    await extendSelectionUp.handler(deps, trigger)
    expect(uiStateBlock.peekProperty(selectionStateProp)?.selectedBlockIds).toEqual(['c1'])

    // Second press: collapses onto the page rather than extending.
    await extendSelectionUp.handler(deps, trigger)
    expect(uiStateBlock.peekProperty(selectionStateProp)?.selectedBlockIds).toEqual(['page'])

    await deleteBlock.handler(
      {uiStateBlock, block: env.repo.block('page'), scopeRootId: 'page'},
      trigger,
    )

    expect(await isBlockDeleted(env.repo, 'page')).toBe(true)
    expect(await isBlockDeleted(env.repo, 'c1')).toBe(true)
  })

  it('refuses when a registered deletion guard vetoes the block', async () => {
    // The guard facet is how daily-notes protects its get-or-create pages.
    // Multi-select delete fans out through this same handler, so it's covered
    // by the same check.
    await env.repo.tx(async tx => {
      await tx.create({id: 'protected', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'p'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    env.repo.setFacetRuntime(resolveFacetRuntimeSync([
      // setFacetRuntime REPLACES the registries, so the kernel data
      // contribution has to be re-included or `childIds` stops resolving.
      kernelDataExtension,
      blockDeletionGuardsFacet.of(
        block => (block.id === 'protected' ? 'Nope.' : null),
        {source: 'test'},
      ),
    ]))

    const {deleteBlock} = createSharedBlockActions({repo: env.repo})
    await deleteBlock.handler(
      {block: env.repo.block('protected'), uiStateBlock: env.repo.block('ui'), scopeRootId: 'protected'},
      {preventDefault: vi.fn()} as unknown as ActionTrigger,
    )

    expect(await isBlockDeleted(env.repo, 'protected')).toBe(false)
  })

  it('deletes a non-focal scope root (a backlink/embed of another block)', async () => {
    // A block rendered as the scope root of a NESTED surface (an embed / backlink
    // entry of a different block than the pane's page) is an ordinary deletable
    // block — the nested surface just re-queries. It is NOT the focal page, so
    // it takes the normal delete path (no page-delete gating).
    await env.repo.tx(async tx => {
      await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'page'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'page', id: 'embedded', content: 'embedded'})

    const uiStateBlock = env.repo.block('ui')
    // Panel shows 'page'; 'embedded' is the scope root of a nested embed surface.
    await uiStateBlock.set(topLevelBlockIdProp, 'page')

    const {deleteBlock} = createSharedBlockActions({repo: env.repo})
    await deleteBlock.handler(
      {block: env.repo.block('embedded'), uiStateBlock, scopeRootId: 'embedded'},
      {preventDefault: vi.fn()} as unknown as ActionTrigger,
    )

    expect(await isBlockDeleted(env.repo, 'embedded')).toBe(true)
  })
})
