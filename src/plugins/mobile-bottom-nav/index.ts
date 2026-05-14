import { appMountsFacet, type AppMountContribution } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { MobileBottomNav } from './MobileBottomNav.tsx'
import { mobileBottomNavItemsFacet } from './facet.ts'
import {
  appendTodayDailyBlockBottomNavItem,
  commandPaletteBottomNavItem,
  newNodeBottomNavItem,
  openSidebarBottomNavItem,
  searchBottomNavItem,
  todayBottomNavItem,
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
} from './defaultItems.ts'

export const mobileBottomNavMount: AppMountContribution = {
  id: 'mobile-bottom-nav.mount',
  component: MobileBottomNav,
}

export const mobileBottomNavPlugin: AppExtension = [
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
  mobileBottomNavItemsFacet.of(commandPaletteBottomNavItem, {
    source: 'mobile-bottom-nav',
    precedence: 0,
  }),
]
