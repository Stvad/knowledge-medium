import { useCallback } from 'react'
import {
  CalendarDays,
  CalendarPlus,
  Command,
  Menu,
  Plus,
  Search,
} from 'lucide-react'
import { useRepo } from '@/context/repo.tsx'
import { getOrCreateDailyNote, todayIso } from '@/plugins/daily-notes'
import { navigateFromGlobalCommand } from '@/utils/navigation.ts'
import { toggleQuickFindEvent } from '@/plugins/quick-find/events.ts'
import { toggleCommandPaletteEvent } from '@/plugins/command-palette/events.ts'
import { openLeftSidebar } from '@/plugins/left-sidebar/events.ts'
import { useActiveContextsState } from '@/shortcuts/ActiveContexts.tsx'
import { useRunAction } from '@/shortcuts/runAction.ts'
import { ActionContextTypes } from '@/shortcuts/types.ts'
import {
  createNodeInActivePanel,
  useActivePanelNodeTarget,
} from '@/plugins/left-sidebar/panelTarget.tsx'
import { MobileBottomNavButton } from './Button.tsx'

export function OpenSidebarBottomNavItem() {
  return (
    <MobileBottomNavButton
      label="Open sidebar"
      icon={Menu}
      onClick={openLeftSidebar}
    />
  )
}

export function NewNodeBottomNavItem() {
  const repo = useRepo()
  const activePanelTarget = useActivePanelNodeTarget()

  const createNode = useCallback(async () => {
    await createNodeInActivePanel({repo, ...activePanelTarget})
  }, [activePanelTarget, repo])

  return (
    <MobileBottomNavButton
      label="New node"
      icon={Plus}
      onClick={() => { void createNode() }}
      disabled={!activePanelTarget.canCreateNode}
    />
  )
}

export function AppendTodayDailyBlockBottomNavItem() {
  const repo = useRepo()
  const runAction = useRunAction()
  const activeContexts = useActiveContextsState()
  const hasGlobalContext = activeContexts.has(ActionContextTypes.GLOBAL)

  const appendTodayDailyBlock = useCallback(() => {
    void runAction(
      'append_today_daily_block',
      new CustomEvent('mobile-bottom-nav.append-today-daily-block'),
    )
  }, [runAction])

  return (
    <MobileBottomNavButton
      label="New daily block"
      icon={CalendarPlus}
      onClick={appendTodayDailyBlock}
      disabled={!hasGlobalContext || !repo.activeWorkspaceId || repo.isReadOnly}
    />
  )
}

export function TodayBottomNavItem() {
  const repo = useRepo()

  const openToday = useCallback(async () => {
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    const note = await getOrCreateDailyNote(repo, workspaceId, todayIso())
    navigateFromGlobalCommand(repo, {blockId: note.id, workspaceId})
  }, [repo])

  return (
    <MobileBottomNavButton
      label="Today"
      icon={CalendarDays}
      onClick={() => { void openToday() }}
    />
  )
}

export function SearchBottomNavItem() {
  const openSearch = useCallback(() => {
    window.dispatchEvent(new CustomEvent(toggleQuickFindEvent))
  }, [])

  return (
    <MobileBottomNavButton
      label="Search"
      icon={Search}
      onClick={openSearch}
    />
  )
}

export function CommandPaletteBottomNavItem() {
  const openCommandPalette = useCallback(() => {
    window.dispatchEvent(new CustomEvent(toggleCommandPaletteEvent))
  }, [])

  return (
    <MobileBottomNavButton
      label="Command palette"
      icon={Command}
      onClick={openCommandPalette}
    />
  )
}
