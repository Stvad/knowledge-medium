/** NORMAL_MODE action that opens the extract-type dialog on the
 *  focused block. Same shape as `rescheduleBlockDateAction` — the
 *  handler dispatches a window CustomEvent that the globally-
 *  mounted `ExtractTypeDialog` listens for. */

import { Sparkles } from 'lucide-react'
import {
  ActionContextTypes,
  type ActionConfig,
  type BlockShortcutDependencies,
} from '@/shortcuts/types.ts'
import { openExtractTypeDialog } from './events.ts'

export const EXTRACT_TYPE_ACTION_ID = 'block.extract_type'

export const extractTypeAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: EXTRACT_TYPE_ACTION_ID,
  description: 'Extract type from this block',
  context: ActionContextTypes.NORMAL_MODE,
  icon: Sparkles,
  handler: ({block}: BlockShortcutDependencies) => {
    openExtractTypeDialog({prototypeBlockId: block.id})
  },
}
