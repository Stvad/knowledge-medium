import { appMountsFacet, type AppMountContribution } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { withSystemExtensionMetadata } from '@/extensions/togglable.ts'
import { MobileBottomNav } from './MobileBottomNav.tsx'
import { mobileBottomNavItemsFacet } from './facet.ts'
import {
  appendTodayDailyBlockBottomNavItem,
  commandPaletteBottomNavItem,
  newNodeBottomNavItem,
  openSidebarBottomNavItem,
  searchBottomNavItem,
  todayBottomNavItem,
  undoBottomNavItem,
} from './defaultItems.ts'

export { MobileBottomNav } from './MobileBottomNav.tsx'
export { MobileBottomNavButton, type MobileBottomNavIcon } from './Button.tsx'
export {
  mobileBottomNavItemsFacet,
  type MobileBottomNavItemContribution,
} from './facet.ts'
export {
  appendTodayDailyBlockBottomNavItem,
  commandPaletteBottomNavItem,
  newNodeBottomNavItem,
  openSidebarBottomNavItem,
  searchBottomNavItem,
  todayBottomNavItem,
  undoBottomNavItem,
} from './defaultItems.ts'

export const mobileBottomNavMount: AppMountContribution = {
  id: 'mobile-bottom-nav.mount',
  component: MobileBottomNav,
}

export const mobileBottomNavPlugin: AppExtension = withSystemExtensionMetadata({
  name: 'Mobile bottom nav',
  description: 'Bottom navigation bar shown on mobile viewports.',
}, [
  appMountsFacet.of(mobileBottomNavMount, {source: 'mobile-bottom-nav'}),
  mobileBottomNavItemsFacet.of(openSidebarBottomNavItem, {
    source: 'mobile-bottom-nav',
    precedence: -40,
  }),
  mobileBottomNavItemsFacet.of(newNodeBottomNavItem, {
    source: 'mobile-bottom-nav',
    precedence: -30,
  }),
  mobileBottomNavItemsFacet.of(appendTodayDailyBlockBottomNavItem, {
    source: 'mobile-bottom-nav',
    precedence: -25,
  }),
  mobileBottomNavItemsFacet.of(todayBottomNavItem, {
    source: 'mobile-bottom-nav',
    precedence: -20,
  }),
  mobileBottomNavItemsFacet.of(searchBottomNavItem, {
    source: 'mobile-bottom-nav',
    precedence: -10,
  }),
  mobileBottomNavItemsFacet.of(undoBottomNavItem, {
    source: 'mobile-bottom-nav',
    precedence: -5,
  }),
  mobileBottomNavItemsFacet.of(commandPaletteBottomNavItem, {
    source: 'mobile-bottom-nav',
    precedence: 0,
  }),
])
