import {
  panelMountsFacet,
  actionsFacet,
  type PanelMountContribution,
} from '@/extensions/core.js'
import { continuousGestureRecognizersFacet } from '@/extensions/continuousGestures.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { SwipeActionMenu } from './SwipeActionMenu.tsx'
import {
  DEFAULT_QUICK_ACTION_ITEMS,
  quickActionItemsFacet,
} from './actions.ts'
import { swipeRecognizer } from './swipeRecognizer.ts'
import { swipeGestureActions } from './gestureActions.ts'

export { SwipeActionMenu } from './SwipeActionMenu.tsx'
export {
  quickActionItemsFacet,
  SWIPE_RIGHT_BLOCK_ACTION_ID,
  type QuickActionItem,
} from './actions.ts'
export { SWIPE_QUICK_ACTIONS_GESTURE_ID } from './swipeRecognizer.ts'

const swipeActionMenuPanelMount: PanelMountContribution = {
  id: 'swipe-quick-actions.panel-menu',
  component: SwipeActionMenu,
}

export const swipeQuickActionsPlugin: AppExtension = systemToggle({
  id: 'system:swipe-quick-actions',
  name: 'Swipe quick actions',
  description: 'Swipe gesture on a block to reveal a quick-action menu.',
}).of([
  // Recognition rides the core continuous-gesture loop (arbitration + the
  // touch-action / pointer-listener seam live there); the recognizer emits
  // named gestures and these actions are what they do — see swipeRecognizer.ts /
  // gestureActions.ts. swipe-right's behavior is the todo cycle action, bound by
  // gesture in that plugin.
  continuousGestureRecognizersFacet.of(swipeRecognizer, {source: 'swipe-quick-actions'}),
  swipeGestureActions.map(action => actionsFacet.of(action, {source: 'swipe-quick-actions'})),
  DEFAULT_QUICK_ACTION_ITEMS.map(item =>
    quickActionItemsFacet.of(item, {source: 'swipe-quick-actions'}),
  ),
  // Per-panel mount: each panel gets its own SwipeActionMenu instance,
  // inheriting the panel's UI-state block via React context. The menu's
  // active-block prop is panel-scoped, and its DOM lookups stay inside
  // the panel root — both naturally fall out of the mount being inside
  // `.panel`.
  panelMountsFacet.of(swipeActionMenuPanelMount, {source: 'swipe-quick-actions'}),
])
