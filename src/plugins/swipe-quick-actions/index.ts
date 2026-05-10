import {
  panelMountsFacet,
  type PanelMountContribution,
} from '@/extensions/core.ts'
import {
  blockContentSurfacePropsFacet,
} from '@/extensions/blockInteraction.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { SwipeActionMenu } from './SwipeActionMenu.tsx'
import {
  DEFAULT_QUICK_ACTION_ITEMS,
  quickActionItemsFacet,
} from './actions.ts'
import { swipeQuickActionsContentSurface } from './swipeGesture.ts'

export { SwipeActionMenu } from './SwipeActionMenu.tsx'
export {
  quickActionItemsFacet,
  type QuickActionItem,
} from './actions.ts'

const swipeActionMenuPanelMount: PanelMountContribution = {
  id: 'swipe-quick-actions.panel-menu',
  component: SwipeActionMenu,
}

export const swipeQuickActionsPlugin: AppExtension = [
  blockContentSurfacePropsFacet.of(swipeQuickActionsContentSurface, {
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
]
