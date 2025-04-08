import { shortcutManager } from './ActionManager.ts'
import { BlockShortcutDependencies, EditModeDependencies, Action, ActionContextTypes } from './types'
import { previousVisibleBlock, nextVisibleBlock, defaultChangeScope, Block } from '@/data/block.ts'
import { splitBlockAtCursor } from '@/components/renderer/TextAreaContentRenderer.tsx'
import { Repo } from '@/data/repo.ts'

const setFocusedBlockId = (uiStateBlock: Block, id: string) => {
  uiStateBlock.setProperty('focusedBlockId', id, 'ui-state')
}

const setIsEditing = (uiStateBlock: Block, editing: boolean) => {
  uiStateBlock.setProperty('isEditing', editing, 'ui-state')
}

export function registerDefaultShortcuts({repo}: { repo: Repo, }) {
  // Global shortcuts
  shortcutManager.registerAction({
    id: 'command_palette',
    description: 'Open command palette',
    context: ActionContextTypes.GLOBAL,
    handler: () => {
      window.dispatchEvent(new CustomEvent('toggle-command-palette'))
    },
    defaultBinding: {
      keys: ['cmd+k', 'ctrl+k'],
    },
  })

  shortcutManager.registerAction({
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

  shortcutManager.registerAction({
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

  // Normal mode shortcuts
  shortcutManager.registerAction({
    id: 'move_down',
    description: 'Move to next block',
    context: ActionContextTypes.NORMAL_MODE,
    handler: async (deps: BlockShortcutDependencies) => {
      const {block, uiStateBlock} = deps
      if (!block || !uiStateBlock) return

      const topLevelBlockId = await uiStateBlock.getProperty<string>('topLevelBlockId')
      if (!topLevelBlockId) return

      const nextVisible = await nextVisibleBlock(block, topLevelBlockId)
      if (nextVisible) setFocusedBlockId(uiStateBlock, nextVisible.id)
    },
    defaultBinding: {
      keys: ['down', 'k'],
    },
  })

  shortcutManager.registerAction({
    id: 'move_up',
    description: 'Move to previous block',
    context: ActionContextTypes.NORMAL_MODE,
    handler: async (deps: BlockShortcutDependencies) => {
      const {block, uiStateBlock} = deps
      if (!block || !uiStateBlock) return

      const topLevelBlockId = await uiStateBlock.getProperty<string>('topLevelBlockId')
      if (!topLevelBlockId) return

      const prevVisible = await previousVisibleBlock(block, topLevelBlockId)
      if (prevVisible) setFocusedBlockId(uiStateBlock, prevVisible.id)
    },
    defaultBinding: {
      keys: ['up', 'h'],
    },
  })

  shortcutManager.registerAction({
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

  shortcutManager.registerAction({
    id: 'toggle_collapse',
    description: 'Toggle block collapse',
    context: ActionContextTypes.NORMAL_MODE,
    handler: async (deps: BlockShortcutDependencies) => {
      const {block} = deps
      if (!block) return

      const isCollapsed = await block.getProperty<boolean>('system:collapsed')
      block.setProperty('system:collapsed', !isCollapsed)
    },
    defaultBinding: {
      keys: 'z',
    },
  })

  shortcutManager.registerAction({
    id: 'toggle_properties',
    description: 'Toggle block properties',
    context: ActionContextTypes.NORMAL_MODE,
    handler: async (deps: BlockShortcutDependencies) => {
      const {block} = deps
      if (!block) return

      const showProperties = await block.getProperty<boolean>('system:showProperties')
      block.setProperty('system:showProperties', !showProperties)
    },
    defaultBinding: {
      keys: 't',
    },
  })

  const indentBlock: Action<typeof ActionContextTypes.NORMAL_MODE> = {
    id: 'indent_block',
    description: 'Indent block',
    context: ActionContextTypes.NORMAL_MODE, // Default context
    handler: (deps: BlockShortcutDependencies) => deps.block.indent(),
    defaultBinding: {
      keys: 'tab',
    },
  }

  shortcutManager.registerAction(indentBlock)
  shortcutManager.registerAction({
    ...indentBlock,
    id: 'edit.' + indentBlock.id,
    context: ActionContextTypes.EDIT_MODE,
  })

  const outdentBlock: Action<typeof ActionContextTypes.NORMAL_MODE> = {
    id: 'outdent_block',
    description: 'Outdent block',
    context: ActionContextTypes.NORMAL_MODE,
    handler: (deps: BlockShortcutDependencies) => deps.block.outdent(),
    defaultBinding: {
      keys: 'shift+tab',
    },
  }

  shortcutManager.registerAction(outdentBlock)
  shortcutManager.registerAction({
    ...outdentBlock,
    id: 'edit.' + outdentBlock.id,
    context: ActionContextTypes.EDIT_MODE,
  }) // Cast needed

  shortcutManager.registerAction({
    id: 'delete_block',
    description: 'Delete block',
    context: ActionContextTypes.NORMAL_MODE,
    handler: async (deps: BlockShortcutDependencies) => {
      const {block, uiStateBlock} = deps
      if (!block || !uiStateBlock) return

      const topLevelBlockId = await uiStateBlock.getProperty<string>('topLevelBlockId')
      if (!topLevelBlockId) return

      const prevVisible = await previousVisibleBlock(block, topLevelBlockId)
      void block.delete()
      if (prevVisible) setFocusedBlockId(uiStateBlock, prevVisible.id)
    },
    defaultBinding: {
      keys: 'delete',
    },
  })

  shortcutManager.registerAction({
    id: 'create_block_below_and_edit',
    description: 'Create block below (or as child) and enter edit mode',
    context: ActionContextTypes.NORMAL_MODE,
    handler: async (deps: BlockShortcutDependencies) => {
      const {block, uiStateBlock} = deps
      if (!block || !uiStateBlock) return

      const topLevelBlockId = await uiStateBlock.getProperty<string>('topLevelBlockId')
      if (!topLevelBlockId) return
      const isCollapsed = await block.getProperty<boolean>('system:collapsed')
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
  shortcutManager.registerAction({
    id: 'exit_edit_mode',
    description: 'Exit edit mode',
    context: ActionContextTypes.EDIT_MODE,
    handler: async (deps: EditModeDependencies) => setIsEditing(deps.uiStateBlock, false),
    defaultBinding: {
      keys: 'escape',
    },
  })

  // Textarea-specific shortcuts
  shortcutManager.registerAction({
    id: 'split_block',
    description: 'Split block at cursor',
    context: ActionContextTypes.EDIT_MODE,
    handler: async (deps: EditModeDependencies) => {
      const {block, textarea, uiStateBlock} = deps
      if (!block || !textarea || !uiStateBlock) return

      const topLevelBlockId = await uiStateBlock.getProperty<string>('topLevelBlockId')
      if (!topLevelBlockId) return
      const isCollapsed = await block.getProperty<boolean>('system:collapsed')
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

  shortcutManager.registerAction({
    id: 'move_up_from_textarea_start',
    description: 'Move to previous block when cursor is at start of textarea',
    context: ActionContextTypes.EDIT_MODE,
    handler: async (deps: EditModeDependencies) => {
      const {block, textarea, uiStateBlock} = deps
      if (!block || !textarea || !uiStateBlock) return

      const topLevelBlockId = await uiStateBlock.getProperty<string>('topLevelBlockId')
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

  shortcutManager.registerAction({
    id: 'move_down_from_textarea_end',
    description: 'Move to next block when cursor is at end of textarea',
    context: ActionContextTypes.EDIT_MODE,
    handler: async (deps: EditModeDependencies) => {
      const {block, textarea, uiStateBlock} = deps
      if (!block || !textarea || !uiStateBlock) return

      const topLevelBlockId = await uiStateBlock.getProperty<string>('topLevelBlockId')
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

  shortcutManager.registerAction({
    id: 'delete_empty_block',
    description: 'Delete empty block on backspace',
    context: ActionContextTypes.EDIT_MODE,
    handler: async (deps: EditModeDependencies) => {
      const {block, uiStateBlock} = deps
      if (!block || !uiStateBlock) return
      const blockData = await block.data()
      if (!(blockData?.content === '')) return

      const topLevelBlockId = await uiStateBlock.getProperty<string>('topLevelBlockId')
      if (!topLevelBlockId) return

      const prevVisible = await previousVisibleBlock(block, topLevelBlockId)
      block.delete()
      if (prevVisible) setFocusedBlockId(uiStateBlock, prevVisible.id)
    },
    defaultBinding: {
      keys: 'backspace',
    },
  })

  const moveBlockUp: Action<typeof ActionContextTypes.EDIT_MODE> = {
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
  shortcutManager.registerAction(moveBlockUp)
  shortcutManager.registerAction({
    ...moveBlockUp,
    id: 'normal.' + moveBlockUp.id,
    context: ActionContextTypes.NORMAL_MODE,
  } as Action<typeof ActionContextTypes.NORMAL_MODE>)

  const moveBlockDown: Action<typeof ActionContextTypes.EDIT_MODE> = {
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

  shortcutManager.registerAction(moveBlockDown)
  shortcutManager.registerAction({
    ...moveBlockDown,
    id: 'normal.' + moveBlockDown.id,
    context: ActionContextTypes.NORMAL_MODE,
  } as Action<typeof ActionContextTypes.NORMAL_MODE>)
}
