import { Menu } from 'lucide-react'
import {
  ActionConfig,
  ActionContextTypes,
} from '@/shortcuts/types.js'
import { leftSidebarToggle } from './toggleStore.ts'

export const OPEN_LEFT_SIDEBAR_ACTION_ID = 'open_left_sidebar'

export const openLeftSidebarAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: OPEN_LEFT_SIDEBAR_ACTION_ID,
  description: 'Open sidebar',
  context: ActionContextTypes.GLOBAL,
  icon: Menu,
  handler: () => {
    leftSidebarToggle.open()
  },
}

export const leftSidebarActions: readonly ActionConfig<typeof ActionContextTypes.GLOBAL>[] = [
  openLeftSidebarAction,
]
