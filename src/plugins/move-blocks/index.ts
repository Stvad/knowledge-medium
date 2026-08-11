/**
 * move-blocks plugin — adds a "Move block(s) to…" command-palette
 * action, for both a single focused block and the current
 * multi-selection. The action opens a picker (structurally a clone of
 * merge-blocks' `MergePicker`) that searches link targets in the
 * current workspace; on selection, `moveBlocksTo` relocates every
 * chosen block to the picked destination as one undo-grouped batch.
 *
 * Composition:
 *   - `moveBlocks.ts`             — core: pruning + grouped `core.move` calls
 *   - `MoveDestinationPicker.tsx` — modal opened on demand via `openDialog`
 *   - `moveAction.ts`             — block/multi-select actions that open the picker
 */
import { actionsFacet } from '@/extensions/core.js'
import type { AppExtension } from '@/facets/facet.js'
import { dialogAppMountExtension } from '@/extensions/dialogAppMount.js'
import { systemToggle } from '@/facets/togglable.js'
import { moveBlockAction, moveBlocksAction } from './moveAction.ts'

export {
  MOVE_BLOCKS_ACTION_ID,
  MULTI_SELECT_MOVE_BLOCKS_ACTION_ID,
  moveBlockAction,
  moveBlocksAction,
} from './moveAction.ts'
export { moveBlocksTo, type MoveBlocksResult } from './moveBlocks.ts'
export {
  MoveDestinationPicker,
  type MoveDestinationPickerProps,
  type MoveDestinationPickerResult,
} from './MoveDestinationPicker.tsx'

export const moveBlocksPlugin: AppExtension = systemToggle({
  id: 'system:move-blocks',
  name: 'Move blocks',
  description: '"Move block(s) to…" command-palette action.',
}).of([
  // `moveAction` opens MoveDestinationPicker via `openDialog`, which is
  // inert without DialogHost mounted; pull it in (deduped by reference).
  dialogAppMountExtension,
  actionsFacet.of(moveBlockAction, {source: 'move-blocks'}),
  actionsFacet.of(moveBlocksAction, {source: 'move-blocks'}),
])
