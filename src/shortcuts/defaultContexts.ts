import {
  ActionContextConfig,
  ActionContextTypes,
  BaseShortcutDependencies,
  BlockShortcutDependencies,
  CodeMirrorEditModeDependencies,
  CommandPaletteDependencies,
  MultiSelectModeDependencies,
  PropertyEditingDependencies,
} from '@/shortcuts/types.ts'
import { Block } from '@/data/internals/block'
import { EditorView } from '@codemirror/view'

const isBaseShortcutDependencies = (deps: unknown): deps is BaseShortcutDependencies =>
  typeof deps === 'object' && deps !== null && 'uiStateBlock' in deps && deps.uiStateBlock instanceof Block

const isBlockShortcutDependencies = (deps: unknown): deps is BlockShortcutDependencies =>
  isBaseShortcutDependencies(deps) && typeof deps === 'object' && deps !== null && 'block' in deps && deps.block instanceof Block

const isCodeMirrorEditModeDependencies = (deps: unknown): deps is CodeMirrorEditModeDependencies =>
  isBaseShortcutDependencies(deps) && typeof deps === 'object' && deps !== null && 'block' in deps && deps.block instanceof Block && 'editorView' in deps && deps.editorView instanceof EditorView

const isPropertyEditingDependencies = (deps: unknown): deps is PropertyEditingDependencies =>
  isBlockShortcutDependencies(deps) && typeof deps === 'object' && deps !== null && 'input' in deps && deps.input instanceof HTMLInputElement

const isCommandPaletteDependencies = (deps: unknown): deps is CommandPaletteDependencies =>
  isBaseShortcutDependencies(deps)

const isMultiSelectModeDependencies = (deps: unknown): deps is MultiSelectModeDependencies =>
  isBaseShortcutDependencies(deps) &&
  typeof deps === 'object' && deps !== null &&
  'selectedBlocks' in deps && Array.isArray(deps.selectedBlocks) && (deps.selectedBlocks as unknown[]).every(b => b instanceof Block) &&
  'anchorBlock' in deps && (deps.anchorBlock === null || deps.anchorBlock instanceof Block)

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
    validateDependencies: isPropertyEditingDependencies,
  },
  {
    type: ActionContextTypes.COMMAND_PALETTE,
    displayName: 'Command Palette',
    validateDependencies: isCommandPaletteDependencies,
  },
  {
    type: ActionContextTypes.MULTI_SELECT_MODE,
    displayName: 'Multi-Select Mode',
    validateDependencies: isMultiSelectModeDependencies,
  },
]
