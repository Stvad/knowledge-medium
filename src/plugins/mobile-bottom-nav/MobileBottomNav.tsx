import { useCallback, type ComponentType, type SVGProps } from 'react'
import {
  CalendarDays,
  Command,
  Menu,
  Plus,
  Search,
} from 'lucide-react'
import { useRepo } from '@/context/repo.tsx'
import { useIsMobile } from '@/utils/react.tsx'
import { getOrCreateDailyNote, todayIso } from '@/data/dailyNotes.ts'
import { navigateFromGlobalCommand } from '@/utils/navigation.ts'
import { toggleQuickFindEvent } from '@/plugins/quick-find/events.ts'
import { toggleCommandPaletteEvent } from '@/plugins/command-palette/events.ts'
import { openLeftSidebar } from '@/plugins/left-sidebar/events.ts'
import {
  createNodeInActivePanel,
  useActivePanelNodeTarget,
} from '@/plugins/left-sidebar/panelTarget.tsx'
import { useActiveContextsState } from '@/shortcuts/ActiveContexts.tsx'
import { ActionContextTypes } from '@/shortcuts/types.ts'

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>

function BottomNavButton({
  label,
  icon: Icon,
  onClick,
  disabled = false,
}: {
  label: string
  icon: IconComponent
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className="flex h-14 flex-1 items-center justify-center rounded-md text-muted-foreground transition-colors active:bg-accent active:text-foreground disabled:pointer-events-none disabled:opacity-35"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      <Icon className="h-7 w-7 stroke-[1.6]"/>
    </button>
  )
}

function MobileBottomNavSurface() {
  const repo = useRepo()
  const activePanelTarget = useActivePanelNodeTarget()

  const openSearch = useCallback(() => {
    window.dispatchEvent(new CustomEvent(toggleQuickFindEvent))
  }, [])
  const openCommandPalette = useCallback(() => {
    window.dispatchEvent(new CustomEvent(toggleCommandPaletteEvent))
  }, [])
  const openToday = useCallback(async () => {
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    const note = await getOrCreateDailyNote(repo, workspaceId, todayIso())
    navigateFromGlobalCommand(repo, {blockId: note.id, workspaceId})
  }, [repo])
  const createNode = useCallback(async () => {
    await createNodeInActivePanel({repo, ...activePanelTarget})
  }, [activePanelTarget, repo])

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 px-2 backdrop-blur supports-[backdrop-filter]:bg-background/85 md:hidden"
      style={{paddingBottom: 'env(safe-area-inset-bottom)'}}
      aria-label="Mobile navigation"
      data-block-interaction="ignore"
    >
      <div className="mx-auto flex h-16 max-w-md items-center justify-around">
        <BottomNavButton
          label="Open sidebar"
          icon={Menu}
          onClick={openLeftSidebar}
        />
        <BottomNavButton
          label="New node"
          icon={Plus}
          onClick={() => { void createNode() }}
          disabled={!activePanelTarget.canCreateNode}
        />
        <BottomNavButton
          label="Today"
          icon={CalendarDays}
          onClick={() => { void openToday() }}
        />
        <BottomNavButton
          label="Search"
          icon={Search}
          onClick={openSearch}
        />
        <BottomNavButton
          label="Command palette"
          icon={Command}
          onClick={openCommandPalette}
        />
      </div>
    </nav>
  )
}

export function MobileBottomNav() {
  const isMobile = useIsMobile()
  const activeContexts = useActiveContextsState()
  const isEditing =
    activeContexts.has(ActionContextTypes.EDIT_MODE_CM) ||
    activeContexts.has(ActionContextTypes.PROPERTY_EDITING)

  if (!isMobile || isEditing) return null

  return <MobileBottomNavSurface/>
}
