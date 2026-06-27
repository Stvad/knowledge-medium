// @vitest-environment jsdom

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import type { EditorView } from '@codemirror/view'
import { ChangeScope, type User } from '@/data/api'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import {
  editorSelection,
  focusBlock,
  focusedBlockLocationProp,
  isCollapsedProp,
  isEditingProp,
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
import {
  __resetLayoutSessionIdForTesting,
  getLayoutSessionId,
} from '@/utils/layoutSessionId'
import {
  insertPanelRow,
  panelBlockId,
  panelRowsInLayoutOrder,
} from '@/utils/panelLayoutProjection'
import { outlineRenderScopeId } from '@/utils/renderScope'
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionTrigger,
  type BlockShortcutDependencies,
  type CodeMirrorEditModeDependencies,
} from '@/shortcuts/types'
import { createSharedBlockActions } from '@/shortcuts/blockActions'

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

const codeMirrorEditorView = (content: string, cursor: number): EditorView => {
  let text = content
  let selection = makeSelection(cursor)

  const view = {
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

const isDeleted = async (id: string): Promise<boolean> => {
  const row = await env.h.db.get<{deleted: number}>('SELECT deleted FROM blocks WHERE id = ?', [id])
  return row.deleted === 1
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  __resetLayoutSessionIdForTesting()
  env = await setup()
})

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
    const layoutSession = await getLayoutSessionBlock(rootUiState, getLayoutSessionId())
    const prefsBlock = await getUserPrefsBlock(env.repo, WS, USER)

    await action.handler(
      {uiStateBlock: rootUiState},
      {preventDefault: vi.fn()} as unknown as ActionTrigger,
    )

    await waitFor(async () => {
      const rows = await env.repo.query.subtree({id: layoutSession.id}).load()
      const panels = panelRowsInLayoutOrder(layoutSession.id, rows)
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

    expect(await isDeleted('panel')).toBe(true)
  })

  it('closes the current panel from CodeMirror edit mode', async () => {
    const {uiStateBlock, block} = await seedPanelAndContent()
    const action = findEditModeAction(env.repo, 'edit.cm.close_current_panel')

    await action.handler({
      block,
      editorView: emptyEditorView(),
      uiStateBlock,
    } satisfies CodeMirrorEditModeDependencies, {preventDefault: vi.fn()} as unknown as ActionTrigger)

    expect(await isDeleted('panel')).toBe(true)
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
    const layoutSession = await getLayoutSessionBlock(rootUiState, getLayoutSessionId())
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
      renderScopeId: outlineRenderScopeId('root'),
    })
    expect(panelBlock.peekProperty(isEditingProp)).toBe(true)
  })

  it('defaults cross-block focus to the panel outline scope instead of preserving stale nested scope', async () => {
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

    expect(uiStateBlock.peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'next',
      renderScopeId: outlineRenderScopeId('root'),
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
})
