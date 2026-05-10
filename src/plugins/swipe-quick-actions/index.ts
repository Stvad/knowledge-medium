import {
  appMountsFacet,
  type AppMountContribution,
} from '@/extensions/core.ts'
import {
  blockContentSurfacePropsFacet,
} from '@/extensions/blockInteraction.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { SwipeActionMenu } from './SwipeActionMenu.tsx'
import { swipeQuickActionsContentSurface } from './swipeGesture.ts'

export { SwipeActionMenu } from './SwipeActionMenu.tsx'

const swipeActionMenuMount: AppMountContribution = {
  id: 'swipe-quick-actions.menu',
  component: SwipeActionMenu,
}

export const swipeQuickActionsPlugin: AppExtension = [
  blockContentSurfacePropsFacet.of(swipeQuickActionsContentSurface, {
    source: 'swipe-quick-actions',
  }),
  appMountsFacet.of(swipeActionMenuMount, {source: 'swipe-quick-actions'}),
]
