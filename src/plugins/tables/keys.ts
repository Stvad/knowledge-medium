/** The grid's key modes. Row focused: the row block holds app focus and the
 *  grid moves the column, steps rows, opens and clears cells. Editing a cell:
 *  Enter, Tab and Escape commit and move. An inline control (checkbox, date,
 *  select) takes the same three keys in its cell's own keydown, see
 *  `controlKeyCommand`. */
import { Block } from '@/data/block'
import type { ShortcutActivationContribution } from '@/extensions/blockInteraction'
import { actionDispatchWrap, type ActionDispatchDecorator } from '@/shortcuts/actionDispatch'
import {
  ActionContextTypes,
  type ActionConfig, type ActionContextConfig, type BaseShortcutDependencies, type BlockShortcutDependencies,
} from '@/shortcuts/types'
import { CELL_CONTROL_SELECTOR, GridController, type GridCommand } from './controller'
import { gridForRow } from './registry'

export const GRID_CONTEXT_KEY = 'tablesGrid'
/** Set to the row's id on the context its row mounts in, so the layout
 *  draws that block, and only that block, as a row. */
export const ROW_CONTEXT_KEY = 'tablesRowId'
export const CELL_CONTEXT_KEY = 'tablesCell'

export const TABLE_ROW_CONTEXT = 'tables.row'
export const TABLE_TYPING_CONTEXT = 'tables.row-typing'
export const TABLE_EDIT_CONTEXT = 'tables.edit'

export interface GridDependencies extends BaseShortcutDependencies {
  gridCommand: (command: GridCommand, key?: string) => void
  /** Vim's normal mode owns printable keys while it is active. */
  normalModeActive?: () => boolean
}

const isGridDependencies = (deps: unknown): deps is GridDependencies =>
  typeof deps === 'object' && deps !== null &&
  (deps as GridDependencies).uiStateBlock instanceof Block &&
  typeof (deps as GridDependencies).gridCommand === 'function'

const context = (type: string, displayName: string, options: Partial<ActionContextConfig> = {}): ActionContextConfig => ({
  type,
  displayName,
  priority: 'high',
  validateDependencies: isGridDependencies,
  ...options,
})

export const tableActionContexts: ActionContextConfig[] = [
  context(TABLE_ROW_CONTEXT, 'Table row'),
  context(TABLE_TYPING_CONTEXT, 'Table row (typing)', {priority: 'default'}),
  // An editor is an editable target, which the default filter turns away.
  context(TABLE_EDIT_CONTEXT, 'Table cell editing', {eventFilter: () => true}),
]

/** A key an open completion already handled is not the grid's. */
const handledElsewhere = (trigger: unknown) => trigger instanceof KeyboardEvent && trigger.defaultPrevented

const onCellControl = (trigger: unknown) =>
  trigger instanceof KeyboardEvent && trigger.target instanceof Element && trigger.target.matches(CELL_CONTROL_SELECTOR)

const gridAction = (
  contextType: string, command: GridCommand, keys: string | string[],
  options: {yieldToEditor?: boolean; passKey?: boolean} = {},
): ActionConfig => ({
  id: `${contextType}.${command}`,
  context: contextType,
  description: `Table: ${command}`,
  defaultBinding: {keys, eventOptions: {preventDefault: true}},
  isVisible: () => false,
  ...(contextType === TABLE_TYPING_CONTEXT
    ? {canDispatch: (deps: GridDependencies) => deps.normalModeActive?.() !== true}
    : {}),
  handler: (deps, trigger) => {
    if (!isGridDependencies(deps)) return
    if (options.yieldToEditor && handledElsewhere(trigger)) return false
    // Focus reaches a control before row mode deactivates: the key is the control's.
    if (onCellControl(trigger)) return false
    const key = options.passKey && trigger instanceof KeyboardEvent && trigger.key.length === 1 ? trigger.key : undefined
    deps.gridCommand(command, key)
  },
})

const PRINTABLE = [
  ...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''),
  'Period', 'Comma', 'Slash', 'Backslash', 'Semicolon', 'Quote', 'Backquote',
  'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Space',
]

/** Enter and Escape yield to an open completion, which handles them first. */
const editKeys = [
  gridAction(TABLE_EDIT_CONTEXT, 'down', 'Enter', {yieldToEditor: true}),
  gridAction(TABLE_EDIT_CONTEXT, 'next', 'Tab'),
  gridAction(TABLE_EDIT_CONTEXT, 'previous', 'Shift+Tab'),
  gridAction(TABLE_EDIT_CONTEXT, 'leave', 'Escape', {yieldToEditor: true}),
]

/** A focused control activates the core property-editing context, which is
 *  modal: whichever modal activated last would win, so its cell takes these
 *  keys in its own keydown, before the shortcut system sees them. */
export const controlKeyCommand = (event: {key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean}): GridCommand | undefined => {
  if (event.metaKey || event.ctrlKey || event.altKey) return undefined
  if (event.key === 'Enter' && !event.shiftKey) return 'down'
  if (event.key === 'Tab') return event.shiftKey ? 'previous' : 'next'
  if (event.key === 'Escape' && !event.shiftKey) return 'leave'
  return undefined
}

export const tableActions: ActionConfig[] = [
  gridAction(TABLE_ROW_CONTEXT, 'left', 'ArrowLeft'),
  gridAction(TABLE_ROW_CONTEXT, 'right', 'ArrowRight'),
  gridAction(TABLE_ROW_CONTEXT, 'up', 'ArrowUp'),
  gridAction(TABLE_ROW_CONTEXT, 'down', 'ArrowDown'),
  gridAction(TABLE_ROW_CONTEXT, 'next', 'Tab'),
  gridAction(TABLE_ROW_CONTEXT, 'previous', 'Shift+Tab'),
  gridAction(TABLE_ROW_CONTEXT, 'open', 'Enter'),
  gridAction(TABLE_ROW_CONTEXT, 'clear', ['Delete', 'Backspace']),
  gridAction(TABLE_TYPING_CONTEXT, 'open', [...PRINTABLE, ...PRINTABLE.map(key => `Shift+${key}`)], {passKey: true}),
  ...editKeys,
]

/** Editing a cell or a row's text. Row mode is activated by the grid itself
 *  (`RowKeys`): a row that focus moved to may still be a lazy placeholder,
 *  with no shell to activate anything. */
export const tableShortcutActivation: ShortcutActivationContribution = activation => {
  if (!activation.inFocus || activation.isSelected) return null
  const blockContext = activation.blockContext
  const grid = blockContext?.[GRID_CONTEXT_KEY]
  if (!(grid instanceof GridController)) return null
  const isRow = blockContext?.[ROW_CONTEXT_KEY] === activation.block.id
  const isCell = blockContext?.[CELL_CONTEXT_KEY] === true && blockContext.scopeRootId === activation.block.id
  return activation.surface === 'codemirror' && activation.inEditMode && (isRow || isCell)
    ? [{context: TABLE_EDIT_CONTEXT, dependencies: {gridCommand: grid.run}}]
    : null
}

/** Vim's normal-mode verbs act on the outline around a block: on a row they
 *  would step into its property rows, or create a child the grid never
 *  draws. On a grid row the grid takes them instead. */
const redirect = (actionId: string, command: GridCommand): ActionDispatchDecorator => ({
  actionId,
  context: ActionContextTypes.NORMAL_MODE,
  wrap: (deps, trigger, next) => {
    const {block, renderScopeId} = deps as BlockShortcutDependencies
    const grid = gridForRow(renderScopeId, block?.id)
    if (!grid) return next(deps, trigger)
    grid.command(command)
  },
})

export const tableNormalModeRedirects = [
  redirect('move_down', 'down'),
  redirect('move_up', 'up'),
  redirect('move_left', 'left'),
  redirect('move_right', 'right'),
  redirect('create_block_below_and_edit', 'insert-below'),
  redirect('create_block_above_and_edit', 'insert-above'),
  redirect('enter_edit_mode', 'open-start'),
  redirect('enter_edit_mode_at_end', 'open'),
].map(decorator => actionDispatchWrap(decorator, {source: 'tables', precedence: 100}))
