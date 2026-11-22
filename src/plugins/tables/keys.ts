/** The grid's key modes. Row focused: the row block holds app focus and the
 *  grid moves the column, steps rows, opens and clears cells. Editing a cell:
 *  Enter, Tab and Escape commit and move. An inline control (checkbox, date,
 *  select) takes the same three keys in its cell's own keydown, see
 *  `controlKeyCommand`. */
import { Block } from '@/data/block'
import { structuralEditPolicyForBlock } from '@/data/structuralEditPolicy'
import type { ShortcutActivationContribution } from '@/extensions/blockInteraction'
import { actionDispatchWrap, type ActionDispatchDecorator } from '@/shortcuts/actionDispatch'
import {
  ActionContextTypes,
  type ActionConfig, type ActionContextConfig, type ActionContextType, type BaseShortcutDependencies,
  type BlockShortcutDependencies, type CodeMirrorEditModeDependencies,
} from '@/shortcuts/types'
import { isOnFirstVisualLine, isOnLastVisualLine } from '@/utils/codemirror'
import type { BlockContextType } from '@/types'
import { CELL_CONTROL_SELECTOR, GridController, type GridCommand } from './controller'
import { gridDrawing, gridOfHost } from './registry'

export const GRID_CONTEXT_KEY = 'tablesGrid'
/** The id of the row, or of the cell's value, whose context this is. A context
 *  field reaches the whole subtree, references and embeds included, so only
 *  the block it names takes the role. */
export const ROW_CONTEXT_KEY = 'tablesRowId'
export const CELL_CONTEXT_KEY = 'tablesCellId'

export type TableRole = 'row' | 'cell'

/** What the grid draws this block as, if anything. */
export const tableRoleOf = (blockId: string, context: BlockContextType | undefined): TableRole | undefined => {
  if (!context || context.isReference || context.isBreadcrumb) return undefined
  if (context[CELL_CONTEXT_KEY] === blockId) return 'cell'
  if (context[ROW_CONTEXT_KEY] === blockId) return 'row'
  return undefined
}

export const TABLE_ROW_CONTEXT = 'tables.row'
export const TABLE_TYPING_CONTEXT = 'tables.row-typing'
export const TABLE_EDIT_CONTEXT = 'tables.edit'

export interface GridDependencies extends BaseShortcutDependencies {
  /** Returns false when the command does not apply, so the key falls through. */
  gridCommand: (command: GridCommand, key?: string) => boolean
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
  handler: (deps, trigger) => {
    if (!isGridDependencies(deps)) return false
    if (options.yieldToEditor && handledElsewhere(trigger)) return false
    // Focus reaches a control before row mode deactivates: the key is the control's.
    if (onCellControl(trigger)) return false
    const key = options.passKey && trigger instanceof KeyboardEvent && trigger.key.length === 1 ? trigger.key : undefined
    if (!deps.gridCommand(command, key)) return false
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
  const grid = activation.blockContext?.[GRID_CONTEXT_KEY]
  if (!(grid instanceof GridController)) return null
  return activation.surface === 'codemirror' && activation.inEditMode && tableRoleOf(activation.block.id, activation.blockContext)
    ? [{context: TABLE_EDIT_CONTEXT, dependencies: {gridCommand: grid.command}}]
    : null
}

/** The outline's verbs walk the outline around a block: on a row or a cell's
 *  value they would step into property rows or children the grid never draws,
 *  or create a block it never shows. On a grid's row or value the grid takes
 *  them instead, and a command that does not apply falls back to the verb. */
const redirect = (
  context: ActionContextType, actionId: string, command: GridCommand,
  applies: (deps: BaseShortcutDependencies) => boolean = () => true,
): ActionDispatchDecorator => ({
  actionId,
  context,
  wrap: (deps, trigger, next) => {
    const {block, renderScopeId} = deps as BlockShortcutDependencies
    const grid = gridDrawing(renderScopeId, block?.id)
    if (!grid || !applies(deps) || !grid.command(command)) return next(deps, trigger)
  },
})

/** The editor verbs act only at the editor's edge; inside, the key moves the
 *  caret. The same tests as the verbs they redirect. */
const atEdge = (edge: 'top' | 'bottom' | 'start' | 'end') => (deps: BaseShortcutDependencies) => {
  const view = (deps as CodeMirrorEditModeDependencies).editorView
  if (!view) return false
  const selection = view.state.selection.main
  switch (edge) {
    case 'top': return isOnFirstVisualLine(view)
    case 'bottom': return isOnLastVisualLine(view)
    case 'start': return selection.empty && selection.head === 0
    case 'end': return selection.empty && selection.head === view.state.doc.length
  }
}

/** On a table host, the outline's "create below" (and "create above" at a scope
 *  root) makes a first child, which is the grid's first row, and focuses it in
 *  the host's own scope, where the grid does not draw it: no editor appears.
 *  The grid makes that row instead, focused where it draws it. Where the
 *  outline would make a sibling of the host, it still does. */
const hostInsert = (
  context: ActionContextType, actionId: string, placement: 'createBelowPlacement' | 'createAbovePlacement',
  applies: (deps: BaseShortcutDependencies) => boolean = () => true,
): ActionDispatchDecorator => ({
  actionId,
  context,
  wrap: async (deps, trigger, next) => {
    const {block, renderScopeId} = deps as BlockShortcutDependencies
    const grid = block ? gridOfHost(renderScopeId ?? '', block.id) : undefined
    if (!grid || !applies(deps) || (await structuralEditPolicyForBlock(block, deps))[placement] !== 'child-first') {
      await next(deps, trigger)
      return
    }
    await grid.insertFirstRow()
  },
})

const NORMAL = ActionContextTypes.NORMAL_MODE
const EDITING = ActionContextTypes.EDIT_MODE_CM

export const tableOutlineVerbRedirects = [
  redirect(NORMAL, 'move_down', 'down'),
  redirect(NORMAL, 'move_up', 'up'),
  redirect(NORMAL, 'move_left', 'left'),
  redirect(NORMAL, 'move_right', 'right'),
  redirect(NORMAL, 'create_block_below_and_edit', 'insert-below'),
  redirect(NORMAL, 'create_block_above_and_edit', 'insert-above'),
  redirect(NORMAL, 'enter_edit_mode', 'open-start'),
  redirect(NORMAL, 'enter_edit_mode_at_end', 'open'),
  // Arrows at an editor's edge leave the cell the way row mode moves.
  redirect(EDITING, 'move_up_from_cm_start', 'up', atEdge('top')),
  redirect(EDITING, 'move_down_from_cm_end', 'down', atEdge('bottom')),
  redirect(EDITING, 'move_left_from_cm_start', 'previous', atEdge('start')),
  redirect(EDITING, 'move_right_from_cm_end', 'next', atEdge('end')),
  hostInsert(NORMAL, 'create_block_below_and_edit', 'createBelowPlacement'),
  hostInsert(NORMAL, 'create_block_above_and_edit', 'createAbovePlacement'),
  // Enter at the end of the host's text; mid-text it splits the host.
  hostInsert(EDITING, 'split_block_cm', 'createBelowPlacement', atEdge('end')),
].map(decorator => actionDispatchWrap(decorator, {source: 'tables', precedence: 100}))
