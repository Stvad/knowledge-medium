/** NORMAL_MODE actions wired around the typeExtraction primitives:
 *
 *   - `extractTypeAction` — opens the extract-type dialog: name +
 *     property subset → create the type, then delegate to
 *     `findTypeInstancesAction` on the new type to find candidates
 *     to retag.
 *   - `findTypeInstancesAction` — "Find block candidates for this
 *     type." Opens the find-blocks-to-retag dialog: pick a subset of
 *     the type's properties (optionally with value filters) and retag
 *     matching blocks. Only surfaces on block-type blocks.
 *
 *  Each handler opens its dialog through the promise-returning
 *  `openDialog` queue. `extractType` chains: it awaits the new type id
 *  from `ExtractTypeDialog`, then opens `FindTypeInstancesDialog` on
 *  it. */

import { Sparkles, Users } from 'lucide-react'
import {
  ActionContextTypes,
  type ActionConfig,
  type BlockShortcutDependencies,
} from '@/shortcuts/types.js'
import { BLOCK_TYPE_TYPE } from '@/data/blockTypes'
import { getBlockTypes } from '@/data/properties'
import { openDialog } from '@/utils/dialogs.js'
import { ExtractTypeDialog } from './ExtractTypeDialog.tsx'
import { FindTypeInstancesDialog } from './FindTypeInstancesDialog.tsx'

export const EXTRACT_TYPE_ACTION_ID = 'block.extract_type'

export const extractTypeAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: EXTRACT_TYPE_ACTION_ID,
  description: 'Extract type from this block',
  context: ActionContextTypes.NORMAL_MODE,
  icon: Sparkles,
  handler: async ({block}: BlockShortcutDependencies) => {
    const created = await openDialog(ExtractTypeDialog, {prototypeBlockId: block.id})
    if (!created) return
    await openDialog(FindTypeInstancesDialog, {typeBlockId: created.typeBlockId})
  },
}

export const FIND_TYPE_INSTANCES_ACTION_ID = 'block.find_type_instances'

export const findTypeInstancesAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: FIND_TYPE_INSTANCES_ACTION_ID,
  description: 'Find block candidates for this type',
  context: ActionContextTypes.NORMAL_MODE,
  icon: Users,
  // Only meaningful on a block-type block. Surfaces (command palette,
  // swipe menu) hide the entry when isVisible is false.
  isVisible: ({block}) => {
    const data = block.peek()
    return !!data && getBlockTypes(data).includes(BLOCK_TYPE_TYPE)
  },
  handler: ({block}: BlockShortcutDependencies) => {
    void openDialog(FindTypeInstancesDialog, {typeBlockId: block.id})
  },
}
