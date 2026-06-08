import {
  ActionContextConfig,
  ActionContextTypes,
  BaseShortcutDependencies,
  BlockPointerDependencies,
  BlockShortcutDependencies,
  CodeMirrorEditModeDependencies,
  MultiSelectModeDependencies,
  PropertyEditingDependencies,
} from '@/shortcuts/types.js'
import { Block } from '../data/block'
import { EditorView } from '@codemirror/view'

const isBaseShortcutDependencies = (deps: unknown): deps is BaseShortcutDependencies =>
  typeof deps === 'object' && deps !== null && 'uiStateBlock' in deps && deps.uiStateBlock instanceof Block

const isBlockShortcutDependencies = (deps: unknown): deps is BlockShortcutDependencies =>
  isBaseShortcutDependencies(deps) && typeof deps === 'object' && deps !== null && 'block' in deps && deps.block instanceof Block

const isCodeMirrorEditModeDependencies = (deps: unknown): deps is CodeMirrorEditModeDependencies =>
  isBaseShortcutDependencies(deps) && typeof deps === 'object' && deps !== null && 'block' in deps && deps.block instanceof Block && 'editorView' in deps && deps.editorView instanceof EditorView

const isPropertyEditingDependencies = (deps: unknown): deps is PropertyEditingDependencies =>
  isBlockShortcutDependencies(deps) && typeof deps === 'object' && deps !== null && 'input' in deps && deps.input instanceof HTMLInputElement

const isMultiSelectModeDependencies = (deps: unknown): deps is MultiSelectModeDependencies =>
  isBaseShortcutDependencies(deps) &&
  typeof deps === 'object' && deps !== null &&
  'selectedBlocks' in deps && Array.isArray(deps.selectedBlocks) && (deps.selectedBlocks as unknown[]).every(b => b instanceof Block) &&
  'anchorBlock' in deps && (deps.anchorBlock === null || deps.anchorBlock instanceof Block)

const isBlockPointerDependencies = (deps: unknown): deps is BlockPointerDependencies =>
  isBlockShortcutDependencies(deps) &&
  typeof deps === 'object' && deps !== null &&
  'targetElement' in deps && deps.targetElement instanceof HTMLElement

export const defaultActionContextConfigs: readonly ActionContextConfig[] = [
  {
    type: ActionContextTypes.GLOBAL,
    displayName: 'Global',
    validateDependencies: isBaseShortcutDependencies,
  },
  {
    type: ActionContextTypes.NORMAL_MODE,
    displayName: 'Normal Mode',
    validateDependencies: isBlockShortcutDependencies,
  },
  {
    type: ActionContextTypes.EDIT_MODE_CM,
    displayName: 'Edit Mode (CodeMirror)',
    defaultEventOptions: {
      preventDefault: false,
    },
    eventFilter: (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      return target?.closest('.cm-editor') !== null
    },
    validateDependencies: isCodeMirrorEditModeDependencies,
  },
  {
    type: ActionContextTypes.PROPERTY_EDITING,
    displayName: 'Property Editing',
    modal: true,
    validateDependencies: isPropertyEditingDependencies,
  },
  {
    type: ActionContextTypes.MULTI_SELECT_MODE,
    displayName: 'Multi-Select Mode',
    modal: true,
    validateDependencies: isMultiSelectModeDependencies,
  },
  {
    // Never auto-activated; dispatched with supplied deps from the block shell.
    // Carries no bindings to install, so modal/priority are irrelevant.
    type: ActionContextTypes.BLOCK_POINTER,
    displayName: 'Block Pointer Gesture',
    validateDependencies: isBlockPointerDependencies,
  },
]
