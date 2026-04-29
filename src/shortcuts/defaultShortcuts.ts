import { defaultActionContextConfigs } from './defaultContexts.ts'
import {
  ActionContextTypes,
  BaseShortcutDependencies,
  ActionConfig,
  MultiSelectModeDependencies,
  CodeMirrorEditModeDependencies,
  ActionTrigger,
} from './types'
import {
  previousVisibleBlock,
  nextVisibleBlock,
  defaultChangeScope,
  Block,
  getRootBlock,
} from '@/data/block.ts'
import { Repo } from '@/data/repo.ts'
import { importState } from '@/utils/state.ts'
import {
  focusedBlockIdProp,
  isCollapsedProp,
  topLevelBlockIdProp,
  editorSelection,
  setIsEditing,
  setFocusedBlockId,
} from '@/data/properties.ts'
import { insertExampleExtensionsUnder } from '@/extensions/exampleExtensions.ts'
import { selectionStateProp } from '@/data/properties'
import { applyToAllBlocksInSelection, makeMultiSelect } from './utils'
import {
  bindBlockActionContext,
  createSharedBlockActions,
  extendSelectionDown,
  extendSelectionUp,
} from './blockActions.ts'
import { EditorView } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'
import {
  isOnFirstVisualLine,
  isOnLastVisualLine,
  getCaretRect,
  cursorIsAtEnd,
  cursorIsAtStart,
} from '@/utils/codemirror.ts'
import { copySelectedBlocksToClipboard } from '@/utils/copy.ts'
import { pasteFromClipboard } from '@/utils/paste.ts'
import { actionContextsFacet, actionsFacet } from '@/extensions/core.ts'
import { AppExtension } from '@/extensions/facet.ts'
import { refreshAppRuntime } from '@/extensions/runtimeEvents.ts'
import { buildAppHash, writeAppHash } from '@/utils/routing.ts'
import { agentRuntimeBridgeRestartEvent } from '@/agentRuntime/useAgentRuntimeBridge.ts'
import { getActivePanelBlock, isMainPanel } from '@/data/globalState.ts'
import { getOrCreateDailyNote, todayIso } from '@/data/dailyNotes.ts'
import { importRoam } from '@/utils/roamImport/import.ts'
import { ensureRoamImportWindowHook } from '@/utils/roamImport/runtime.ts'
import type { RoamExport } from '@/utils/roamImport/types.ts'

const splitCodeMirrorBlockAtCursor = async (block: Block, editorView: EditorView, isTopLevel: boolean): Promise<Block> => {
  const doc = editorView.state.doc
  const cursorPos = editorView.state.selection.main.head

  const beforeCursor = doc.sliceString(0, cursorPos)
  const afterCursor = doc.sliceString(cursorPos)

  if (isTopLevel) {
    const child = await block.createChild({data: {content: afterCursor}, position: 'first'})
    block.change(b => b.content = beforeCursor)

    return child
  } else {
    await block.createSiblingAbove({content: beforeCursor})

    block.change(b => b.content = afterCursor)

    editorView.dispatch({
      selection: EditorSelection.cursor(0)
    })

    return block
  }
}

export function getDefaultActionGroups({repo}: { repo: Repo }) {
  // Idempotent: surfaces window.__omniliner.roamImport for the agent
  // runtime / devtools console. Living here ties it to the same lifecycle
  // as the rest of the default actions — the hook gets installed once
  // per Repo.
  ensureRoamImportWindowHook(repo)

  const {
    indentBlock,
    outdentBlock,
    moveBlockUp,
    moveBlockDown,
    deleteBlock,
    togglePropertiesDisplay,
    toggleBlockCollapse,
    extendSelectionUp: extendSelectionUpBlock,
    extendSelectionDown: extendSelectionDownBlock,
  } = createSharedBlockActions({repo})

  const indentBlockAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, indentBlock)
  const outdentBlockAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, outdentBlock)
  const moveBlockUpAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, moveBlockUp)
  const moveBlockDownAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, moveBlockDown)
  const deleteBlockAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, deleteBlock)
  const togglePropertiesDisplayAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, togglePropertiesDisplay)
  const toggleBlockCollapseAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, toggleBlockCollapse)
  const extendSelectionUpAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, extendSelectionUpBlock)
  const extendSelectionDownAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, extendSelectionDownBlock)

  // CodeMirror versions of move actions
  const moveBlockUpCM: ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> = {
    ...bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, moveBlockUp),
    id: 'move_block_up_cm',
    description: 'Move block up (CodeMirror)',
  }

  const moveBlockDownCM: ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> = {
    ...bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, moveBlockDown),
    id: 'move_block_down_cm',
    description: 'Move block down (CodeMirror)',
  }

  const globalActions: ActionConfig<typeof ActionContextTypes.GLOBAL>[] = [
    {
      id: 'command_palette',
      description: 'Open command palette',
      context: ActionContextTypes.GLOBAL,
      handler: () => {
        window.dispatchEvent(new CustomEvent('toggle-command-palette'))
      },
      defaultBinding: {
        keys: ['cmd+k', 'ctrl+k'],
      },
      hideFromCommandPallet: true,
    },
    {
      id: 'quick_find',
      description: 'Find or create page or block',
      context: ActionContextTypes.GLOBAL,
      handler: () => {
        window.dispatchEvent(new CustomEvent('toggle-quick-find'))
      },
      defaultBinding: {
        keys: ['cmd+p', 'ctrl+p', 'cmd+shift+k', 'ctrl+shift+k'],
      },
    },
    {
      id: 'open_today',
      description: "Open today's daily note",
      context: ActionContextTypes.GLOBAL,
      handler: async () => {
        const workspaceId = repo.activeWorkspaceId
        if (!workspaceId) return
        const note = await getOrCreateDailyNote(repo, workspaceId, todayIso())
        document.location.hash = buildAppHash(workspaceId, note.id)
      },
      defaultBinding: {
        keys: ['cmd+shift+`', 'ctrl+shift+`'],
      },
    },
    {
      id: 'undo',
      description: 'Undo last action',
      context: ActionContextTypes.GLOBAL,
      handler: () => {
        repo.undoRedoManager.undo(defaultChangeScope)
      },
      defaultBinding: {
        keys: ['cmd+z', 'ctrl+z'],
      },
    },
    {
      id: 'redo',
      description: 'Redo last action',
      context: ActionContextTypes.GLOBAL,
      handler: () => {
        repo.undoRedoManager.redo(defaultChangeScope)
      },
      defaultBinding: {
        keys: ['cmd+shift+z', 'ctrl+shift+z', 'cmd+y', 'ctrl+y'],
      },
    },
    {
      id: 'refresh_extensions',
      description: 'Reload extensions',
      context: ActionContextTypes.GLOBAL,
      handler: () => {
        refreshAppRuntime()
        console.log('Runtime extensions reloaded')
      },
    },
    {
      id: 'restart_agent_runtime_bridge',
      description: 'Restart agent runtime bridge',
      context: ActionContextTypes.GLOBAL,
      handler: () => {
        window.dispatchEvent(new CustomEvent(agentRuntimeBridgeRestartEvent))
      },
    },
    {
      id: 'export_document',
      description: 'Export current document',
      context: ActionContextTypes.GLOBAL,
      handler: async ({uiStateBlock}: BaseShortcutDependencies) => {
        const root = await getRootBlock(repo.find(uiStateBlock.id))
        const blocks = await repo.getSubtreeBlockData(root.id, {includeRoot: true})
        const data = JSON.stringify({blocks}, null, 2)

        const downloadLink = document.createElement('a')
        downloadLink.download = `document-state-${new Date().toUTCString()}.json`
        downloadLink.href = `data:application/json;charset=utf-8,${encodeURIComponent(data)}`
        downloadLink.click()
      },
    },
    {
      id: 'import_document',
      description: 'Import document',
      context: ActionContextTypes.GLOBAL,
      handler: () => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.json'

        input.onchange = async (e) => {
          const file = (e.target as HTMLInputElement).files?.[0]
          if (!file) return

          const reader = new FileReader()
          reader.onload = async (e) => {
            const content = e.target?.result
            if (typeof content !== 'string') return

            try {
              const data = JSON.parse(content)
              const blockMap = await importState(data, repo)
              const block = blockMap.values().next().value
              if (block) {
                // Imported blocks default to repo.activeWorkspaceId in
                // repo.create, so the freshly-imported root lives in the
                // current workspace. Import is gated by an open workspace,
                // so activeWorkspaceId is set here.
                document.location.hash = buildAppHash(repo.activeWorkspaceId!, block.id)
              }
            } catch (err) {
              console.error('Failed to import document:', err)
            }
          }
          reader.readAsText(file)
        }

        input.click()
      },
    },
    {
      id: 'import_roam',
      description: 'Import Roam JSON export',
      context: ActionContextTypes.GLOBAL,
      handler: () => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.json,application/json'

        input.onchange = async (e) => {
          const file = (e.target as HTMLInputElement).files?.[0]
          if (!file) return

          const reader = new FileReader()
          reader.onload = async (loadEvent) => {
            const content = loadEvent.target?.result
            if (typeof content !== 'string') return

            try {
              const parsed = JSON.parse(content) as RoamExport
              if (!Array.isArray(parsed)) {
                console.error('[roam-import] expected top-level JSON array of pages')
                return
              }

              const workspaceId = repo.activeWorkspaceId
              if (!workspaceId) {
                console.error('[roam-import] no active workspace')
                return
              }

              const summary = await importRoam(parsed, repo, {
                workspaceId,
                currentUserId: repo.currentUser.id,
                onProgress: msg => console.log(`[roam-import] ${msg}`),
              })
              console.log('[roam-import] done', summary)
              window.alert(
                `Roam import complete:\n` +
                `  pages created: ${summary.pagesCreated}\n` +
                `  pages merged: ${summary.pagesMerged}\n` +
                `  daily notes: ${summary.pagesDaily}\n` +
                `  blocks written: ${summary.blocksWritten}\n` +
                `  alias blocks created: ${summary.aliasBlocksCreated}\n` +
                `  unresolved block uids: ${summary.unresolvedBlockUids.length}\n` +
                `  duration: ${summary.durationMs} ms`,
              )
            } catch (err) {
              console.error('[roam-import] failed:', err)
              window.alert(`Roam import failed: ${err instanceof Error ? err.message : String(err)}`)
            }
          }
          reader.readAsText(file)
        }

        input.click()
      },
    },
    {
      id: 'insert_example_extensions',
      description: 'Insert example extensions under current block',
      context: ActionContextTypes.GLOBAL,
      handler: async ({uiStateBlock}: BaseShortcutDependencies) => {
        const panel = await getActivePanelBlock(uiStateBlock)
        const data = await panel?.data()
        const parentId =
          (data?.properties[focusedBlockIdProp.name]?.value as string | undefined) ??
          (data?.properties[topLevelBlockIdProp.name]?.value as string | undefined)
        if (!panel || !parentId) return

        const created = await insertExampleExtensionsUnder(repo.find(parentId))
        if (created[0]) panel.setProperty({...focusedBlockIdProp, value: created[0].id})
      },
    },
    {
      id: 'zoom_in',
      description: 'Zoom into focused block',
      context: ActionContextTypes.GLOBAL,
      handler: async ({uiStateBlock}: BaseShortcutDependencies) => {
        const panel = await getActivePanelBlock(uiStateBlock)
        if (!panel) return

        const data = await panel.data()
        const focusedBlockId = data?.properties[focusedBlockIdProp.name]?.value as string | undefined
        if (!focusedBlockId) return

        if (isMainPanel(panel)) {
          const workspaceId = repo.activeWorkspaceId
          if (!workspaceId) return
          writeAppHash(workspaceId, focusedBlockId)
        } else {
          panel.setProperty({...topLevelBlockIdProp, value: focusedBlockId})
        }
      },
      defaultBinding: {
        keys: ['cmd+.', 'ctrl+.'],
      },
    },
    {
      id: 'zoom_out',
      description: 'Zoom out to parent of current view',
      context: ActionContextTypes.GLOBAL,
      handler: async ({uiStateBlock}: BaseShortcutDependencies) => {
        const panel = await getActivePanelBlock(uiStateBlock)
        if (!panel) return

        const data = await panel.data()
        const topLevelBlockId = data?.properties[topLevelBlockIdProp.name]?.value as string | undefined
        if (!topLevelBlockId) return

        const parent = await repo.find(topLevelBlockId).parent()
        if (!parent) return

        if (isMainPanel(panel)) {
          const workspaceId = repo.activeWorkspaceId
          if (!workspaceId) return
          writeAppHash(workspaceId, parent.id)
        } else {
          panel.setProperty({...topLevelBlockIdProp, value: parent.id})
        }
      },
      defaultBinding: {
        keys: ['cmd+,', 'ctrl+,'],
      },
    },
    {
      id: 'open_focused_in_panel',
      description: 'Open focused block in a side panel',
      context: ActionContextTypes.GLOBAL,
      handler: async ({uiStateBlock}: BaseShortcutDependencies) => {
        const panel = await getActivePanelBlock(uiStateBlock)
        if (!panel) return

        const data = await panel.data()
        const focusedBlockId = data?.properties[focusedBlockIdProp.name]?.value as string | undefined
        if (!focusedBlockId) return

        window.dispatchEvent(new CustomEvent('open-panel', {
          detail: {blockId: focusedBlockId, sourcePanelId: panel.id},
        }))
      },
      defaultBinding: {
        keys: ['cmd+shift+.', 'ctrl+shift+.'],
      },
    },
    {
      id: 'navigate_back',
      description: 'Go back in navigation history',
      context: ActionContextTypes.GLOBAL,
      handler: () => {
        window.history.back()
      },
      defaultBinding: {
        keys: ['cmd+[', 'ctrl+['],
      },
    },
    {
      id: 'navigate_forward',
      description: 'Go forward in navigation history',
      context: ActionContextTypes.GLOBAL,
      handler: () => {
        window.history.forward()
      },
      defaultBinding: {
        keys: ['cmd+]', 'ctrl+]'],
      },
    },
  ]

  const extendSelectionUpEdit = {
    ...bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, extendSelectionUpBlock, {idPrefix: 'edit.cm'}),
    handler: async (deps: CodeMirrorEditModeDependencies) => {
      if (cursorIsAtStart(deps.editorView)) {
        setIsEditing(deps.uiStateBlock, false)
        await extendSelectionUp(deps.uiStateBlock, repo)
      }
    },
  }
  const extendSelectionDownEdit = {
    ...bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, extendSelectionDownBlock, {idPrefix: 'edit.cm'}),
    handler: async (deps: CodeMirrorEditModeDependencies) => {
      if (cursorIsAtEnd(deps.editorView)) {
        setIsEditing(deps.uiStateBlock, false)
        await extendSelectionDown(deps.uiStateBlock, repo)
      }
    },
  }
  // CodeMirror-specific edit mode actions
  const editModeCMActions: ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM>[] = [
    {
      id: 'exit_edit_mode_cm',
      description: 'Exit edit mode',
      context: ActionContextTypes.EDIT_MODE_CM,
      handler: async (deps: CodeMirrorEditModeDependencies) => setIsEditing(deps.uiStateBlock, false),
      defaultBinding: {
        keys: 'escape',
      },
    },
    {
      id: 'split_block_cm',
      description: 'Split block at cursor',
      context: ActionContextTypes.EDIT_MODE_CM,
      handler: async (deps: CodeMirrorEditModeDependencies) => {
        const {block, editorView, uiStateBlock} = deps
        if (!block || !editorView || !uiStateBlock) return

        const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
        if (!topLevelBlockId) return
        const isCollapsed = (await block.getProperty(isCollapsedProp))?.value
        const isTopLevel = block.id === topLevelBlockId

        const selection = editorView.state.selection.main
        const doc = editorView.state.doc
        const cursorPos = selection.head

        const createSiblingBelow = async () => {
          const newBlock = await block.createSiblingBelow()
          if (newBlock) setFocusedBlockId(uiStateBlock, newBlock.id)
        }

        // Case 1: Cursor is in middle of text
        if (cursorPos < doc.length) {
          const blockInFocus = await splitCodeMirrorBlockAtCursor(block, editorView, isTopLevel)
          setFocusedBlockId(uiStateBlock, blockInFocus.id)
        }
        // Case 2: Cursor is at end of text and block has children
        else if (cursorPos === doc.length &&
          (await block.hasChildren() && !isCollapsed || isTopLevel)) {
          const newBlock = await block.createChild({position: 'first'})
          if (newBlock) setFocusedBlockId(uiStateBlock, newBlock.id)
        }
        // Repeated empty blocks creation - outdents the new block
        else if (editorView.state.doc.length === 0) {
          const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value

          if (topLevelBlockId && !await block.outdent(topLevelBlockId)) {
            await createSiblingBelow()
          }
        }
        // Cursor at end, no children or they are collapsed
        else {
          await createSiblingBelow()
        }
      },
      defaultBinding: {
        keys: 'enter',
        eventOptions: {
          preventDefault: true,
        },
      },
    },
    {
      id: 'move_up_from_cm_start',
      description: 'Move to previous block when cursor is at start of CodeMirror',
      context: ActionContextTypes.EDIT_MODE_CM,
      handler: async (deps: CodeMirrorEditModeDependencies, trigger: ActionTrigger) => {
        const {block, editorView, uiStateBlock} = deps
        if (!block || !editorView || !uiStateBlock) return

        const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
        if (!topLevelBlockId || !isOnFirstVisualLine(editorView)) return

        const prevVisible = await previousVisibleBlock(block, topLevelBlockId)
        if (!prevVisible) return

        /**
         * Otherwise the new CodeMirror instance still gets an "up" event and bad things happen =\
         * I don't like that we have to do this, somewhat breaks encapsulation
         */
        trigger.preventDefault()
        uiStateBlock.setProperty({
          ...editorSelection, value: {
            blockId: prevVisible.id,
            line: 'last',
            x: getCaretRect(editorView)?.left,
          },
        })

        setFocusedBlockId(uiStateBlock, prevVisible.id)
      },
      defaultBinding: {
        keys: 'up',
        eventOptions: {
          preventDefault: false,
        },
      },
    },
    {
      id: 'move_down_from_cm_end',
      description: 'Move to next block when cursor is at end of CodeMirror',
      context: ActionContextTypes.EDIT_MODE_CM,
      handler: async (deps: CodeMirrorEditModeDependencies, trigger: ActionTrigger) => {
        const {block, editorView, uiStateBlock} = deps
        if (!block || !editorView || !uiStateBlock) return

        const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
        if (!topLevelBlockId || !isOnLastVisualLine(editorView)) return

        const nextVisible = await nextVisibleBlock(block, topLevelBlockId)
        if (!nextVisible) return

        /**
         * Otherwise the new CodeMirror instance still gets an "up" event and bad things happen =\
         * I don't like that we have to do this, somewhat breaks encapsulation
         */
        trigger.preventDefault()

        uiStateBlock.setProperty({
          ...editorSelection, value: {
            blockId: nextVisible.id,
            x: getCaretRect(editorView)?.left,
          },
        })

        setFocusedBlockId(uiStateBlock, nextVisible.id)
      },
      defaultBinding: {
        keys: 'down',
      },
    },
    {
      id: 'delete_empty_block_cm',
      description: 'Delete empty block on backspace (CodeMirror)',
      context: ActionContextTypes.EDIT_MODE_CM,
      handler: async (deps: CodeMirrorEditModeDependencies) => {
        const {block, uiStateBlock} = deps
        if (!block || !uiStateBlock) return
        const blockData = await block.data()
        if (!(blockData?.content === '')) return

        const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
        if (!topLevelBlockId) return

        const prevVisible = await previousVisibleBlock(block, topLevelBlockId)
        block.delete()
        if (prevVisible) setFocusedBlockId(uiStateBlock, prevVisible.id)
      },
      defaultBinding: {
        keys: 'backspace',
      },
    },
    bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, indentBlock, {idPrefix: 'edit.cm'}),
    bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, outdentBlock, {idPrefix: 'edit.cm'}),
    moveBlockUpCM,
    moveBlockDownCM,
    extendSelectionDownEdit,
    extendSelectionUpEdit,
  ]

  // Multi-select mode actions
  const multiSelectModeActions: ActionConfig<typeof ActionContextTypes.MULTI_SELECT_MODE>[] = [
    makeMultiSelect(extendSelectionUpAction),
    makeMultiSelect(extendSelectionDownAction),
    applyToAllBlocksInSelection(toggleBlockCollapseAction),
    applyToAllBlocksInSelection(togglePropertiesDisplayAction),
    applyToAllBlocksInSelection(indentBlockAction),
    applyToAllBlocksInSelection(outdentBlockAction, {applyInReverseOrder: true}),
    applyToAllBlocksInSelection(deleteBlockAction),
    applyToAllBlocksInSelection(moveBlockUpAction),
    applyToAllBlocksInSelection(moveBlockDownAction, {applyInReverseOrder: true}),
    {
      id: 'clear_selection',
      description: 'Clear selection',
      context: ActionContextTypes.MULTI_SELECT_MODE,
      handler: async (deps: MultiSelectModeDependencies) => deps.uiStateBlock.setProperty(selectionStateProp),
      defaultBinding: {
        keys: 'escape',
      },
    },
    {
      id: 'copy_selected_blocks',
      description: 'Copy selected blocks to clipboard',
      context: ActionContextTypes.MULTI_SELECT_MODE,
      handler: ({uiStateBlock}) => copySelectedBlocksToClipboard(uiStateBlock, repo),
      defaultBinding: {
        keys: ['cmd+c', 'ctrl+c'],
        eventOptions: {
          preventDefault: true,
        },
      },
    },
    {
      id: 'cut_selected_blocks',
      description: 'Cut selected blocks to clipboard',
      context: ActionContextTypes.MULTI_SELECT_MODE,
      handler: async (deps: MultiSelectModeDependencies) => {
        const {uiStateBlock, selectedBlocks} = deps
        if (!selectedBlocks.length) return

        await copySelectedBlocksToClipboard(uiStateBlock, repo)
        for (const block of selectedBlocks.toReversed()) {
          await block.delete()
        }
        uiStateBlock.setProperty(selectionStateProp)
      },
      defaultBinding: {
        keys: ['cmd+x', 'ctrl+x', 'd'],
        eventOptions: {
          preventDefault: true,
        },
      },
    },
    {
      id: 'paste_after_selection',
      description: 'Paste from clipboard after selection',
      context: ActionContextTypes.MULTI_SELECT_MODE,
      handler: async (deps: MultiSelectModeDependencies) => {
        const {uiStateBlock, selectedBlocks} = deps
        const target = selectedBlocks.at(-1)
        if (!target) return

        const pasted = await pasteFromClipboard(target, repo, {position: 'after'})
        if (pasted[0]) {
          uiStateBlock.setProperty(selectionStateProp)
          setFocusedBlockId(uiStateBlock, pasted[0].id)
        }
      },
      defaultBinding: {
        keys: 'p',
      },
    },
    {
      id: 'paste_before_selection',
      description: 'Paste from clipboard before selection',
      context: ActionContextTypes.MULTI_SELECT_MODE,
      handler: async (deps: MultiSelectModeDependencies) => {
        const {uiStateBlock, selectedBlocks} = deps
        const target = selectedBlocks[0]
        if (!target) return

        const pasted = await pasteFromClipboard(target, repo, {position: 'before'})
        if (pasted[0]) {
          uiStateBlock.setProperty(selectionStateProp)
          setFocusedBlockId(uiStateBlock, pasted[0].id)
        }
      },
      defaultBinding: {
        keys: 'shift+p',
      },
    },
  ];

  return {
    globalActions,
    editModeCMActions,
    multiSelectModeActions,
  }
}

export function getDefaultActions({repo}: { repo: Repo }): ActionConfig[] {
  const {
    globalActions,
    editModeCMActions,
    multiSelectModeActions,
  } = getDefaultActionGroups({repo})

  return [
    ...globalActions,
    ...editModeCMActions,
    ...multiSelectModeActions,
  ] as ActionConfig[]
}

export function defaultActionsExtension({repo}: { repo: Repo }): AppExtension {
  const {
    globalActions,
    editModeCMActions,
    multiSelectModeActions,
  } = getDefaultActionGroups({repo})

  const nonVimActions = [
    ...globalActions,
    ...editModeCMActions,
    ...multiSelectModeActions,
  ] as ActionConfig[]

  return [
    defaultActionContextConfigs.map(context => actionContextsFacet.of(context)),
    nonVimActions.map(action => actionsFacet.of(action)),
  ]
}
