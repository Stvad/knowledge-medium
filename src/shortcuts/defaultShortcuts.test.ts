// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import type { EditorView } from '@codemirror/view'
import { BlockCache } from '@/data/blockCache'
import { ChangeScope, type User } from '@/data/api'
import { Repo } from '@/data/repo'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import {
  editorSelection,
  focusBlock,
  focusedBlockLocationProp,
  isEditingProp,
  peekFocusedBlockLocation,
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

const WS = 'ws-1'
const USER: User = {id: 'user-1'}

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  const h = await createTestDb()
  const cache = new BlockCache()
  const repo = new Repo({
    db: h.db,
    cache,
    user: USER,
    registerKernelProcessors: false,
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

let env: Harness
beforeEach(async () => {
  __resetLayoutSessionIdForTesting()
  env = await setup()
})
afterEach(async () => { await env.h.cleanup() })

describe('default CodeMirror shortcuts', () => {
  it('prevents native CodeMirror handling for structural move shortcuts', () => {
    const moveBlockUpAction = findEditModeAction(env.repo, 'move_block_up_cm')
    const moveBlockDownAction = findEditModeAction(env.repo, 'move_block_down_cm')

    expect(moveBlockUpAction.defaultBinding?.eventOptions?.preventDefault).toBe(true)
    expect(moveBlockDownAction.defaultBinding?.eventOptions?.preventDefault).toBe(true)
  })

  it('prevents native CodeMirror text selection for block selection expansion shortcuts', () => {
    const extendSelectionUpAction = findEditModeAction(env.repo, 'edit.cm.extend_selection_up')
    const extendSelectionDownAction = findEditModeAction(env.repo, 'edit.cm.extend_selection_down')

    expect(extendSelectionUpAction.defaultBinding?.eventOptions?.preventDefault).toBe(true)
    expect(extendSelectionDownAction.defaultBinding?.eventOptions?.preventDefault).toBe(true)
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
    } satisfies CodeMirrorEditModeDependencies, trigger)

    expect(trigger.preventDefault).toHaveBeenCalledTimes(1)
    expect(env.repo.block('empty').peek()?.deleted).toBe(true)
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
    } satisfies CodeMirrorEditModeDependencies, trigger)

    expect(trigger.preventDefault).toHaveBeenCalledTimes(1)
    expect(env.repo.block('parent').peek()?.content).toBe('parent current')
    expect(env.repo.block('current').peek()?.deleted).toBe(true)
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

  it('pastes multi-line clipboard text into the current block verbatim instead of splitting', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'current', content: 'ab'})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')

    const readText = vi.fn().mockResolvedValue('line1\nline2')
    vi.stubGlobal('navigator', {clipboard: {readText}})

    try {
      // Cursor between "a" and "b".
      const editorView = codeMirrorEditorView('ab', 1)
      const action = findEditModeAction(env.repo, 'paste_into_block_cm')

      await action.handler({
        block: env.repo.block('current'),
        editorView,
        uiStateBlock,
      } satisfies CodeMirrorEditModeDependencies, {preventDefault: vi.fn()} as unknown as ActionTrigger)

      // Newlines land in the same editor doc; no sibling/child blocks created.
      expect(editorView.state.doc.toString()).toBe('aline1\nline2b')
      expect(await childIds('current')).toEqual([])
      expect(await childIds('root')).toEqual(['current'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('replaces the selected range when pasting into the current block', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'current', content: 'hello world'})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')

    const readText = vi.fn().mockResolvedValue('AAA\nBBB')
    vi.stubGlobal('navigator', {clipboard: {readText}})

    try {
      const editorView = codeMirrorEditorView('hello world', 0)
      // Select "hello"; pasting should replace it (Roam-style).
      editorView.dispatch({selection: {anchor: 0, head: 'hello'.length}})
      const action = findEditModeAction(env.repo, 'paste_into_block_cm')

      await action.handler({
        block: env.repo.block('current'),
        editorView,
        uiStateBlock,
      } satisfies CodeMirrorEditModeDependencies, {preventDefault: vi.fn()} as unknown as ActionTrigger)

      expect(editorView.state.doc.toString()).toBe('AAA\nBBB world')
      expect(await childIds('current')).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('no-ops without throwing when the Clipboard API is unavailable', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'current', content: 'keep me'})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')

    // No `clipboard` on navigator — e.g. an insecure HTTP context.
    vi.stubGlobal('navigator', {})

    try {
      const editorView = codeMirrorEditorView('keep me', 0)
      const action = findEditModeAction(env.repo, 'paste_into_block_cm')

      await expect(action.handler({
        block: env.repo.block('current'),
        editorView,
        uiStateBlock,
      } satisfies CodeMirrorEditModeDependencies, {preventDefault: vi.fn()} as unknown as ActionTrigger))
        .resolves.toBeUndefined()

      expect(editorView.state.doc.toString()).toBe('keep me')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('normalizes CRLF line endings so the cursor stays inside the document', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.mutate.createChild({parentId: 'root', id: 'current', content: ''})

    const uiStateBlock = env.repo.block('ui')
    await uiStateBlock.set(topLevelBlockIdProp, 'root')

    // Windows-style clipboard text: \r\n is normalized to \n on insert.
    const readText = vi.fn().mockResolvedValue('one\r\ntwo\r\nthree')
    vi.stubGlobal('navigator', {clipboard: {readText}})

    try {
      const editorView = codeMirrorEditorView('', 0)
      const action = findEditModeAction(env.repo, 'paste_into_block_cm')

      await action.handler({
        block: env.repo.block('current'),
        editorView,
        uiStateBlock,
      } satisfies CodeMirrorEditModeDependencies, {preventDefault: vi.fn()} as unknown as ActionTrigger)

      expect(editorView.state.doc.toString()).toBe('one\ntwo\nthree')
      // Cursor must not run past the normalized document length.
      expect(editorView.state.selection.main.head).toBe('one\ntwo\nthree'.length)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
