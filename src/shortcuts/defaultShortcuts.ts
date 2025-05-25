import { actionManager as defaultActionManager, ActionManager } from './ActionManager.ts'
import {
  BlockShortcutDependencies,
  EditModeDependencies,
  ActionContextTypes,
  BaseShortcutDependencies,
  ActionConfig,
  MultiSelectModeDependencies,
} from './types'
import {
  previousVisibleBlock,
  nextVisibleBlock,
  defaultChangeScope,
  Block,
  getAllChildrenBlocks,
  getRootBlock,
} from '@/data/block.ts'
import { serializeBlockForClipboard } from '../../utils/copy'; // Added import
import { ClipboardData } from '../../types'; // Added import
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
import { selectionStateProp, SelectionStateProperty } from '@/data/properties' // Added SelectionStateProperty
import { extendSelection } from '@/utils/selection'
import { applyToAllBlocksInSelection, makeNormalMode, makeEditMode, makeMultiSelect } from './utils'

const setFocusedBlockId = (uiStateBlock: Block, id: string) => {
  uiStateBlock.setProperty({...focusedBlockIdProp, value: id})
}

const setIsEditing = (uiStateBlock: Block, editing: boolean) => {
  uiStateBlock.setProperty({...isEditingProp, value: editing})
}

// Exportable handler logic for copy_block
export async function handleCopyBlock(deps: BlockShortcutDependencies) {
  const { block, repo } = deps; // Added repo from deps
  if (!block || !repo) return; // Added repo check

  try {
    const clipboardData: ClipboardData = await serializeBlockForClipboard(block, repo); // Pass repo
    // const jsonString = JSON.stringify(clipboardData); // No longer needed for a separate writeText

    // await navigator.clipboard.writeText(jsonString); // Removed
    if (navigator.clipboard.write) {
      const fullJsonString = JSON.stringify(clipboardData);
      const clipboardItem = new ClipboardItem({
        'text/plain': new Blob([clipboardData.markdown], { type: 'text/plain' }),
        'application/json': new Blob([fullJsonString], { type: 'application/json' })
      });
      await navigator.clipboard.write([clipboardItem]);
      console.log('Block content copied to clipboard (markdown and JSON).');
    } else {
      // Fallback if navigator.clipboard.write is not available (very unlikely if writeText was, but for safety)
      // In this scenario, we can only write text. We'll write the JSON as text.
      const fullJsonString = JSON.stringify(clipboardData);
      await navigator.clipboard.writeText(fullJsonString);
      console.log('Block content (JSON) copied to clipboard as text. Rich copy skipped (navigator.clipboard.write not available).');
    }
  } catch (error) {
    console.error('Failed to copy block to clipboard:', error);
  }
}

// Exportable handler logic for copy_selected_blocks
export async function handleCopySelectedBlocks(deps: MultiSelectModeDependencies) {
  const { uiStateBlock, repo } = deps;
  if (!uiStateBlock || !repo) return;

  const selectionState = (await uiStateBlock.getProperty(selectionStateProp))?.value;
  if (!selectionState || !selectionState.selectedBlockIds || selectionState.selectedBlockIds.length === 0) {
    console.log('No blocks selected to copy.');
    return;
  }

  const selectedBlockIds = selectionState.selectedBlockIds;
  const allBlockData: import('../../data/block').BlockData[] = [];
  const markdownParts: string[] = [];

  for (const blockId of selectedBlockIds) {
    const block = repo.find(blockId);
    if (block) {
      try {
        // Assuming serializeBlockForClipboard is correctly imported and used
        const clipboardBlockData = await serializeBlockForClipboard(block, repo); // Pass repo
        if (clipboardBlockData.blocks && clipboardBlockData.blocks.length > 0) {
          // If serializeBlockForClipboard now returns all descendants,
          // and we want to keep the flat structure for 'blocks' in ClipboardData
          // for copy_selected_blocks, we might need to adjust this logic.
          // For now, assuming it returns the primary block and its descendants,
          // and we're collecting all such primary blocks (and their descendants) here.
          // This part might need revisiting based on how ClipboardData for multi-select should be structured.
          // Based on current serializeBlockForClipboard, clipboardBlockData.blocks IS allBlockData (root + descendants)
          // So, we should spread it.
          allBlockData.push(...clipboardBlockData.blocks);
        }
        // The markdown from serializeBlockForClipboard is already combined for the block and its descendants.
        markdownParts.push(clipboardBlockData.markdown); 
      } catch (error) {
        console.error(`Failed to serialize block ${blockId} for clipboard:`, error);
      }
    }
  }

  if (allBlockData.length === 0) {
    console.log('No block data could be serialized for copying.');
    return;
  }

  const combinedMarkdown = markdownParts.join('\n\n');
  const clipboardData: ClipboardData = {
    markdown: combinedMarkdown,
    blocks: allBlockData,
  };

  try {
    // const jsonString = JSON.stringify(clipboardData); // No longer needed for a separate writeText
    // await navigator.clipboard.writeText(jsonString); // Removed

    if (navigator.clipboard.write) {
      const fullJsonString = JSON.stringify(clipboardData); // clipboardData is the finalClipboardData
      const clipboardItem = new ClipboardItem({
        'text/plain': new Blob([clipboardData.markdown], { type: 'text/plain' }), // Use combinedMarkdown from clipboardData
        'application/json': new Blob([fullJsonString], { type: 'application/json' })
      });
      await navigator.clipboard.write([clipboardItem]);
      console.log('Selected blocks copied to clipboard (markdown and JSON).');
    } else {
      // Fallback
      const fullJsonString = JSON.stringify(clipboardData);
      await navigator.clipboard.writeText(fullJsonString);
      console.log('Selected blocks (JSON) copied to clipboard as text. Rich copy skipped (navigator.clipboard.write not available).');
    }
  } catch (error) {
    console.error('Failed to copy selected blocks to clipboard:', error);
  }
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
  const extendSelectionUp = {
    id: 'extend_selection_up',
    description: 'Extend selection up',
    context: ActionContextTypes.NORMAL_MODE,
    handler: async (deps: BlockShortcutDependencies) => {
      const {uiStateBlock} = deps

      const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
      if (!topLevelBlockId) return

      const focusedBlockId = (await uiStateBlock.getProperty(focusedBlockIdProp))?.value
      if (!focusedBlockId) return

      const prevBlock = await previousVisibleBlock(repo.find(focusedBlockId), topLevelBlockId)
      if (!prevBlock) return

      console.log('extend selection up', prevBlock.id, focusedBlockId)

      await extendSelection(prevBlock.id, uiStateBlock, repo)
    },
    defaultBinding: {
      keys: 'shift+up',
    },
  }
  const extendSelectionDown = {
    id: 'extend_selection_down',
    description: 'Extend selection down',
    context: ActionContextTypes.NORMAL_MODE,
    handler: async (deps: BlockShortcutDependencies) => {
      const {uiStateBlock} = deps

      const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
      if (!topLevelBlockId) return

      const focusedBlockId = (await uiStateBlock.getProperty(focusedBlockIdProp))?.value
      if (!focusedBlockId) return

      const nextBlock = await nextVisibleBlock(repo.find(focusedBlockId), topLevelBlockId)
      if (!nextBlock) return

      await extendSelection(nextBlock.id, uiStateBlock, repo)
    },
    defaultBinding: {
      keys: 'shift+down',
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
        keys: ['space', 'v'],
      },
    },
    extendSelectionUp,
    extendSelectionDown,
    makeNormalMode(moveBlockUp),
    makeNormalMode(moveBlockDown),
    {
      id: 'copy_block',
      description: 'Copy block to clipboard',
      context: ActionContextTypes.NORMAL_MODE,
      handler: handleCopyBlock, // Use extracted handler
      defaultBinding: {
        keys: ['cmd+c', 'ctrl+c'],
        eventOptions: {
          preventDefault: true,
        },
      },
    },
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
    makeMultiSelect(extendSelectionUp),
    makeMultiSelect(extendSelectionDown),
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
      handler: handleCopySelectedBlocks, // Use extracted handler
      defaultBinding: {
        keys: ['cmd+c', 'ctrl+c'],
        eventOptions: {
          preventDefault: true,
        },
      },
    },
  ];

  [...globalActions,
    ...normalModeActions,
    ...editModeActions,
    ...multiSelectModeActions].forEach(action => actionManager.registerAction(action as ActionConfig))
}
