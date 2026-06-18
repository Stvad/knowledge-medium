import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { ActionContextTypes } from '@/shortcuts/types.js'
import {
  keybindingOverridesFacet,
  type KeybindingOverride,
} from '@/shortcuts/keybindingOverrides.js'
import {
  DATE_SCRUB_CONTEXT,
  DATE_SCRUB_DAY_BACKWARD_ACTION_ID,
  DATE_SCRUB_DAY_FORWARD_ACTION_ID,
  DATE_SCRUB_WEEK_BACKWARD_ACTION_ID,
  DATE_SCRUB_WEEK_FORWARD_ACTION_ID,
} from '@/plugins/daily-notes/dateScrubActions.ts'

export const COLEMAK_KEYBINDINGS_PLUGIN_ID = 'system:colemak-keybindings'
const SOURCE = 'colemak-keybindings'

export const colemakMovementKeybindingOverrides: readonly KeybindingOverride[] = [
  {
    actionId: 'move_down',
    context: ActionContextTypes.NORMAL_MODE,
    binding: {keys: ['ArrowDown', 'k']},
    source: SOURCE,
  },
  {
    actionId: 'move_up',
    context: ActionContextTypes.NORMAL_MODE,
    binding: {keys: ['ArrowUp', 'h']},
    source: SOURCE,
  },
  {
    actionId: 'move_left',
    context: ActionContextTypes.NORMAL_MODE,
    binding: {keys: ['ArrowLeft', 'j']},
    source: SOURCE,
  },
  {
    actionId: 'move_right',
    context: ActionContextTypes.NORMAL_MODE,
    binding: {keys: ['ArrowRight', 'l']},
    source: SOURCE,
  },
  {
    actionId: 'extend_selection_up',
    context: ActionContextTypes.NORMAL_MODE,
    binding: {keys: ['Shift+ArrowUp', 'Shift+h']},
    source: SOURCE,
  },
  {
    actionId: 'extend_selection_down',
    context: ActionContextTypes.NORMAL_MODE,
    binding: {keys: ['Shift+ArrowDown', 'Shift+k']},
    source: SOURCE,
  },
  {
    actionId: 'multi_select.extend_selection_up',
    context: ActionContextTypes.MULTI_SELECT_MODE,
    binding: {keys: ['ArrowUp', 'h', 'Shift+h', 'Shift+ArrowUp']},
    source: SOURCE,
  },
  {
    actionId: 'multi_select.extend_selection_down',
    context: ActionContextTypes.MULTI_SELECT_MODE,
    binding: {keys: ['ArrowDown', 'k', 'Shift+k', 'Shift+ArrowDown']},
    source: SOURCE,
  },
  {
    actionId: 'normal.move_block_up',
    context: ActionContextTypes.NORMAL_MODE,
    binding: {keys: ['$mod+Shift+ArrowUp', '$mod+Shift+h']},
    source: SOURCE,
  },
  {
    actionId: 'normal.move_block_down',
    context: ActionContextTypes.NORMAL_MODE,
    binding: {keys: ['$mod+Shift+ArrowDown', '$mod+Shift+k']},
    source: SOURCE,
  },
  {
    actionId: 'move_block_up_cm',
    context: ActionContextTypes.EDIT_MODE_CM,
    binding: {keys: ['$mod+Shift+ArrowUp', '$mod+Shift+h']},
    source: SOURCE,
  },
  {
    actionId: 'move_block_down_cm',
    context: ActionContextTypes.EDIT_MODE_CM,
    binding: {keys: ['$mod+Shift+ArrowDown', '$mod+Shift+k']},
    source: SOURCE,
  },
  {
    actionId: 'multi_select.move_block_up',
    context: ActionContextTypes.MULTI_SELECT_MODE,
    binding: {keys: ['$mod+Shift+ArrowUp', '$mod+Shift+h']},
    source: SOURCE,
  },
  {
    actionId: 'multi_select.move_block_down',
    context: ActionContextTypes.MULTI_SELECT_MODE,
    binding: {keys: ['$mod+Shift+ArrowDown', '$mod+Shift+k']},
    source: SOURCE,
  },
  {
    actionId: DATE_SCRUB_DAY_FORWARD_ACTION_ID,
    context: DATE_SCRUB_CONTEXT,
    binding: {keys: ['ArrowUp', 'h']},
    source: SOURCE,
  },
  {
    actionId: DATE_SCRUB_DAY_BACKWARD_ACTION_ID,
    context: DATE_SCRUB_CONTEXT,
    binding: {keys: ['ArrowDown', 'k']},
    source: SOURCE,
  },
  {
    actionId: DATE_SCRUB_WEEK_FORWARD_ACTION_ID,
    context: DATE_SCRUB_CONTEXT,
    binding: {keys: ['ArrowRight', 'l']},
    source: SOURCE,
  },
  {
    actionId: DATE_SCRUB_WEEK_BACKWARD_ACTION_ID,
    context: DATE_SCRUB_CONTEXT,
    binding: {keys: ['ArrowLeft', 'j']},
    source: SOURCE,
  },
]

export const colemakKeybindingsPlugin: AppExtension = systemToggle({
  id: COLEMAK_KEYBINDINGS_PLUGIN_ID,
  name: 'Colemak movement keybindings',
  description: 'Uses Colemak-friendly movement keys for Vim-style navigation, selection, block moves, and date scrub.',
  defaultEnabled: false,
}).of(
  colemakMovementKeybindingOverrides.map(override =>
    keybindingOverridesFacet.of(override, {source: SOURCE}),
  ),
)

export default colemakKeybindingsPlugin
