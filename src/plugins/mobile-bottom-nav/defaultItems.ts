import type { MobileBottomNavItemContribution } from './facet.ts'
import { COMMAND_PALETTE_ACTION_ID } from '@/plugins/command-palette'
import {
  APPEND_TODAY_DAILY_BLOCK_ACTION_ID,
  OPEN_TODAY_ACTION_ID,
} from '@/plugins/daily-notes'
import {
  OPEN_LEFT_SIDEBAR_ACTION_ID,
} from '@/plugins/left-sidebar'
import { QUICK_FIND_ACTION_ID } from '@/plugins/quick-find'
import { CREATE_NODE_IN_ACTIVE_PANEL_ACTION_ID } from '@/shortcuts/defaultShortcuts.ts'

export const openSidebarBottomNavItem: MobileBottomNavItemContribution = {
  id: 'mobile-bottom-nav.open-sidebar',
  actionId: OPEN_LEFT_SIDEBAR_ACTION_ID,
}

export const newNodeBottomNavItem: MobileBottomNavItemContribution = {
  id: 'mobile-bottom-nav.new-node',
  actionId: CREATE_NODE_IN_ACTIVE_PANEL_ACTION_ID,
}

export const appendTodayDailyBlockBottomNavItem: MobileBottomNavItemContribution = {
  id: 'mobile-bottom-nav.append-today-daily-block',
  actionId: APPEND_TODAY_DAILY_BLOCK_ACTION_ID,
}

export const todayBottomNavItem: MobileBottomNavItemContribution = {
  id: 'mobile-bottom-nav.today',
  actionId: OPEN_TODAY_ACTION_ID,
}

export const searchBottomNavItem: MobileBottomNavItemContribution = {
  id: 'mobile-bottom-nav.search',
  actionId: QUICK_FIND_ACTION_ID,
}

export const commandPaletteBottomNavItem: MobileBottomNavItemContribution = {
  id: 'mobile-bottom-nav.command-palette',
  actionId: COMMAND_PALETTE_ACTION_ID,
}
