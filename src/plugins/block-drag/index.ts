/**
 * block-drag plugin — drag a block by its bullet to move it. Dragging a
 * bullet that is part of the multi-selection drags the whole selection.
 * The drop is one `moveBlocksTo` call from move-blocks: one transaction,
 * one undo entry.
 *
 * Composition:
 *   - `projection.ts`      — pure: which gap the pointer is in, which depth it means
 *   - `dropTarget.ts`      — rendered rows → projection → move target + drop line
 *   - `dragController.ts`  — the drag session: start, hover, auto-scroll, drop
 *   - `BlockDragLayer.tsx` — app mount: installs the controller, draws the line
 *
 * v1: mouse only; drops land only in a panel's own outline (no embeds,
 * backlink entries or other nested surfaces); same workspace only, which
 * `core.move` enforces.
 */
import { appMountsFacet } from '@/extensions/core.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { BlockDragLayer } from './BlockDragLayer.tsx'

export const blockDragPlugin: AppExtension = systemToggle({
  id: 'system:block-drag',
  name: 'Drag and drop blocks',
  description: 'Drag a block by its bullet to move it (the whole selection when the bullet is in it).',
}).of([
  appMountsFacet.of({id: 'block-drag.layer', component: BlockDragLayer}, {source: 'block-drag'}),
])
