import {
  blockContentSurfacePropsFacet,
  blockHeaderFacet,
} from '@/extensions/blockInteraction.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { SwipeActionMenu } from './SwipeActionMenu.tsx'
import { swipeQuickActionsContentSurface } from './swipeGesture.ts'

export { SwipeActionMenu } from './SwipeActionMenu.tsx'
export { swipeActiveBlockIdProp } from './property.ts'

export const swipeQuickActionsPlugin: AppExtension = [
  blockContentSurfacePropsFacet.of(swipeQuickActionsContentSurface, {
    source: 'swipe-quick-actions',
  }),
  // Mount the menu once per panel via the top-level block's header,
  // mirroring the breadcrumbs pattern in defaultRenderers. Per-panel
  // mounting means each panel inherits its own UI-state block via
  // BlockContext, so the menu's swipe-active state is naturally
  // panel-scoped. Self-gates on isTopLevel to keep non-top-level
  // contributions free.
  blockHeaderFacet.of(
    ctx => ctx.isTopLevel ? SwipeActionMenu : null,
    {source: 'swipe-quick-actions'},
  ),
]
