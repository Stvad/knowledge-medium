import {
  useCallback,
  useMemo,
  useState,
  type ComponentType,
  type SVGProps,
} from 'react'
import {
  ArrowLeft,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Command,
  Home,
  Menu,
  Plus,
  Search,
} from 'lucide-react'
import type { BlockData } from '@/data/api'
import { PAGE_TYPE } from '@/data/blockTypes.ts'
import {
  aliasesProp,
  activePanelIdProp,
  focusedBlockIdProp,
  setIsEditing,
} from '@/data/properties.ts'
import { useLayoutSessionBlock } from '@/data/globalState.ts'
import { useBlockQuery, useHandle, usePropertyValue } from '@/hooks/block.ts'
import { useRepo } from '@/context/repo.tsx'
import { useIsMobile } from '@/utils/react.tsx'
import { cn } from '@/lib/utils.ts'
import { getOrCreateDailyNote, todayIso } from '@/data/dailyNotes.ts'
import { navigateFromGlobalCommand } from '@/utils/navigation.ts'
import {
  panelBlockId,
  panelRowsInLayoutOrder,
} from '@/utils/panelLayoutProjection.ts'
import { toggleQuickFindEvent } from '@/plugins/quick-find/events.ts'
import { toggleCommandPaletteEvent } from '@/plugins/command-palette/events.ts'
import { useActiveContextsState } from '@/shortcuts/ActiveContexts.tsx'
import { ActionContextTypes } from '@/shortcuts/types.ts'

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>

const EMPTY_ROWS: readonly BlockData[] = Object.freeze([])
const ROOT_PAGE_LIMIT = 40

const decodeAliases = (data: BlockData): readonly string[] => {
  const raw = data.properties[aliasesProp.name]
  if (raw === undefined) return []
  try {
    return aliasesProp.codec.decode(raw)
  } catch {
    return []
  }
}

const pageLabel = (data: BlockData): string => {
  const alias = decodeAliases(data)[0]
  const label = alias ?? data.content
  const trimmed = label.trim()
  return trimmed || 'Untitled'
}

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

function SidebarAction({
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
      className="flex h-11 w-full items-center gap-3 rounded-md px-2 text-left text-sm text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-35"
      onClick={onClick}
      disabled={disabled}
    >
      <Icon className="h-5 w-5 shrink-0 text-muted-foreground"/>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
}

function MobileNavSidebar({
  open,
  rootPages,
  currentTopLevelBlockId,
  canCreateNode,
  onClose,
  onNewNode,
  onOpenSearch,
  onOpenToday,
  onOpenPage,
}: {
  open: boolean
  rootPages: readonly BlockData[]
  currentTopLevelBlockId: string | undefined
  canCreateNode: boolean
  onClose: () => void
  onNewNode: () => void
  onOpenSearch: () => void
  onOpenToday: () => void
  onOpenPage: (blockId: string) => void
}) {
  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 md:hidden"
      data-block-interaction="ignore"
    >
      <button
        type="button"
        aria-label="Close navigation menu"
        className="absolute inset-0 cursor-default bg-background/10"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
        className="absolute inset-y-0 left-0 flex w-[min(82vw,28rem)] max-w-full flex-col border-r border-border bg-background shadow-2xl"
      >
        <div className="flex h-14 shrink-0 items-center justify-end px-4">
          <button
            type="button"
            className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={onClose}
            aria-label="Close navigation menu"
            title="Close"
          >
            <ArrowLeft className="h-5 w-5"/>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          <button
            type="button"
            className="flex h-12 w-full items-center gap-3 rounded-full border border-border px-4 text-left text-sm text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
            onClick={onOpenSearch}
          >
            <Search className="h-5 w-5 shrink-0"/>
            <span>Jump to...</span>
          </button>

          <div className="mt-7 space-y-1">
            <SidebarAction
              label="Today"
              icon={CalendarDays}
              onClick={onOpenToday}
            />
          </div>

          <section className="mt-6">
            <div className="flex h-9 items-center gap-2 text-sm font-medium text-foreground">
              <ChevronDown className="h-4 w-4 text-muted-foreground"/>
              <Home className="h-4 w-4 text-muted-foreground"/>
              <span>Home</span>
            </div>
            <div className="mt-1 space-y-0.5">
              {rootPages.length === 0 ? (
                <div className="px-6 py-2 text-sm text-muted-foreground">
                  No pages yet.
                </div>
              ) : rootPages.map(page => {
                const isCurrent = page.id === currentTopLevelBlockId
                return (
                  <button
                    key={page.id}
                    type="button"
                    className={cn(
                      'flex h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-accent',
                      isCurrent ? 'bg-accent text-foreground' : 'text-muted-foreground',
                    )}
                    aria-current={isCurrent ? 'page' : undefined}
                    onClick={() => onOpenPage(page.id)}
                  >
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/70"/>
                    <span className="min-w-0 truncate">{pageLabel(page)}</span>
                  </button>
                )
              })}
            </div>
          </section>
        </div>

        <div
          className="shrink-0 border-t border-border px-5 pt-4"
          style={{paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))'}}
        >
          <button
            type="button"
            className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-muted px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
            onClick={onNewNode}
            disabled={!canCreateNode}
          >
            <Plus className="h-5 w-5"/>
            <span>New node</span>
          </button>
        </div>
      </aside>
    </div>
  )
}

function MobileBottomNavSurface() {
  const repo = useRepo()
  const layoutSessionBlock = useLayoutSessionBlock()
  const [activePanelId] = usePropertyValue(layoutSessionBlock, activePanelIdProp)
  const rows = useHandle(layoutSessionBlock.repo.query.subtree({id: layoutSessionBlock.id}), {
    selector: data => data ?? EMPTY_ROWS,
  })
  const pageRows = useBlockQuery({
    workspaceId: repo.activeWorkspaceId ?? '',
    types: [PAGE_TYPE],
  })

  const panelRows = useMemo(
    () => panelRowsInLayoutOrder(layoutSessionBlock.id, rows),
    [layoutSessionBlock.id, rows],
  )
  const activePanelRow = useMemo(
    () =>
      (activePanelId ? panelRows.find(row => row.id === activePanelId) : undefined)
      ?? panelRows.at(-1),
    [activePanelId, panelRows],
  )
  const activePanelBlock = useMemo(
    () => activePanelRow ? repo.block(activePanelRow.id) : null,
    [activePanelRow, repo],
  )
  const activeTopLevelBlockId = activePanelRow ? panelBlockId(activePanelRow) : undefined
  const canCreateNode = Boolean(activeTopLevelBlockId && activePanelBlock && !repo.isReadOnly)
  const rootPages = useMemo(
    () => pageRows
      .filter(page => page.parentId === null)
      .slice(0, ROOT_PAGE_LIMIT),
    [pageRows],
  )
  const [menuOpen, setMenuOpen] = useState(false)

  const closeMenu = useCallback(() => setMenuOpen(false), [])
  const openSearch = useCallback(() => {
    closeMenu()
    window.dispatchEvent(new CustomEvent(toggleQuickFindEvent))
  }, [closeMenu])
  const openCommandPalette = useCallback(() => {
    window.dispatchEvent(new CustomEvent(toggleCommandPaletteEvent))
  }, [])
  const openToday = useCallback(async () => {
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    closeMenu()
    const note = await getOrCreateDailyNote(repo, workspaceId, todayIso())
    navigateFromGlobalCommand(repo, {blockId: note.id, workspaceId})
  }, [closeMenu, repo])
  const createNode = useCallback(async () => {
    if (!activeTopLevelBlockId || !activePanelBlock || repo.isReadOnly) return
    closeMenu()
    const newId = await repo.mutate.createChild({
      parentId: activeTopLevelBlockId,
      position: {kind: 'last'},
    })
    await activePanelBlock.set(focusedBlockIdProp, newId)
    setIsEditing(activePanelBlock, true)
  }, [activePanelBlock, activeTopLevelBlockId, closeMenu, repo])
  const openPage = useCallback((blockId: string) => {
    closeMenu()
    navigateFromGlobalCommand(repo, {blockId})
  }, [closeMenu, repo])

  return (
    <>
      <MobileNavSidebar
        open={menuOpen}
        rootPages={rootPages}
        currentTopLevelBlockId={activeTopLevelBlockId}
        canCreateNode={canCreateNode}
        onClose={closeMenu}
        onNewNode={() => { void createNode() }}
        onOpenSearch={openSearch}
        onOpenToday={() => { void openToday() }}
        onOpenPage={openPage}
      />

      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 px-2 backdrop-blur supports-[backdrop-filter]:bg-background/85 md:hidden"
        style={{paddingBottom: 'env(safe-area-inset-bottom)'}}
        aria-label="Mobile navigation"
        data-block-interaction="ignore"
      >
        <div className="mx-auto flex h-16 max-w-md items-center justify-around">
          <BottomNavButton
            label="Open navigation menu"
            icon={Menu}
            onClick={() => setMenuOpen(true)}
          />
          <BottomNavButton
            label="New node"
            icon={Plus}
            onClick={() => { void createNode() }}
            disabled={!canCreateNode}
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
    </>
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
