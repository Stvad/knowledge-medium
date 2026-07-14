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
import { isInteractiveContentEvent } from '@/extensions/blockInteraction.js'
import { Block } from '../data/block'
import { EditorView } from '@codemirror/view'

const isBaseShortcutDependencies = (deps: unknown): deps is BaseShortcutDependencies =>
  typeof deps === 'object' && deps !== null && 'uiStateBlock' in deps && deps.uiStateBlock instanceof Block

const hasRenderVisibilityPolicy = (
  deps: unknown,
): deps is {renderVisibilityPolicy: object} =>
  typeof deps === 'object' &&
  deps !== null &&
  'renderVisibilityPolicy' in deps &&
  typeof deps.renderVisibilityPolicy === 'object' &&
  deps.renderVisibilityPolicy !== null

const isBlockShortcutDependencies = (deps: unknown): deps is BlockShortcutDependencies =>
  isBaseShortcutDependencies(deps) &&
  hasRenderVisibilityPolicy(deps) &&
  typeof deps === 'object' &&
  deps !== null &&
  'block' in deps &&
  deps.block instanceof Block

const isCodeMirrorEditModeDependencies = (deps: unknown): deps is CodeMirrorEditModeDependencies =>
  isBlockShortcutDependencies(deps) &&
  typeof deps === 'object' &&
  deps !== null &&
  'editorView' in deps &&
  deps.editorView instanceof EditorView

const isPropertyEditingDependencies = (deps: unknown): deps is PropertyEditingDependencies =>
  isBlockShortcutDependencies(deps) && typeof deps === 'object' && deps !== null && 'input' in deps && deps.input instanceof HTMLInputElement

const isMultiSelectModeDependencies = (deps: unknown): deps is MultiSelectModeDependencies =>
  isBaseShortcutDependencies(deps) &&
  hasRenderVisibilityPolicy(deps) &&
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
    // Its actions must not surface as keyboard-bindable.
    type: ActionContextTypes.BLOCK_POINTER,
    displayName: 'Block Pointer Gesture',
    keyboardBindable: false,
    // A pointer/gesture physically targeting a block outranks an ambient-mode
    // binding for the SAME trigger: this context is never "active" (it carries
    // supplied deps, not installed state), so without a priority it would lose
    // the recency tiebreak in `compareContexts` to whatever scoped mode (e.g.
    // normal-mode) is focused. `high` flips that for pointer/gesture dispatch —
    // e.g. a right-swipe that closes an open quick-action menu (block-pointer)
    // wins over the todo cycle (normal-mode) bound to the same `swipe-right`.
    // Modal contexts still outrank it (tier beats priority), and it carries no
    // keyboard bindings, so this only reorders the pointer/gesture path.
    priority: 'high',
    // Clicks landing on interactive descendants (links, buttons, …) keep their
    // native behavior — block gestures never apply there. Declaring it once on
    // the context means individual pointer actions (select/toggle/edit) don't
    // each re-check, and a Shift-click on a link can't be claimed as selection.
    pointerTargetFilter: event => !isInteractiveContentEvent(event),
    validateDependencies: isBlockPointerDependencies,
  },
]
