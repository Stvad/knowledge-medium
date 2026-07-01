import { Suspense, use, useCallback, useEffect, useSyncExternalStore, type MouseEvent } from 'react'
import {
  ArrowLeft,
  ChevronRight,
} from 'lucide-react'
import type { Block } from '@/data/block.js'
import type { BlockData } from '@/data/api'
import { aliasesProp } from '@/data/properties.js'
import { useUserBlock } from '@/data/globalState.js'
import { useChildren, useHandle } from '@/hooks/block.js'
import { useRepo } from '@/context/repo.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { ExtensionRenderBoundary } from '@/extensions/ExtensionRenderBoundary.js'
import { OPEN_TODAY_ACTION_ID } from '@/plugins/daily-notes'
import { QUICK_FIND_ACTION_ID } from '@/plugins/quick-find'
import { useBlockOpener } from '@/utils/navigation.js'
import { useActiveContextsState } from '@/shortcuts/ActiveContexts.js'
import { getEffectiveActions } from '@/shortcuts/effectiveActions.js'
import { CREATE_NODE_IN_ACTIVE_PANEL_ACTION_ID } from '@/shortcuts/defaultShortcuts.js'
import { useRunAction } from '@/shortcuts/runAction.js'
import type { ActionConfig, ActionIcon } from '@/shortcuts/types.js'
import { leftSidebarToggle } from './toggleStore.ts'
import {
  leftSidebarSectionsFacet,
  type LeftSidebarSectionContribution,
  type LeftSidebarSectionProps,
} from './facet.ts'
import { getOrCreateShortcutsBlock } from './shortcuts.ts'

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

function useShortcutsBlock(): Block {
  return use(getOrCreateShortcutsBlock(useUserBlock()))
}

const LEFT_SIDEBAR_ACTION_EVENT = 'left-sidebar-action'

function useRegisteredAction(actionId: string): ActionConfig | undefined {
  const runtime = useAppRuntime()
  return getEffectiveActions(runtime).find(action => action.id === actionId)
}

function useSidebarActionRunner({
  actionId,
  closeSidebar,
}: {
  actionId: string
  closeSidebar: () => void
}) {
  const action = useRegisteredAction(actionId)
  const activeContexts = useActiveContextsState()
  const runAction = useRunAction()
  const Icon: ActionIcon | undefined = action?.icon

  const run = useCallback(() => {
    if (!action) return
    closeSidebar()
    void runAction(
      action.id,
      new CustomEvent(LEFT_SIDEBAR_ACTION_EVENT, {detail: {actionId: action.id}}),
    )
  }, [action, closeSidebar, runAction])

  return {
    action,
    disabled: !action || !activeContexts.has(action.context),
    Icon,
    run,
  }
}

function SidebarAction({
  actionId,
  closeSidebar,
  label,
}: {
  actionId: string
  closeSidebar: () => void
  label?: string
}) {
  const {action, disabled, Icon, run} = useSidebarActionRunner({actionId, closeSidebar})

  if (!action || !Icon) return null

  return (
    <button
      type="button"
      className="flex h-11 w-full items-center gap-3 rounded-md px-2 text-left text-sm text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
      onClick={run}
      disabled={disabled}
    >
      <Icon className="h-5 w-5 shrink-0 text-muted-foreground"/>
      <span className="min-w-0 truncate">{label ?? action.description}</span>
    </button>
  )
}

function SearchSidebarAction({
  closeSidebar,
}: {
  closeSidebar: () => void
}) {
  const {action, disabled, Icon, run} = useSidebarActionRunner({
    actionId: QUICK_FIND_ACTION_ID,
    closeSidebar,
  })

  if (!action || !Icon) return null

  return (
    <button
      type="button"
      className="flex h-12 w-full items-center gap-3 rounded-full border border-border px-4 text-left text-sm text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      onClick={run}
      disabled={disabled}
    >
      <Icon className="h-5 w-5 shrink-0"/>
      <span>Jump to...</span>
    </button>
  )
}

export function LeftSidebarCoreSection({closeSidebar}: LeftSidebarSectionProps) {
  return (
    <section className="space-y-5">
      <SearchSidebarAction closeSidebar={closeSidebar}/>
      <div className="space-y-1">
        <SidebarAction
          actionId={OPEN_TODAY_ACTION_ID}
          closeSidebar={closeSidebar}
          label="Today"
        />
      </div>
    </section>
  )
}

function ShortcutTargetItem({
  targetId,
  fallbackLabel,
  closeSidebar,
}: {
  targetId: string
  fallbackLabel: string
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
  const label = blockLabel(targetData, fallbackLabel)
  const openBlock = useBlockOpener({plainClick: 'navigator'})

  const openShortcut = useCallback((event: MouseEvent) => {
    closeSidebar()
    openBlock(event, {blockId: targetId})
  }, [closeSidebar, openBlock, targetId])

  return (
    <button
      type="button"
      className="flex h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent"
      onClick={openShortcut}
    >
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/70"/>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
}

function ShortcutItem({
  block,
  closeSidebar,
}: {
  block: Block
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
      closeSidebar={closeSidebar}
    />
  )
}

export function LeftSidebarShortcutsSection({closeSidebar}: LeftSidebarSectionProps) {
  const shortcutsBlock = useShortcutsBlock()
  const shortcuts = useChildren(shortcutsBlock)
  const openBlock = useBlockOpener({plainClick: 'navigator'})
  const openShortcutsBlock = useCallback((event: MouseEvent) => {
    closeSidebar()
    openBlock(event, {blockId: shortcutsBlock.id})
  }, [closeSidebar, openBlock, shortcutsBlock.id])

  return (
    <section>
      <button
        type="button"
        className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm font-medium text-foreground transition-colors hover:bg-accent"
        onClick={openShortcutsBlock}
      >
        <span className="min-w-0 truncate">Shortcuts</span>
      </button>
      <div className="mt-1 space-y-0.5">
        {shortcuts.length === 0 ? (
          <div className="px-2 py-2 text-sm text-muted-foreground">
            No shortcuts yet.
          </div>
        ) : shortcuts.map(shortcut => (
          <ShortcutItem
            key={shortcut.id}
            block={shortcut}
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
  const {action, disabled, Icon, run} = useSidebarActionRunner({
    actionId: CREATE_NODE_IN_ACTIVE_PANEL_ACTION_ID,
    closeSidebar,
  })

  if (!action || !Icon) return null

  return (
    <div
      className="shrink-0 border-t border-border px-5 pt-4"
      style={{paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))'}}
    >
      <button
        type="button"
        className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-muted px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
        onClick={run}
        disabled={disabled}
      >
        <Icon className="h-5 w-5"/>
        <span>{action.description}</span>
      </button>
    </div>
  )
}

function NewNodeFooterFallback() {
  return (
    <div
      className="shrink-0 border-t border-border px-5 pt-4"
      style={{paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))'}}
      aria-label="Loading sidebar footer"
    >
      <div className="h-12 w-full animate-pulse rounded-full bg-muted"/>
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
        <ExtensionRenderBoundary key={id} suspenseFallback={<SidebarSectionFallback/>}>
          <Section closeSidebar={closeSidebar}/>
        </ExtensionRenderBoundary>
      ))}
    </>
  )
}

function SidebarSectionFallback() {
  return (
    <section
      className="space-y-2 px-2 py-1"
      aria-label="Loading sidebar section"
    >
      <div className="h-4 w-24 animate-pulse rounded bg-muted"/>
      <div className="h-8 w-full animate-pulse rounded-md bg-muted/70"/>
      <div className="h-8 w-3/4 animate-pulse rounded-md bg-muted/70"/>
    </section>
  )
}

export function LeftSidebar() {
  const runtime = useAppRuntime()
  const sections = runtime.read(leftSidebarSectionsFacet)
  const open = useSyncExternalStore(
    leftSidebarToggle.subscribe,
    leftSidebarToggle.isOpen,
    leftSidebarToggle.isOpen,
  )

  const closeSidebar = leftSidebarToggle.close

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') leftSidebarToggle.close()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
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
        // paddingTop reserves the iOS status-bar strip in the installed PWA. This
        // overlay is a viewport-anchored sibling of the TopLevelRenderer frame
        // (mounted via AppMounts), so it doesn't inherit that frame's top inset —
        // without this, the close button below sits under the clock/battery. On the
        // `bg-background` aside so the panel fill still flows behind the status bar;
        // 0 in a normal browser tab. Mirrors TopLevelRenderer's frame inset.
        style={{paddingTop: 'env(safe-area-inset-top, 0px)'}}
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

        <Suspense fallback={<NewNodeFooterFallback/>}>
          <NewNodeFooter closeSidebar={closeSidebar}/>
        </Suspense>
      </aside>
    </div>
  )
}
