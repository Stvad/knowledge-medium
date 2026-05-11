import { use, useCallback, useEffect, useState } from 'react'
import { ErrorBoundary } from 'react-error-boundary'
import { memoize } from 'lodash'
import { v5 as uuidv5 } from 'uuid'
import {
  ArrowLeft,
  CalendarDays,
  ChevronRight,
  Plus,
  Search,
} from 'lucide-react'
import type { Block } from '@/data/block.ts'
import type { BlockData } from '@/data/api'
import { ChangeScope } from '@/data/api'
import { aliasesProp } from '@/data/properties.ts'
import { keyAtEnd } from '@/data/orderKey.ts'
import { useUserBlock } from '@/data/globalState.ts'
import { useChildren, useHandle } from '@/hooks/block.ts'
import { useRepo } from '@/context/repo.tsx'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { FallbackComponent } from '@/components/util/error.tsx'
import { cn } from '@/lib/utils.ts'
import { getOrCreateDailyNote, todayIso } from '@/data/dailyNotes.ts'
import { navigateFromGlobalCommand } from '@/utils/navigation.ts'
import { toggleQuickFindEvent } from '@/plugins/quick-find/events.ts'
import {
  closeLeftSidebarEvent,
  openLeftSidebarEvent,
  toggleLeftSidebarEvent,
} from './events.ts'
import {
  createNodeInActivePanel,
  useActivePanelNodeTarget,
} from './panelTarget.tsx'
import {
  leftSidebarSectionsFacet,
  type LeftSidebarSectionContribution,
  type LeftSidebarSectionProps,
} from './facet.ts'

const SHORTCUTS_BLOCK_CONTENT = 'Shortcuts'
const SHORTCUTS_BLOCK_NS = 'e99db742-98fd-494a-aa31-f4afaa3d247f'

const shortcutsBlockId = (userBlockId: string): string =>
  uuidv5(userBlockId, SHORTCUTS_BLOCK_NS)

const decodeAliases = (data: BlockData): readonly string[] => {
  const raw = data.properties[aliasesProp.name]
  if (raw === undefined) return []
  try {
    return aliasesProp.codec.decode(raw)
  } catch {
    return []
  }
}

const blockLabel = (
  data: {aliases: readonly string[]; content: string} | undefined,
  fallback: string,
): string => {
  const label = data ? (data.aliases[0] ?? data.content) : fallback
  const trimmed = label.trim()
  return trimmed || fallback || 'Untitled'
}

const getOrCreateShortcutsBlock = memoize(
  async (userBlock: Block): Promise<Block> => {
    const repo = userBlock.repo
    const userData = userBlock.peek() ?? await userBlock.load()
    if (!userData) throw new Error(`Shortcuts parent ${userBlock.id} is missing`)

    const existingByContent = await repo.query.firstChildByContent({
      parentId: userBlock.id,
      content: SHORTCUTS_BLOCK_CONTENT,
    }).load()
    if (existingByContent) return repo.block(existingByContent.id)

    const id = shortcutsBlockId(userBlock.id)
    const live = await repo.load(id)
    if (live && !live.deleted) return repo.block(id)

    let resolvedId = id
    await repo.tx(async tx => {
      const parent = await tx.get(userBlock.id)
      if (!parent || parent.deleted) {
        throw new Error(`Shortcuts parent ${userBlock.id} is missing`)
      }

      const children = await tx.childrenOf(userBlock.id, parent.workspaceId)
      const existing = children.find(child => child.content === SHORTCUTS_BLOCK_CONTENT)
      if (existing) {
        resolvedId = existing.id
        return
      }

      const orderKey = keyAtEnd(children.at(-1)?.orderKey ?? null)
      const tombstone = await tx.get(id)
      if (tombstone) {
        resolvedId = tombstone.id
        if (tombstone.deleted) {
          await tx.restore(tombstone.id, {content: SHORTCUTS_BLOCK_CONTENT})
        }
        if (tombstone.parentId !== userBlock.id || tombstone.orderKey !== orderKey) {
          await tx.move(tombstone.id, {parentId: userBlock.id, orderKey})
        }
        return
      }

      resolvedId = await tx.create({
        id,
        workspaceId: parent.workspaceId,
        parentId: userBlock.id,
        orderKey,
        content: SHORTCUTS_BLOCK_CONTENT,
      })
    }, {scope: ChangeScope.UserPrefs, description: 'ensure shortcuts block'})

    return repo.block(resolvedId)
  },
  userBlock => `${userBlock.repo.instanceId}:${userBlock.id}`,
)

function useShortcutsBlock(): Block {
  return use(getOrCreateShortcutsBlock(useUserBlock()))
}

function SidebarAction({
  label,
  icon: Icon,
  onClick,
}: {
  label: string
  icon: typeof CalendarDays
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="flex h-11 w-full items-center gap-3 rounded-md px-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
      onClick={onClick}
    >
      <Icon className="h-5 w-5 shrink-0 text-muted-foreground"/>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
}

export function LeftSidebarCoreSection({closeSidebar}: LeftSidebarSectionProps) {
  const repo = useRepo()

  const openSearch = useCallback(() => {
    closeSidebar()
    window.dispatchEvent(new CustomEvent(toggleQuickFindEvent))
  }, [closeSidebar])

  const openToday = useCallback(async () => {
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    closeSidebar()
    const note = await getOrCreateDailyNote(repo, workspaceId, todayIso())
    navigateFromGlobalCommand(repo, {blockId: note.id, workspaceId})
  }, [closeSidebar, repo])

  return (
    <section className="space-y-5">
      <button
        type="button"
        className="flex h-12 w-full items-center gap-3 rounded-full border border-border px-4 text-left text-sm text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
        onClick={openSearch}
      >
        <Search className="h-5 w-5 shrink-0"/>
        <span>Jump to...</span>
      </button>

      <div className="space-y-1">
        <SidebarAction
          label="Today"
          icon={CalendarDays}
          onClick={() => { void openToday() }}
        />
      </div>
    </section>
  )
}

function ShortcutTargetItem({
  targetId,
  fallbackLabel,
  currentTopLevelBlockId,
  closeSidebar,
}: {
  targetId: string
  fallbackLabel: string
  currentTopLevelBlockId: string | undefined
  closeSidebar: () => void
}) {
  const repo = useRepo()
  const targetData = useHandle(repo.block(targetId), {
    selector: data => data
      ? {
        aliases: decodeAliases(data),
        content: data.content,
      }
      : undefined,
  })
  const isCurrent = targetId === currentTopLevelBlockId
  const label = blockLabel(targetData, fallbackLabel)

  const openShortcut = useCallback(() => {
    closeSidebar()
    navigateFromGlobalCommand(repo, {blockId: targetId})
  }, [closeSidebar, repo, targetId])

  return (
    <button
      type="button"
      className={cn(
        'flex h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-accent',
        isCurrent ? 'bg-accent text-foreground' : 'text-muted-foreground',
      )}
      aria-current={isCurrent ? 'page' : undefined}
      onClick={openShortcut}
    >
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/70"/>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
}

function ShortcutItem({
  block,
  currentTopLevelBlockId,
  closeSidebar,
}: {
  block: Block
  currentTopLevelBlockId: string | undefined
  closeSidebar: () => void
}) {
  const data = useHandle(block, {
    selector: doc => doc
      ? {
        aliases: decodeAliases(doc),
        content: doc.content,
        references: doc.references,
      }
      : undefined,
  })
  if (!data) return null

  const targetRef = data.references.find(ref => !ref.sourceField) ?? data.references[0]
  if (!targetRef) {
    return (
      <div className="flex h-10 items-center gap-2 px-2 text-sm text-muted-foreground/70">
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/40"/>
        <span className="min-w-0 truncate">{blockLabel(data, 'Unlinked shortcut')}</span>
      </div>
    )
  }

  return (
    <ShortcutTargetItem
      targetId={targetRef.id}
      fallbackLabel={targetRef.alias}
      currentTopLevelBlockId={currentTopLevelBlockId}
      closeSidebar={closeSidebar}
    />
  )
}

export function LeftSidebarShortcutsSection({closeSidebar}: LeftSidebarSectionProps) {
  const shortcutsBlock = useShortcutsBlock()
  const shortcuts = useChildren(shortcutsBlock)
  const {activeTopLevelBlockId} = useActivePanelNodeTarget()

  return (
    <section>
      <div className="flex h-9 items-center gap-2 text-sm font-medium text-foreground">
        <span>Shortcuts</span>
      </div>
      <div className="mt-1 space-y-0.5">
        {shortcuts.length === 0 ? (
          <div className="px-2 py-2 text-sm text-muted-foreground">
            No shortcuts yet.
          </div>
        ) : shortcuts.map(shortcut => (
          <ShortcutItem
            key={shortcut.id}
            block={shortcut}
            currentTopLevelBlockId={activeTopLevelBlockId}
            closeSidebar={closeSidebar}
          />
        ))}
      </div>
    </section>
  )
}

function NewNodeFooter({
  closeSidebar,
}: {
  closeSidebar: () => void
}) {
  const repo = useRepo()
  const target = useActivePanelNodeTarget()

  const createNode = useCallback(async () => {
    closeSidebar()
    await createNodeInActivePanel({repo, ...target})
  }, [closeSidebar, repo, target])

  return (
    <div
      className="shrink-0 border-t border-border px-5 pt-4"
      style={{paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))'}}
    >
      <button
        type="button"
        className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-muted px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
        onClick={() => { void createNode() }}
        disabled={!target.canCreateNode}
      >
        <Plus className="h-5 w-5"/>
        <span>New node</span>
      </button>
    </div>
  )
}

function SidebarSections({
  sections,
  closeSidebar,
}: {
  sections: readonly LeftSidebarSectionContribution[]
  closeSidebar: () => void
}) {
  return (
    <>
      {sections.map(({id, component: Section}) => (
        <ErrorBoundary key={id} FallbackComponent={FallbackComponent}>
          <Section closeSidebar={closeSidebar}/>
        </ErrorBoundary>
      ))}
    </>
  )
}

export function LeftSidebar() {
  const runtime = useAppRuntime()
  const sections = runtime.read(leftSidebarSectionsFacet)
  const [open, setOpen] = useState(false)

  const closeSidebar = useCallback(() => setOpen(false), [])

  useEffect(() => {
    const openSidebar = () => setOpen(true)
    const close = () => setOpen(false)
    const toggle = () => setOpen(value => !value)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }

    window.addEventListener(openLeftSidebarEvent, openSidebar)
    window.addEventListener(closeLeftSidebarEvent, close)
    window.addEventListener(toggleLeftSidebarEvent, toggle)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener(openLeftSidebarEvent, openSidebar)
      window.removeEventListener(closeLeftSidebarEvent, close)
      window.removeEventListener(toggleLeftSidebarEvent, toggle)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50"
      data-block-interaction="ignore"
    >
      <button
        type="button"
        aria-label="Close sidebar"
        className="absolute inset-0 cursor-default bg-background/10"
        onClick={closeSidebar}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Sidebar"
        className="absolute inset-y-0 left-0 flex w-[min(82vw,28rem)] max-w-full flex-col border-r border-border bg-background shadow-2xl md:w-80"
      >
        <div className="flex h-14 shrink-0 items-center justify-end px-4">
          <button
            type="button"
            className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={closeSidebar}
            aria-label="Close sidebar"
            title="Close"
          >
            <ArrowLeft className="h-5 w-5"/>
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 pb-5">
          <SidebarSections sections={sections} closeSidebar={closeSidebar}/>
        </div>

        <NewNodeFooter closeSidebar={closeSidebar}/>
      </aside>
    </div>
  )
}
