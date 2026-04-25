import { defaultActionContextConfigs } from './defaultContexts.ts'
import {
  BlockShortcutDependencies,
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
  getLastVisibleDescendant,
} from '@/data/block.ts'
import { Repo } from '@/data/repo.ts'
import { importState } from '@/utils/state.ts'
import {
  focusedBlockIdProp,
  isCollapsedProp,
  showPropertiesProp,
  topLevelBlockIdProp,
  editorSelection,
  setIsEditing,
  setFocusedBlockId,
  requestEditorFocus,
  isEditingProp,
} from '@/data/properties.ts'
import { selectionStateProp } from '@/data/properties'
import { extendSelection } from '@/utils/selection'
import { applyToAllBlocksInSelection, makeNormalMode, makeMultiSelect, makeCMMode } from './utils'
import { EditorView } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'
import {
  isOnFirstVisualLine,
  isOnLastVisualLine,
  getCaretRect,
  cursorIsAtEnd,
  cursorIsAtStart,
} from '@/utils/codemirror.ts'
import { EditorSelectionState } from '@/types.ts'
import { copySelectedBlocksToClipboard, copyBlockToClipboard } from '@/utils/copy.ts'
import { resetBlockSelection } from '@/data/globalState.ts'
import { actionContextsFacet, actionsFacet } from '@/extensions/core.ts'
import { AppExtension } from '@/extensions/facet.ts'
import { refreshAppRuntime } from '@/extensions/runtimeEvents.ts'
import {
  plainOutlinerInteractionExtension,
  vimNormalModeInteractionExtension,
} from '@/shortcuts/blockInteractionPolicies.ts'

type VimNormalModeAction = ActionConfig<typeof ActionContextTypes.NORMAL_MODE>

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

const extendSelectionDown = async (uiStateBlock: Block, repo: Repo) => {
  const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
  if (!topLevelBlockId) return

  const focusedBlockId = (await uiStateBlock.getProperty(focusedBlockIdProp))?.value
  if (!focusedBlockId) return

  const nextBlock = await nextVisibleBlock(repo.find(focusedBlockId), topLevelBlockId)
  if (!nextBlock) return

  await extendSelection(nextBlock.id, uiStateBlock, repo)
}

const extendSelectionUp = async (uiStateBlock: Block, repo: Repo) => {
  const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
  if (!topLevelBlockId) return

  const focusedBlockId = (await uiStateBlock.getProperty(focusedBlockIdProp))?.value
  if (!focusedBlockId) return

  const prevBlock = await previousVisibleBlock(repo.find(focusedBlockId), topLevelBlockId)
  if (!prevBlock) return

  await extendSelection(prevBlock.id, uiStateBlock, repo)
}

const enterEditMode = (uiStateBlock: Block, selection?: EditorSelectionState) => {
  resetBlockSelection(uiStateBlock)

  setIsEditing(uiStateBlock, true)

  if (selection) uiStateBlock.setProperty({...editorSelection, value: selection})
  requestEditorFocus(uiStateBlock)
}

const requestEditorFocusIfEditing = (uiStateBlock: Block) => {
  if (uiStateBlock.dataSync()?.properties[isEditingProp.name]?.value) {
    requestEditorFocus(uiStateBlock)
  }
}

export function getDefaultActionGroups({repo}: { repo: Repo }) {
  // Define base actions that have transformations
  const indentBlock: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
    id: 'indent_block',
    description: 'Indent block',
    context: ActionContextTypes.NORMAL_MODE,
    handler: async (deps: BlockShortcutDependencies) => {
      await deps.block.indent()
      requestEditorFocusIfEditing(deps.uiStateBlock)
    },
    defaultBinding: {
      keys: 'tab',
      eventOptions: {
        preventDefault: true,
      },
    },
  }

  const outdentBlock: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
    id: 'outdent_block',
    description: 'Outdent block',
    context: ActionContextTypes.NORMAL_MODE,
    handler: async ({block, uiStateBlock}: BlockShortcutDependencies) => {
      const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
      if (!topLevelBlockId) return

      await block.outdent(topLevelBlockId)
      requestEditorFocusIfEditing(uiStateBlock)
    },
    defaultBinding: {
      keys: 'shift+tab',
      eventOptions: {
        preventDefault: true,
      },
    },
  }

  const moveBlockUp: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
    id: 'move_block_up',
    description: 'Move block up',
    context: ActionContextTypes.NORMAL_MODE,
    handler: async (deps: BlockShortcutDependencies) => {
      const {block, uiStateBlock} = deps
      if (!block) return
      await block.changeOrder(-1)
      requestEditorFocusIfEditing(uiStateBlock)
    },
    defaultBinding: {
      keys: 'cmd+shift+up',
      eventOptions: {
        preventDefault: true,
      },
    },
  }

  const moveBlockDown: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
    id: 'move_block_down',
    description: 'Move block down',
    context: ActionContextTypes.NORMAL_MODE,
    handler: async (deps: BlockShortcutDependencies) => {
      const {block, uiStateBlock} = deps
      if (!block) return
      await block.changeOrder(1)
      requestEditorFocusIfEditing(uiStateBlock)
    },
    defaultBinding: {
      keys: 'cmd+shift+down',
    },
  }

  // CodeMirror versions of move actions
  const moveBlockUpCM: ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> = {
    id: 'move_block_up_cm',
    description: 'Move block up (CodeMirror)',
    context: ActionContextTypes.EDIT_MODE_CM,
    handler: async (deps: CodeMirrorEditModeDependencies) => {
      const {block, uiStateBlock} = deps
      if (!block) return
      await block.changeOrder(-1)
      requestEditorFocusIfEditing(uiStateBlock)
    },
    defaultBinding: {
      keys: 'cmd+shift+up',
      eventOptions: {
        preventDefault: true,
      },
    },
  }

  const moveBlockDownCM: ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> = {
    id: 'move_block_down_cm',
    description: 'Move block down (CodeMirror)',
    context: ActionContextTypes.EDIT_MODE_CM,
    handler: async (deps: CodeMirrorEditModeDependencies) => {
      const {block, uiStateBlock} = deps
      if (!block) return
      await block.changeOrder(1)
      requestEditorFocusIfEditing(uiStateBlock)
    },
    defaultBinding: {
      keys: 'cmd+shift+down',
    },
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
      id: 'refresh_renderers',
      description: 'Refresh Renderer Registry',
      context: ActionContextTypes.GLOBAL,
      handler: () => {
        refreshAppRuntime()
        console.log('Renderer registry refreshed.')
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
                document.location.hash = block.id
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
  ]

  const deleteBlock = {
    id: 'delete_block',
    description: 'Delete block',
    context: ActionContextTypes.NORMAL_MODE,
    handler: async (deps: BlockShortcutDependencies) => {
      const {block, uiStateBlock} = deps
      if (!block || !uiStateBlock) return

      const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
      if (!topLevelBlockId) return

      const prevVisible = await previousVisibleBlock(block, topLevelBlockId)
      void block.delete()
      if (prevVisible) setFocusedBlockId(uiStateBlock, prevVisible.id)
    },
    defaultBinding: {
      keys: 'delete',
    },
  }

  // Normal mode actions
  const togglePropertiesDisplay = {
    id: 'toggle_properties',
    description: 'Toggle block properties',
    context: ActionContextTypes.NORMAL_MODE,
    handler: async (deps: BlockShortcutDependencies) => {
      const {block} = deps
      if (!block) return

      const showProperties = (await block.getProperty(showPropertiesProp))?.value
      block.setProperty({...showPropertiesProp, value: !showProperties})
    },
    defaultBinding: {
      keys: 't',
    },
  }
  const toggleBlockCollapse = {
    id: 'toggle_collapse',
    description: 'Toggle block collapse',
    context: ActionContextTypes.NORMAL_MODE,
    handler: async (deps: BlockShortcutDependencies) => {
      const {block} = deps
      if (!block) return

      const isCollapsed = (await block.getProperty(isCollapsedProp))?.value
      block.setProperty({...isCollapsedProp, value: !isCollapsed})
    },
    defaultBinding: {
      keys: 'z',
    },
  }
  const extendSelectionUpNormal = {
    id: 'extend_selection_up',
    description: 'Extend selection up',
    context: ActionContextTypes.NORMAL_MODE,
    handler: async (deps: BlockShortcutDependencies) =>
      await extendSelectionUp(deps.uiStateBlock, repo),
    defaultBinding: {
      keys: 'shift+up',
    },
  }
  const extendSelectionUpEdit = {
    ...makeCMMode(extendSelectionUpNormal),
    handler: async (deps: CodeMirrorEditModeDependencies) => {
      if (cursorIsAtStart(deps.editorView)) {
        setIsEditing(deps.uiStateBlock, false)
        await extendSelectionUp(deps.uiStateBlock, repo)
      }
    },
  }
  const extendSelectionDownNormal = {
    id: 'extend_selection_down',
    description: 'Extend selection down',
    context: ActionContextTypes.NORMAL_MODE,
    handler: async (deps: BlockShortcutDependencies) =>
      await extendSelectionDown(deps.uiStateBlock, repo),
    defaultBinding: {
      keys: 'shift+down',
    },
  }
  const extendSelectionDownEdit = {
    ...makeCMMode(extendSelectionDownNormal),
    handler: async (deps: CodeMirrorEditModeDependencies) => {
      if (cursorIsAtEnd(deps.editorView)) {
        setIsEditing(deps.uiStateBlock, false)
        await extendSelectionDown(deps.uiStateBlock, repo)
      }
    },
  }
  const normalModeActions: VimNormalModeAction[] = [
    indentBlock,
    outdentBlock,
    {
      id: 'move_down',
      description: 'Move to next block',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async (deps: BlockShortcutDependencies) => {
        const {block, uiStateBlock} = deps
        if (!block || !uiStateBlock) return

        const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
        if (!topLevelBlockId) return

        const nextVisible = await nextVisibleBlock(block, topLevelBlockId)
        if (nextVisible) setFocusedBlockId(uiStateBlock, nextVisible.id)
      },
      defaultBinding: {
        keys: ['down', 'k'],
      },
    },
    {
      id: 'move_up',
      description: 'Move to previous block',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async (deps: BlockShortcutDependencies) => {
        const {block, uiStateBlock} = deps
        if (!block || !uiStateBlock) return

        const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
        if (!topLevelBlockId) return

        const prevVisible = await previousVisibleBlock(block, topLevelBlockId)
        if (prevVisible) setFocusedBlockId(uiStateBlock, prevVisible.id)
      },
      defaultBinding: {
        keys: ['up', 'h'],
      },
    },
    {
      id: 'enter_edit_mode',
      description: 'Enter edit mode',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async (deps: BlockShortcutDependencies) => enterEditMode(deps.uiStateBlock),
      defaultBinding: {
        keys: 'i',
      },
    },
    {
      id: 'enter_edit_mode_at_end',
      description: 'Enter edit mode at end',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async ({block, uiStateBlock}: BlockShortcutDependencies) => {
        enterEditMode(uiStateBlock, {blockId: block.id, start: block.dataSync()?.content.length})
      },
      defaultBinding: {
        keys: 'a',
      },
    },
    toggleBlockCollapse,
    togglePropertiesDisplay,
    deleteBlock,
    {
      id: 'create_block_below_and_edit',
      description: 'Create block below (or as child) and enter edit mode',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async (deps: BlockShortcutDependencies) => {
        const {block, uiStateBlock} = deps
        if (!block || !uiStateBlock) return

        const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
        if (!topLevelBlockId) return
        const isCollapsed = (await block.getProperty(isCollapsedProp))?.value
        const hasChildren = await block.hasChildren()
        const isTopLevel = block.id === topLevelBlockId

        const hasUncollapsedChildren = hasChildren && !isCollapsed
        const result = hasUncollapsedChildren || isTopLevel ? await block.createChild({position: 'first'}) : await block.createSiblingBelow()
        if (result) {
          setFocusedBlockId(uiStateBlock, result.id)
          setIsEditing(uiStateBlock, true)
        }
      },
      defaultBinding: {
        keys: 'o',
      },
    },
    {
      id: 'select_focused_block_and_start_selection',
      description: 'Select focused block and start selection',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async (deps: BlockShortcutDependencies) => {
        const {block, uiStateBlock} = deps
        if (!block || !uiStateBlock) return

        uiStateBlock.setProperty({
          ...selectionStateProp,
          value: {
            selectedBlockIds: [block.id],
            anchorBlockId: block.id,
          },
        })
      },
      defaultBinding: {
        keys: ['space', 'v'],
      },
    },
    extendSelectionUpNormal,
    extendSelectionDownNormal,
    makeNormalMode(moveBlockUp),
    makeNormalMode(moveBlockDown),
    {
      id: 'jump_to_first_visible_block',
      description: 'Jump to first visible block',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async ({uiStateBlock}: BlockShortcutDependencies) => {
        const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
        if (!topLevelBlockId) return

        setFocusedBlockId(uiStateBlock, topLevelBlockId)
      },
      defaultBinding: {
        keys: 'g g',
      },
    },
    {
      id: 'jump_to_last_visible_block',
      description: 'Jump to last visible block',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async ({uiStateBlock}: BlockShortcutDependencies) => {
        const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
        if (!topLevelBlockId) return

        const lastBlock = await getLastVisibleDescendant(repo.find(topLevelBlockId), true)
        if (!lastBlock) return

        setFocusedBlockId(uiStateBlock, lastBlock.id)
      },
      defaultBinding: {
        keys: 'shift+g',
      },
    },
    {
      id: 'copy_block',
      description: 'Copy block to clipboard',
      context: ActionContextTypes.NORMAL_MODE,
      handler: ({block}) => copyBlockToClipboard(block),
      defaultBinding: {
        keys: ['cmd+c', 'ctrl+c'],
        eventOptions: {
          preventDefault: true,
        },
      },
    },
  ]

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
    makeCMMode(indentBlock),
    makeCMMode(outdentBlock),
    moveBlockUpCM,
    moveBlockDownCM,
    extendSelectionDownEdit,
    extendSelectionUpEdit,
  ]

  // Multi-select mode actions
  const multiSelectModeActions: ActionConfig<typeof ActionContextTypes.MULTI_SELECT_MODE>[] = [
    makeMultiSelect(extendSelectionUpNormal),
    makeMultiSelect(extendSelectionDownNormal),
    applyToAllBlocksInSelection(toggleBlockCollapse),
    applyToAllBlocksInSelection(togglePropertiesDisplay),
    applyToAllBlocksInSelection(indentBlock),
    applyToAllBlocksInSelection(outdentBlock, {applyInReverseOrder: true}),
    applyToAllBlocksInSelection(deleteBlock),
    applyToAllBlocksInSelection(moveBlockUp),
    applyToAllBlocksInSelection(moveBlockDown, {applyInReverseOrder: true}),
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
  ];

  return {
    globalActions,
    vimNormalModeActions: normalModeActions,
    editModeCMActions,
    multiSelectModeActions,
  }
}

export function getDefaultActions({repo}: { repo: Repo }): ActionConfig[] {
  const {
    globalActions,
    vimNormalModeActions,
    editModeCMActions,
    multiSelectModeActions,
  } = getDefaultActionGroups({repo})

  return [
    ...globalActions,
    ...vimNormalModeActions,
    ...editModeCMActions,
    ...multiSelectModeActions,
  ] as ActionConfig[]
}

export function defaultActionsExtension({repo}: { repo: Repo }): AppExtension {
  const {
    globalActions,
    vimNormalModeActions,
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
    plainOutlinerInteractionExtension,
    nonVimActions.map(action => actionsFacet.of(action)),
    // Vim normal-mode bundle: interaction policies + normal-mode actions. Opting
    // out of vim means excluding this sub-extension entirely.
    [
      vimNormalModeInteractionExtension,
      vimNormalModeActions.map(action =>
        actionsFacet.of(action as ActionConfig, {source: 'vim-normal-mode'}),
      ),
    ],
  ]
}
