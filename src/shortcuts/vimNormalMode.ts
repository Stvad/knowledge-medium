import { isActionConfig } from '@/extensions/core.ts'
import { defineFacet } from '@/extensions/facet.ts'
import { ActionConfig, ActionContextTypes } from '@/shortcuts/types.ts'

export type VimNormalModeAction = ActionConfig<typeof ActionContextTypes.NORMAL_MODE>

export const isVimNormalModeAction = (value: unknown): value is VimNormalModeAction =>
  isActionConfig(value) && value.context === ActionContextTypes.NORMAL_MODE

export const vimNormalModeActionsFacet = defineFacet<VimNormalModeAction, readonly VimNormalModeAction[]>({
  id: 'shortcuts.vim-normal-mode.actions',
  validate: isVimNormalModeAction,
})
