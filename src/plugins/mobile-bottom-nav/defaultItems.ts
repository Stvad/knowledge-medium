import type { MobileBottomNavItemContribution } from './facet.ts'
import {
  AppendTodayDailyBlockBottomNavItem,
  CommandPaletteBottomNavItem,
  NewNodeBottomNavItem,
  OpenSidebarBottomNavItem,
  SearchBottomNavItem,
  TodayBottomNavItem,
} from './DefaultItems.tsx'

export const openSidebarBottomNavItem: MobileBottomNavItemContribution = {
  id: 'mobile-bottom-nav.open-sidebar',
  component: OpenSidebarBottomNavItem,
}

export const newNodeBottomNavItem: MobileBottomNavItemContribution = {
  id: 'mobile-bottom-nav.new-node',
  component: NewNodeBottomNavItem,
}

export const appendTodayDailyBlockBottomNavItem: MobileBottomNavItemContribution = {
  id: 'mobile-bottom-nav.append-today-daily-block',
  component: AppendTodayDailyBlockBottomNavItem,
}

export const todayBottomNavItem: MobileBottomNavItemContribution = {
  id: 'mobile-bottom-nav.today',
  component: TodayBottomNavItem,
}

export const searchBottomNavItem: MobileBottomNavItemContribution = {
  id: 'mobile-bottom-nav.search',
  component: SearchBottomNavItem,
}

export const commandPaletteBottomNavItem: MobileBottomNavItemContribution = {
  id: 'mobile-bottom-nav.command-palette',
  component: CommandPaletteBottomNavItem,
}
