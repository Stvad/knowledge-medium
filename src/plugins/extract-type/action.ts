/** NORMAL_MODE actions wired around the typeExtraction primitives:
 *
 *   - `extractTypeAction` — opens the full extract-type dialog
 *     (name → property subset → confirm candidates → create + retag).
 *   - `findSimilarAction` — opens the find-similar dialog (property
 *     subset → navigable result list, no type creation).
 *
 *  Same shape as `rescheduleBlockDateAction`: each handler dispatches
 *  a window CustomEvent the globally-mounted dialog listens for. */

import { Sparkles, Telescope } from 'lucide-react'
import {
  ActionContextTypes,
  type ActionConfig,
  type BlockShortcutDependencies,
} from '@/shortcuts/types.ts'
import {
  openExtractTypeDialog,
  openFindSimilarDialog,
} from './events.ts'

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

export const FIND_SIMILAR_ACTION_ID = 'block.find_similar'

export const findSimilarAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: FIND_SIMILAR_ACTION_ID,
  description: 'Find blocks with similar properties',
  context: ActionContextTypes.NORMAL_MODE,
  icon: Telescope,
  handler: ({block}: BlockShortcutDependencies) => {
    openFindSimilarDialog({prototypeBlockId: block.id})
  },
}
