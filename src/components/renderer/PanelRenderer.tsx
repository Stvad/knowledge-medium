import { BlockComponent } from '@/components/BlockComponent.tsx'
import { BlockRendererProps } from '@/types.ts'
import { NestedBlockContextProvider, useBlockContext } from '@/context/block.tsx'
import { Button } from '@/components/ui/button.tsx'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import {
  focusedBlockIdProp,
  scrollTopProp,
  topLevelBlockIdProp,
} from '@/data/properties.ts'
import { useSelectionState } from '@/data/globalState'
import { useRepo } from '@/context/repo'
import { useActionContext } from '@/shortcuts/useActionContext'
import { ActionContextTypes } from '@/shortcuts/types'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { usePropertyValue } from '@/hooks/block.ts'
import { ErrorBoundary } from 'react-error-boundary'
import { FallbackComponent } from '@/components/util/error.tsx'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { panelMountsFacet } from '@/extensions/core.ts'
import {
  goBackInPanel,
  goForwardInPanel,
  panelHistory,
  usePanelHistory,
} from '@/utils/panelHistory.ts'
import { deletePanelRow } from '@/utils/panelLayoutProjection.ts'

const SCROLL_WRITE_DELAY_MS = 200
const PANEL_ACTION_BUTTON_CLASS =
  'h-6 w-6 bg-background/60 text-muted-foreground hover:bg-accent hover:text-foreground'
const PANEL_HISTORY_BUTTON_CLASS =
  `${PANEL_ACTION_BUTTON_CLASS} disabled:text-muted-foreground/40 disabled:hover:bg-background/60 disabled:hover:text-muted-foreground/40`

export function PanelRenderer({block}: BlockRendererProps) {
  const [topLevelBlockId] = usePropertyValue(block, topLevelBlockIdProp)
  const [selectionState] = useSelectionState();
  const blockContext = useBlockContext()
  const canClosePanel = Boolean(blockContext.canClosePanel)
  const stackedPanel = Boolean(blockContext.stackedPanel)

  const repo = useRepo();

  // Memoize dependencies for MULTI_SELECT_MODE
  const multiSelectDeps = useMemo(() => {
    if (!selectionState.selectedBlockIds.length) return null;

    return {
      selectedBlocks: selectionState.selectedBlockIds.map(id => repo.block(id)),
      anchorBlock: selectionState.anchorBlockId ? repo.block(selectionState.anchorBlockId) : null,
      uiStateBlock: block,
    };
  }, [selectionState, block, repo]);

  // Activate MULTI_SELECT_MODE context when there are selected blocks and we're not editing
  useActionContext(
    ActionContextTypes.MULTI_SELECT_MODE,
    multiSelectDeps,
    !!multiSelectDeps
  );

  const {canBack, canForward} = usePanelHistory(block.id)
  const runtime = useAppRuntime()
  const panelMounts = useMemo(() => runtime.read(panelMountsFacet), [runtime])
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pendingScrollTopRef = useRef<number | undefined>(undefined)
  const scrollWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushScrollTop = useCallback(() => {
    if (scrollWriteTimerRef.current) {
      clearTimeout(scrollWriteTimerRef.current)
      scrollWriteTimerRef.current = null
    }
    const next = pendingScrollTopRef.current
    pendingScrollTopRef.current = undefined
    if (next === undefined) return
    if (block.peekProperty(scrollTopProp) === next) return
    void block.set(scrollTopProp, next)
  }, [block])

  const scheduleScrollTopWrite = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    pendingScrollTopRef.current = el.scrollTop
    if (scrollWriteTimerRef.current) clearTimeout(scrollWriteTimerRef.current)
    scrollWriteTimerRef.current = setTimeout(flushScrollTop, SCROLL_WRITE_DELAY_MS)
  }, [flushScrollTop])

  // Register a snapshotter so panelHistory can capture (focused block,
  // scroll) before any navigation away from the current top-level. The
  // panel block holds focusedBlockIdProp; scroll lives in the DOM and
  // we read it from the ref.
  useEffect(() => {
    return panelHistory.registerSnapshotter(block.id, () => ({
      focusedBlockId: block.peekProperty(focusedBlockIdProp),
      scrollTop: scrollRef.current?.scrollTop,
    }))
  }, [block])

  // Consume any pending restore queued by goBackInPanel /
  // goForwardInPanel. focusedBlockIdProp was already restored
  // synchronously by the helper (so the new render starts with the
  // right cursor); scroll restoration has to wait for the new content
  // to lay out, which is exactly what this post-effect window gives us.
  useEffect(() => {
    if (!topLevelBlockId) return
    const restore = panelHistory.consumeRestore(block.id)
    const scrollTop = restore?.scrollTop ?? block.peekProperty(scrollTopProp)
    if (scrollTop != null && scrollRef.current) {
      scrollRef.current.scrollTop = scrollTop
    }
  }, [topLevelBlockId, block])

  useEffect(() => flushScrollTop, [flushScrollTop])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushScrollTop()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [flushScrollTop])

  const handleClose = () => {
    void deletePanelRow(repo, block.id)
  }

  if (!topLevelBlockId) {
     console.warn(`Panel ${block.id} has no topLevelBlockId, skipping render.`)
     return null
  }

  return (
    <div className={`panel min-w-0 max-w-full flex flex-col relative ${
      stackedPanel ? 'overflow-visible' : 'h-full flex-grow overflow-hidden'
    }`}>
      <div className="absolute top-1 right-0.5 z-10 flex gap-0.5">
        <Button
          variant="ghost"
          size="icon"
          className={PANEL_HISTORY_BUTTON_CLASS}
          onClick={() => { void goBackInPanel(block) }}
          disabled={!canBack}
          aria-label="Back"
          title="Back"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={PANEL_HISTORY_BUTTON_CLASS}
          onClick={() => { void goForwardInPanel(block) }}
          disabled={!canForward}
          aria-label="Forward"
          title="Forward"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        {canClosePanel && (
          <Button
            variant="ghost"
            size="icon"
            className={PANEL_ACTION_BUTTON_CLASS}
            onClick={handleClose}
            aria-label="Close panel"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
      <div
        ref={scrollRef}
        className={stackedPanel ? 'overflow-visible' : 'flex-grow overflow-y-auto scrollbar-none'}
        onScroll={scheduleScrollTopWrite}
      >
        <NestedBlockContextProvider overrides={{topLevel: false}}>
          <BlockComponent blockId={topLevelBlockId}/>
        </NestedBlockContextProvider>
      </div>
      {/* Per-panel mount points — chrome contributed via
          `panelMountsFacet` (e.g. swipe-quick-actions menu). Mounted
          inside `.panel` so position:fixed/absolute children sit in the
          panel's positioning context, and isolated under their own
          ErrorBoundaries so a misbehaving plugin can't tear down the
          panel. */}
      {panelMounts.map(({id, component: Component}) => (
        <ErrorBoundary key={id} FallbackComponent={FallbackComponent}>
          <Component block={block}/>
        </ErrorBoundary>
      ))}
    </div>
  )
}

PanelRenderer.canRender = ({context}: BlockRendererProps) => !!(context?.topLevel && context.panelId)
PanelRenderer.priority = () => 5
