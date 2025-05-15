import { actionManager as defaultActionManager, ActionManager } from './ActionManager.ts'
import {
  BlockShortcutDependencies,
  EditModeDependencies,
  Action,
  ActionContextTypes,
  BaseShortcutDependencies, ActionConfig,
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

const setFocusedBlockId = (uiStateBlock: Block, id: string) => {
  uiStateBlock.setProperty({...focusedBlockIdProp, value: id})
}

const setIsEditing = (uiStateBlock: Block, editing: boolean) => {
  uiStateBlock.setProperty({...isEditingProp, value: editing})
}

export function registerDefaultShortcuts({repo}: { repo: Repo, }, actionManager: ActionManager = defaultActionManager) {
  // Global shortcuts
  actionManager.registerAction({
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
  })

  actionManager.registerAction({
    id: 'undo',
    description: 'Undo last action',
    context: ActionContextTypes.GLOBAL,
    handler: () => {
      repo.undoRedoManager.undo(defaultChangeScope)
    },
    defaultBinding: {
      keys: ['cmd+z', 'ctrl+z'],
    },
  })

  actionManager.registerAction({
    id: 'redo',
    description: 'Redo last action',
    context: ActionContextTypes.GLOBAL,
    handler: () => {
      repo.undoRedoManager.redo(defaultChangeScope)
    },
    defaultBinding: {
      keys: ['cmd+shift+z', 'ctrl+shift+z', 'cmd+y', 'ctrl+y'],
    },
  })

  // New Global Actions for Command Palette Items
  actionManager.registerAction({
    id: 'open_router_settings',
    description: 'Open Router Settings',
    context: ActionContextTypes.GLOBAL,
    handler: () => {
      // No-op: Logic is handled directly in CommandPalette's runCommand
      console.log('[Action:open_settings] Triggered. Dialog opening handled by CommandPalette.')

      // todo this is not good and we should move towards something like "popup managed by layout renderer"
      // and we pass a block to render to it
    },
  })

  actionManager.registerAction({
    id: 'refresh_renderers',
    description: 'Refresh Renderer Registry',
    context: ActionContextTypes.GLOBAL,
    handler: () => {
      refreshRendererRegistry()
      console.log('Renderer registry refreshed.')
    },
    // No default binding
  })

  // Normal mode shortcuts
  actionManager.registerAction({
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
  })

  actionManager.registerAction({
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
  })

  actionManager.registerAction({
    id: 'enter_edit_mode',
    description: 'Enter edit mode',
    context: ActionContextTypes.NORMAL_MODE,
    handler: async (deps: BlockShortcutDependencies) => {
      const {block, uiStateBlock} = deps
      if (!block || !uiStateBlock) return

      setIsEditing(uiStateBlock, true)
    },
    defaultBinding: {
      keys: 'i',
    },
  })

  actionManager.registerAction({
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
  })

  actionManager.registerAction({
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
  })

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

  actionManager.registerAction(indentBlock)
  actionManager.registerAction({
    ...indentBlock,
    id: 'edit.' + indentBlock.id,
    context: ActionContextTypes.EDIT_MODE,
  })

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

  actionManager.registerAction(outdentBlock)
  actionManager.registerAction({
    ...outdentBlock,
    id: 'edit.' + outdentBlock.id,
    context: ActionContextTypes.EDIT_MODE,
  })

  actionManager.registerAction({
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
  })

  actionManager.registerAction({
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
  })

  // Edit mode shortcuts
  actionManager.registerAction({
    id: 'exit_edit_mode',
    description: 'Exit edit mode',
    context: ActionContextTypes.EDIT_MODE,
    handler: async (deps: EditModeDependencies) => setIsEditing(deps.uiStateBlock, false),
    defaultBinding: {
      keys: 'escape',
    },
  })

  // Textarea-specific shortcuts
  actionManager.registerAction({
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
  })

  actionManager.registerAction({
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
  })

  actionManager.registerAction({
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
  })

  actionManager.registerAction({
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
  })

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
  actionManager.registerAction(moveBlockUp)
  actionManager.registerAction({
    ...moveBlockUp,
    id: 'normal.' + moveBlockUp.id,
    context: ActionContextTypes.NORMAL_MODE,
  } as Action<typeof ActionContextTypes.NORMAL_MODE>)

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

  actionManager.registerAction(moveBlockDown)
  actionManager.registerAction({
    ...moveBlockDown,
    id: 'normal.' + moveBlockDown.id,
    context: ActionContextTypes.NORMAL_MODE,
  } as Action<typeof ActionContextTypes.NORMAL_MODE>)

  actionManager.registerAction({
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
  })

  actionManager.registerAction({
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
  })
}
