/**
 * touch-selection plugin — multi-select by touch. Hold a block's content to
 * select it; while blocks are selected, a tap adds or removes one, and a
 * bottom toolbar moves the selection (outdent, indent, up, down, Move to…,
 * undo, done). The selection is the one multi-select mode already runs on,
 * so the toolbar's buttons are its existing actions, and holding a selected
 * block's bullet drags the whole selection (block-drag).
 *
 * Composition:
 *   - `holdRecognizer.ts`        — the content-surface hold, emits `block-hold`
 *   - `actions.ts`               — hold selects, tap toggles while selecting
 *   - `facet.ts` / `defaultItems.ts` — the toolbar's buttons
 *   - `TouchSelectionLayer.tsx`  — app mount: read-mode hold styles + the toolbar
 */
import { actionsFacet, appMountsFacet } from '@/extensions/core.js'
import { continuousGestureRecognizersFacet } from '@/extensions/continuousGestures.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { selectHeldBlockAction, toggleTappedBlockAction } from './actions.ts'
import { defaultToolbarItems } from './defaultItems.ts'
import { touchSelectionToolbarItemsFacet } from './facet.ts'
import { blockHoldRecognizer } from './holdRecognizer.ts'
import { TouchSelectionLayer } from './TouchSelectionLayer.tsx'

export { BLOCK_HOLD_GESTURE } from './holdRecognizer.ts'
export { touchSelectionToolbarItemsFacet, type TouchSelectionToolbarItem } from './facet.ts'

export const touchSelectionPlugin: AppExtension = systemToggle({
  id: 'system:touch-selection',
  name: 'Touch selection',
  description: 'Hold a block to select it, tap to add or remove blocks, and move the selection from a bottom toolbar. Touch devices only.',
}).of([
  continuousGestureRecognizersFacet.of(blockHoldRecognizer, {source: 'touch-selection'}),
  actionsFacet.of(selectHeldBlockAction, {source: 'touch-selection'}),
  // Ahead of every other touch-tap action (vim's tap-to-edit) in the
  // block-pointer context, which tie on context rank: while selecting, a
  // tap toggles instead of editing.
  actionsFacet.of(toggleTappedBlockAction, {source: 'touch-selection', precedence: -100}),
  defaultToolbarItems.map(({item, precedence}) =>
    touchSelectionToolbarItemsFacet.of(item, {source: 'touch-selection', precedence}),
  ),
  appMountsFacet.of({id: 'touch-selection.layer', component: TouchSelectionLayer}, {source: 'touch-selection'}),
])
