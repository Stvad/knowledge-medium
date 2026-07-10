import { BlockComponent } from '@/components/BlockComponent.js'
import { BlockRendererProps } from '@/types.js'
import { RenderSurfaceProvider, useBlockContext } from '@/context/block.js'
import { Button } from '@/components/ui/button.js'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import {
  peekFocusedBlockLocation,
  scrollTopProp,
  topLevelBlockIdProp,
} from '@/data/properties.js'
import { useIsActivePanel, useSelectionState } from '@/data/globalState'
import { useRepo } from '@/context/repo'
import { useActionContext } from '@/shortcuts/useActionContext'
import { ActionContextTypes } from '@/shortcuts/types'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { usePropertyValue } from '@/hooks/block.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { panelMountsFacet } from '@/extensions/core.js'
import { ExtensionRenderBoundary } from '@/extensions/ExtensionRenderBoundary.js'
import {
  goBackInPanel,
  goForwardInPanel,
  panelHistory,
  usePanelHistory,
} from '@/utils/panelHistory.js'
import { activatePanelRow, deletePanelRow } from '@/utils/panelLayoutProjection.js'
import { outlineRenderScopeId } from '@/utils/renderScope.js'
import { forceOpenScopeRootPolicy } from '@/utils/renderVisibility.js'
import type { RenderVisibilityPolicy } from '@/types.js'
import type { MouseEvent, PointerEvent } from 'react'

const SCROLL_WRITE_DELAY_MS = 200
const PANEL_ACTION_BUTTON_CLASS =
  'pointer-events-auto h-6 w-6 bg-background/60 text-muted-foreground hover:bg-accent hover:text-foreground'
const PANEL_HISTORY_BUTTON_CLASS =
  `${PANEL_ACTION_BUTTON_CLASS} disabled:text-muted-foreground/40 disabled:hover:bg-background/60 disabled:hover:text-muted-foreground/40`

function PanelMultiSelectActionContext({
  scopeRootId,
  renderVisibilityPolicy,
}: {
  scopeRootId: string
  renderVisibilityPolicy: RenderVisibilityPolicy
}) {
  const [selectionState] = useSelectionState()
  const repo = useRepo()

  const multiSelectDeps = useMemo(() => {
    if (!selectionState.selectedBlockIds.length) return null

    return {
      selectedBlocks: selectionState.selectedBlockIds.map(id => repo.block(id)),
      anchorBlock: selectionState.anchorBlockId ? repo.block(selectionState.anchorBlockId) : null,
      // Multi-select operates over the panel's outline, so its scope
      // root is the panel's zoom root. Forwarded to per-block structural
      // actions (indent/outdent/delete) via applyToAllBlocksInSelection.
      scopeRootId,
      renderVisibilityPolicy,
    }
  }, [selectionState, repo, scopeRootId, renderVisibilityPolicy])

  useActionContext(
    ActionContextTypes.MULTI_SELECT_MODE,
    multiSelectDeps,
    Boolean(multiSelectDeps),
  )

  return null
}

export function PanelRenderer({block}: BlockRendererProps) {
  const [topLevelBlockId] = usePropertyValue(block, topLevelBlockIdProp)
  const blockContext = useBlockContext()
  const canClosePanel = Boolean(blockContext.canClosePanel)
  const stackedPanel = Boolean(blockContext.stackedPanel)
  const wideScrollSurface = Boolean(blockContext.wideScrollSurface) && !stackedPanel
  const layoutSessionBlockId = typeof blockContext.layoutSessionBlockId === 'string'
    ? blockContext.layoutSessionBlockId
    : undefined
  const trackPanelFocus = Boolean(blockContext.trackPanelFocus)

  const repo = useRepo()

  const isActivePanel = useIsActivePanel(block)

  const {canBack, canForward} = usePanelHistory(block.id)
  const runtime = useAppRuntime()
  const panelMounts = useMemo(() => runtime.read(panelMountsFacet), [runtime])
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pendingScrollTopRef = useRef<number | undefined>(undefined)
  const scrollWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingActivationRef = useRef(false)

  const activatePanel = useCallback(() => {
    if (!layoutSessionBlockId) return
    if (pendingActivationRef.current) return

    pendingActivationRef.current = true
    void activatePanelRow(repo, layoutSessionBlockId, block.id)
      .finally(() => {
        pendingActivationRef.current = false
      })
  }, [block.id, layoutSessionBlockId, repo])

  useEffect(() => {
    if (isActivePanel) pendingActivationRef.current = false
  }, [isActivePanel])

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
  // panel block holds focusedBlockLocationProp; scroll lives in the DOM and
  // we read it from the ref.
  useEffect(() => {
    return panelHistory.registerSnapshotter(block.id, () => ({
      focusedLocation: peekFocusedBlockLocation(block),
      scrollTop: scrollRef.current?.scrollTop,
    }))
  }, [block])

  // Consume any pending restore queued by goBackInPanel /
  // goForwardInPanel. focusedBlockLocationProp was already restored
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

  const handleClosePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation()
  }

  const handleClose = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    void deletePanelRow(repo, block.id)
  }

  const panelRenderVisibilityPolicy = useMemo(() => topLevelBlockId
    ? forceOpenScopeRootPolicy(topLevelBlockId)
    : null, [topLevelBlockId])

  const panelBodyContextOverrides = useMemo(() => topLevelBlockId && panelRenderVisibilityPolicy
    ? {
        layoutBoundary: false,
        renderScopeId: outlineRenderScopeId(topLevelBlockId),
        scopeRootId: topLevelBlockId,
        renderVisibilityPolicy: panelRenderVisibilityPolicy,
      }
    : null, [topLevelBlockId, panelRenderVisibilityPolicy])

  if (!topLevelBlockId) {
     console.warn(`Panel ${block.id} has no topLevelBlockId, skipping render.`)
     return null
  }

  const actionButtons = (
    <>
      <Button
        variant="ghost"
        size="icon"
        className={PANEL_HISTORY_BUTTON_CLASS}
        onFocus={trackPanelFocus ? activatePanel : undefined}
        onClick={() => {
          activatePanel()
          void goBackInPanel(block)
        }}
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
        onFocus={trackPanelFocus ? activatePanel : undefined}
        onClick={() => {
          activatePanel()
          void goForwardInPanel(block)
        }}
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
          onPointerDown={handleClosePointerDown}
          onClick={handleClose}
          aria-label="Close panel"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </>
  )

  const panelBody = (
    <RenderSurfaceProvider
      overrides={panelBodyContextOverrides!}
    >
      <BlockComponent blockId={topLevelBlockId}/>
    </RenderSurfaceProvider>
  )

  return (
    <div
      data-panel-id={block.id}
      data-panel-active={isActivePanel ? 'true' : undefined}
      onPointerDown={activatePanel}
      className={`panel min-w-0 max-w-full flex flex-col relative ${
        stackedPanel ? 'overflow-visible' : 'h-full flex-grow overflow-hidden'
      } ${isActivePanel ? 'panel-active' : ''}`}>
      {isActivePanel && (
        <PanelMultiSelectActionContext
          scopeRootId={topLevelBlockId}
          renderVisibilityPolicy={panelRenderVisibilityPolicy!}
        />
      )}
      {wideScrollSurface ? (
        <div className="pointer-events-none absolute inset-x-0 top-1 z-10">
          <div className="pointer-events-none mx-auto flex w-full max-w-3xl justify-end gap-0.5">
            {actionButtons}
          </div>
        </div>
      ) : (
        <div className="pointer-events-none absolute top-1 right-0.5 z-10 flex gap-0.5">
          {actionButtons}
        </div>
      )}
      <div
        ref={scrollRef}
        className={stackedPanel ? 'overflow-visible' : 'flex-grow overflow-y-auto scrollbar-none pb-[calc(env(safe-area-inset-bottom)+4rem)] md:pb-0'}
        onPointerDownCapture={activatePanel}
        onFocusCapture={trackPanelFocus ? activatePanel : undefined}
        onScroll={scheduleScrollTopWrite}
      >
        {wideScrollSurface ? (
          <div className="mx-auto w-full max-w-3xl">
            {panelBody}
          </div>
        ) : panelBody}
      </div>
      {/* Per-panel mount points — chrome contributed via
          `panelMountsFacet` (e.g. swipe-quick-actions menu). Mounted
          inside `.panel` so position:fixed/absolute children sit in the
          panel's positioning context, and isolated under render
          boundaries so a loading or misbehaving plugin can't tear down
          the panel. */}
      {panelMounts.map(({id, component: Component}) => (
        <ExtensionRenderBoundary key={id}>
          <Component block={block}/>
        </ExtensionRenderBoundary>
      ))}
    </div>
  )
}

PanelRenderer.canRender = ({context}: BlockRendererProps) => !!(context?.layoutBoundary && context.panelId)
PanelRenderer.priority = () => 5
