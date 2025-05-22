import { actionManager as defaultActionManager, ActionManager } from './ActionManager.ts'
import {
  BlockShortcutDependencies,
  EditModeDependencies,
  ActionContextTypes,
  BaseShortcutDependencies,
  ActionConfig, MultiSelectModeDependencies,
} from './types'
import {
  previousVisibleBlock,
  nextVisibleBlock,
  defaultChangeScope,
  Block,
  getAllChildrenBlocks,
  getRootBlock,
} from '@/data/block.ts'
import { splitBlockAtCursor } from '@/components/renderer/TextAreaContentRenderer.tsx'
import { Repo } from '@/data/repo.ts'
import { refreshRendererRegistry } from '@/hooks/useRendererRegistry.tsx'
import { importState } from '@/utils/state.ts'
import {
  focusedBlockIdProp,
  isEditingProp,
  isCollapsedProp,
  showPropertiesProp,
  topLevelBlockIdProp,
} from '@/data/properties.ts'
import { selectionStateProp } from '@/data/properties'
import { getAllVisibleBlockIdsInOrder, getBlocksInRange } from '@/utils/selection'
import { makeMultiSelect, makeNormalMode, makeEditMode } from './utils'

const setFocusedBlockId = (uiStateBlock: Block, id: string) => {
  uiStateBlock.setProperty({...focusedBlockIdProp, value: id})
}

const setIsEditing = (uiStateBlock: Block, editing: boolean) => {
  uiStateBlock.setProperty({...isEditingProp, value: editing})
}

export function registerDefaultShortcuts({repo}: { repo: Repo, }, actionManager: ActionManager = defaultActionManager) {
  // Define base actions that have transformations
  const indentBlock: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
    id: 'indent_block',
    description: 'Indent block',
    context: ActionContextTypes.NORMAL_MODE,
    handler: (deps: BlockShortcutDependencies) => deps.block.indent(),
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
    handler: (deps: BlockShortcutDependencies) => deps.block.outdent(),
    defaultBinding: {
      keys: 'shift+tab',
      eventOptions: {
        preventDefault: true,
      },
    },
  }

  const moveBlockUp: ActionConfig<typeof ActionContextTypes.EDIT_MODE> = {
    id: 'move_block_up',
    description: 'Move block up',
    context: ActionContextTypes.EDIT_MODE,
    handler: (deps: EditModeDependencies) => {
      const {block} = deps
      if (!block) return
      block.changeOrder(-1)
    },
    defaultBinding: {
      keys: 'cmd+shift+up',
      eventOptions: {
        preventDefault: true,
      },
    },
  }

  const moveBlockDown: ActionConfig<typeof ActionContextTypes.EDIT_MODE> = {
    id: 'move_block_down',
    description: 'Move block down',
    context: ActionContextTypes.EDIT_MODE,
    handler: (deps: EditModeDependencies) => {
      const {block} = deps
      if (!block) return
      block.changeOrder(1)
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
      id: 'open_router_settings',
      description: 'Open Router Settings',
      context: ActionContextTypes.GLOBAL,
      handler: () => {
        // No-op: Logic is handled directly in CommandPalette's runCommand
        console.log('[Action:open_settings] Triggered. Dialog opening handled by CommandPalette.')

        // todo this is not good and we should move towards something like "popup managed by layout renderer"
        // and we pass a block to render to it
      },
    },
    {
      id: 'refresh_renderers',
      description: 'Refresh Renderer Registry',
      context: ActionContextTypes.GLOBAL,
      handler: () => {
        refreshRendererRegistry()
        console.log('Renderer registry refreshed.')
      },
    },
    {
      id: 'export_document',
      description: 'Export current document',
      context: ActionContextTypes.GLOBAL,
      handler: async ({uiStateBlock}: BaseShortcutDependencies) => {
        const root = await getRootBlock(repo.find(uiStateBlock.id))
        const children = await getAllChildrenBlocks(root)
        const blocks = await Promise.all([root, ...children].map(block => block.data()))
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
  const normalModeActions: ActionConfig<typeof ActionContextTypes.NORMAL_MODE>[] = [
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
      handler: async (deps: BlockShortcutDependencies) => {
        const {block, uiStateBlock} = deps
        if (!block || !uiStateBlock) return

        uiStateBlock.setProperty({
          ...selectionStateProp,
          value: {
            selectedBlockIds: [],
            anchorBlockId: null,
          },
        })

        setIsEditing(uiStateBlock, true)
      },
      defaultBinding: {
        keys: 'i',
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
        keys: 'space',
      },
    },
    {
      id: 'add_focused_to_selection',
      description: 'Add focused block to selection',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async (deps: BlockShortcutDependencies) => {
        const {block, uiStateBlock} = deps
        if (!block || !uiStateBlock) return

        const currentState = await uiStateBlock.getProperty(selectionStateProp)
        if (!currentState?.value) return

        // Check if block is descendant of any currently selected block
        for (const selectedId of currentState.value.selectedBlockIds) {
          const selectedBlock = repo.find(selectedId)
          if (await block.isDescendantOf(selectedBlock)) {
            return // Skip if block is descendant
          }
        }

        // Remove any currently selected blocks that are descendants of this block
        const newSelectedIds = []
        for (const id of currentState.value.selectedBlockIds) {
          const selectedBlock = repo.find(id)
          if (!(await selectedBlock.isDescendantOf(block))) {
            newSelectedIds.push(id)
          }
        }

        uiStateBlock.setProperty({
          ...selectionStateProp,
          value: {
            selectedBlockIds: [...newSelectedIds, block.id],
            anchorBlockId: currentState.value.anchorBlockId || block.id,
          },
        })
      },
      defaultBinding: {
        keys: 'ctrl+space',
      },
    },
    {
      id: 'extend_selection_up',
      description: 'Extend selection up',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async (deps: BlockShortcutDependencies) => {
        const {block, uiStateBlock} = deps
        if (!block || !uiStateBlock) return

        const currentState = await uiStateBlock.getProperty(selectionStateProp)
        const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
        if (!topLevelBlockId || !currentState?.value) return

        const prevBlock = await previousVisibleBlock(block, topLevelBlockId)
        if (!prevBlock) return

        const currentAnchor = currentState.value.anchorBlockId || block.id
        const orderedIds = await getAllVisibleBlockIdsInOrder(repo.find(topLevelBlockId))
        const rangeIds = await getBlocksInRange(currentAnchor, prevBlock.id, orderedIds, repo)

        setFocusedBlockId(uiStateBlock, prevBlock.id)
        uiStateBlock.setProperty({
          ...selectionStateProp,
          value: {
            selectedBlockIds: rangeIds,
            anchorBlockId: currentAnchor,
          },
        })
      },
      defaultBinding: {
        keys: 'shift+up',
      },
    },
    {
      id: 'extend_selection_down',
      description: 'Extend selection down',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async (deps: BlockShortcutDependencies) => {
        const {block, uiStateBlock} = deps
        if (!block || !uiStateBlock) return

        const currentState = await uiStateBlock.getProperty(selectionStateProp)
        const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
        if (!topLevelBlockId || !currentState?.value) return

        const nextBlock = await nextVisibleBlock(block, topLevelBlockId)
        if (!nextBlock) return

        const currentAnchor = currentState.value.anchorBlockId || block.id
        const orderedIds = await getAllVisibleBlockIdsInOrder(repo.find(topLevelBlockId))
        const rangeIds = await getBlocksInRange(currentAnchor, nextBlock.id, orderedIds, repo)

        setFocusedBlockId(uiStateBlock, nextBlock.id)
        uiStateBlock.setProperty({
          ...selectionStateProp,
          value: {
            selectedBlockIds: rangeIds,
            anchorBlockId: currentAnchor,
          },
        })
      },
      defaultBinding: {
        keys: 'shift+down',
      },
    },
    {
      id: 'select_all_visible',
      description: 'Select all visible blocks',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async (deps: BlockShortcutDependencies) => {
        const {uiStateBlock} = deps
        if (!uiStateBlock) return

        const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
        if (!topLevelBlockId) return

        const orderedIds = await getAllVisibleBlockIdsInOrder(repo.find(topLevelBlockId))
        if (orderedIds.length === 0) return

        // Only select top-level blocks within the current view/panel
        const validatedIds = []
        for (const id of orderedIds) {
          const currentBlock = repo.find(id)
          for (const otherId of orderedIds) {
            if (otherId === id) continue
            const otherBlock = repo.find(otherId)
            if (await currentBlock.isDescendantOf(otherBlock)) {
              continue
            }
          }
          validatedIds.push(id)
        }

        const topLevelIds = validatedIds.filter(Boolean) as string[]
        if (topLevelIds.length === 0) return

        setFocusedBlockId(uiStateBlock, topLevelIds[0])
        uiStateBlock.setProperty({
          ...selectionStateProp,
          value: {
            selectedBlockIds: topLevelIds,
            anchorBlockId: topLevelIds[0],
          },
        })
      },
      defaultBinding: {
        keys: ['cmd+a', 'ctrl+a'],
      },
    },
    makeNormalMode(moveBlockUp),
    makeNormalMode(moveBlockDown),
  ]

  // Edit mode actions
  const editModeActions: ActionConfig<typeof ActionContextTypes.EDIT_MODE>[] = [
    {
      id: 'exit_edit_mode',
      description: 'Exit edit mode',
      context: ActionContextTypes.EDIT_MODE,
      handler: async (deps: EditModeDependencies) => setIsEditing(deps.uiStateBlock, false),
      defaultBinding: {
        keys: 'escape',
      },
    },
    {
      id: 'split_block',
      description: 'Split block at cursor',
      context: ActionContextTypes.EDIT_MODE,
      handler: async (deps: EditModeDependencies) => {
        const {block, textarea, uiStateBlock} = deps
        if (!block || !textarea || !uiStateBlock) return

        const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
        if (!topLevelBlockId) return
        const isCollapsed = (await block.getProperty(isCollapsedProp))?.value
        const isTopLevel = block.id === topLevelBlockId

        // Case 1: Cursor is in middle of text
        if (textarea.selectionStart < textarea.value.length) {
          const blockInFocus = await splitBlockAtCursor(block, textarea, isTopLevel)
          setFocusedBlockId(uiStateBlock, blockInFocus.id)
        }
        // Case 2: Cursor is at end of text and block has children
        else if (textarea.selectionStart === textarea.value.length &&
          (await block.hasChildren() && !isCollapsed || isTopLevel)) {
          const newBlock = await block.createChild({position: 'first'})
          if (newBlock) setFocusedBlockId(uiStateBlock, newBlock.id)
        }
        // Case 3: Cursor at end, no children or they are collapsed
        else {
          const newBlock = await block.createSiblingBelow()
          if (newBlock) setFocusedBlockId(uiStateBlock, newBlock.id)
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
      id: 'move_up_from_textarea_start',
      description: 'Move to previous block when cursor is at start of textarea',
      context: ActionContextTypes.EDIT_MODE,
      handler: async (deps: EditModeDependencies) => {
        const {block, textarea, uiStateBlock} = deps
        if (!block || !textarea || !uiStateBlock) return

        const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
        if (!topLevelBlockId) return

        if (textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
          const prevVisible = await previousVisibleBlock(block, topLevelBlockId)
          if (prevVisible) setFocusedBlockId(uiStateBlock, prevVisible.id)
        }
      },
      defaultBinding: {
        keys: 'up',
        eventOptions: {
          preventDefault: false,
        },
      },
    },
    {
      id: 'move_down_from_textarea_end',
      description: 'Move to next block when cursor is at end of textarea',
      context: ActionContextTypes.EDIT_MODE,
      handler: async (deps: EditModeDependencies) => {
        const {block, textarea, uiStateBlock} = deps
        if (!block || !textarea || !uiStateBlock) return

        const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
        if (!topLevelBlockId) return

        if (textarea.selectionStart === textarea.value.length &&
          textarea.selectionEnd === textarea.value.length) {
          const nextVisible = await nextVisibleBlock(block, topLevelBlockId)
          if (nextVisible) setFocusedBlockId(uiStateBlock, nextVisible.id)
        }
      },
      defaultBinding: {
        keys: 'down',
      },
    },
    {
      id: 'delete_empty_block',
      description: 'Delete empty block on backspace',
      context: ActionContextTypes.EDIT_MODE,
      handler: async (deps: EditModeDependencies) => {
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
    makeEditMode(indentBlock),
    makeEditMode(outdentBlock),
    moveBlockUp,
    moveBlockDown,
  ]

  // Multi-select mode actions
  const multiSelectModeActions: ActionConfig<typeof ActionContextTypes.MULTI_SELECT_MODE>[] = [
    makeMultiSelect(toggleBlockCollapse),
    makeMultiSelect(togglePropertiesDisplay),
    makeMultiSelect(indentBlock),
    makeMultiSelect(outdentBlock, {applyInReverseOrder: true}),
    makeMultiSelect(deleteBlock),
    makeMultiSelect(moveBlockUp),
    makeMultiSelect(moveBlockDown, {applyInReverseOrder: true}),
    {
      id: 'clear_selection',
      description: 'Clear selection',
      context: ActionContextTypes.MULTI_SELECT_MODE,
      handler: async (deps: MultiSelectModeDependencies) => deps.uiStateBlock.setProperty(selectionStateProp),
      defaultBinding: {
        keys: 'escape',
      },
    },
  ];

  [...globalActions,
    ...normalModeActions,
    ...editModeActions,
    ...multiSelectModeActions].forEach(action => actionManager.registerAction(action as ActionConfig))
}
