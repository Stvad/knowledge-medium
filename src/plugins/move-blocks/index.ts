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
 *   - `pasteAsMoveImpl.ts`        — fills core's `pasteAsMoveVerb` seam, so a
 *     cut→paste (`@/shortcuts/defaultShortcuts.js`) completes as a real move
 *     instead of a text paste when the plugin is installed
 *   - `pendingMoveStyling.tsx`    — dims a block while its cut is pending
 */
import { actionsFacet } from '@/extensions/core.js'
import { blockContextMenuItemsFacet, blockShellDecoratorsFacet } from '@/extensions/blockInteraction.js'
import type { AppExtension } from '@/facets/facet.js'
import { dialogAppMountExtension } from '@/extensions/dialogAppMount.js'
import { systemToggle } from '@/facets/togglable.js'
import { pasteAsMoveVerb } from '@/paste/moveOnPasteVerb.js'
import { moveBlockAction, moveBlocksAction } from './moveAction.ts'
import { moveBlocksContextMenuItem } from './contextMenuItem.ts'
import { pasteAsMoveImpl } from './pasteAsMoveImpl.ts'
import { pendingMoveStyling } from './pendingMoveStyling.tsx'

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
  // The primary entry point, not a convenience: the global ⌘K palette
  // lists only Global commands (it doesn't focus the block the way
  // `commandPaletteForBlockAction` does), so without this the move
  // command has no dependable way to be invoked.
  blockContextMenuItemsFacet.of(moveBlocksContextMenuItem, {source: 'move-blocks'}),
  // Fills core's cut→paste seam (`@/paste/moveOnPasteVerb.js`) so a paste
  // that finds a still-valid pending cut relocates the original blocks
  // (preserving ids/refs) instead of falling back to a text paste. With
  // this plugin off, cut still marks the register (core does that
  // unconditionally) but every paste degrades to an ordinary text paste —
  // no data loss, just no move.
  pasteAsMoveVerb.impl(pasteAsMoveImpl, {source: 'move-blocks'}),
  // A decorator, not a class facet: only a component can SUBSCRIBE to the
  // register, and this mark is the sole feedback a (non-deleting) cut gives.
  blockShellDecoratorsFacet.of(pendingMoveStyling, {source: 'move-blocks'}),
])
