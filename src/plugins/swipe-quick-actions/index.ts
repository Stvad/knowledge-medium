import {
  panelMountsFacet,
  type PanelMountContribution,
} from '@/extensions/core.js'
import {
  blockContentSurfacePropsFacet,
} from '@/extensions/blockInteraction.js'
import {
  blockGestureConflictsFacet,
  type BlockGestureConflictContribution,
} from '@/extensions/blockGestureConflicts.js'
import type { AppExtension } from '@/extensions/facet.js'
import { systemToggle } from '@/extensions/togglable.js'
import { SwipeActionMenu } from './SwipeActionMenu.tsx'
import {
  DEFAULT_QUICK_ACTION_ITEMS,
  quickActionItemsFacet,
} from './actions.ts'
import {
  cancelSwipeCandidate,
  swipeQuickActionsContentSurface,
  SWIPE_QUICK_ACTIONS_GESTURE_ID,
} from './swipeGesture.ts'

export { SwipeActionMenu } from './SwipeActionMenu.tsx'
export {
  quickActionItemsFacet,
  SWIPE_RIGHT_BLOCK_ACTION_ID,
  type QuickActionItem,
} from './actions.ts'
export {
  cancelSwipeCandidate,
  SWIPE_QUICK_ACTIONS_GESTURE_ID,
} from './swipeGesture.ts'

const swipeGestureConflictContribution: BlockGestureConflictContribution = {
  id: SWIPE_QUICK_ACTIONS_GESTURE_ID,
  onCancel: cancelSwipeCandidate,
}

const swipeActionMenuPanelMount: PanelMountContribution = {
  id: 'swipe-quick-actions.panel-menu',
  component: SwipeActionMenu,
}

export const swipeQuickActionsPlugin: AppExtension = systemToggle({
  id: 'system:swipe-quick-actions',
  name: 'Swipe quick actions',
  description: 'Swipe gesture on a block to reveal a quick-action menu.',
}).of([
  blockContentSurfacePropsFacet.of(swipeQuickActionsContentSurface, {
    source: 'swipe-quick-actions',
  }),
  blockGestureConflictsFacet.of(swipeGestureConflictContribution, {
    source: 'swipe-quick-actions',
  }),
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
