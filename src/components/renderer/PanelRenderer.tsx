import { BlockComponent } from '@/components/BlockComponent.js'
import { BlockRendererProps } from '@/types.js'
import { NestedBlockContextProvider, useBlockContext } from '@/context/block.js'
import { Button } from '@/components/ui/button.js'
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, X } from 'lucide-react'
import {
  focusedBlockLocationProp,
  panelMaximizedProp,
  panelViewModeProp,
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
import { FocusedRowLazyMount } from '@/components/util/FocusedRowLazyMount.js'
import {
  goBackInPanel,
  goForwardInPanel,
  panelHistory,
  usePanelHistory,
  type VisitState,
} from '@/utils/panelHistory.js'
import { alignScrollportToRow } from '@/utils/panelScrollAnchor.js'
import { isMobileViewport } from '@/utils/viewport.js'
import {
  activatePanelRow,
  deletePanelRow,
  togglePanelMaximized,
} from '@/utils/panelLayoutProjection.js'
import { outlineRenderScopeId, panelRenderScopeId } from '@/utils/renderScope.js'
import type { MouseEvent, PointerEvent } from 'react'

const SCROLL_WRITE_DELAY_MS = 200
const PANEL_ACTION_BUTTON_CLASS =
  'pointer-events-auto h-6 w-6 bg-background/60 text-muted-foreground hover:bg-accent hover:text-foreground'
const PANEL_HISTORY_BUTTON_CLASS =
  `${PANEL_ACTION_BUTTON_CLASS} disabled:text-muted-foreground/40 disabled:hover:bg-background/60 disabled:hover:text-muted-foreground/40`

function PanelMultiSelectActionContext({scopeRootId}: {scopeRootId: string}) {
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
    }
  }, [selectionState, repo, scopeRootId])

  useActionContext(
    ActionContextTypes.MULTI_SELECT_MODE,
    multiSelectDeps,
    Boolean(multiSelectDeps),
  )

  return null
}

export function PanelRenderer({block}: BlockRendererProps) {
  const [topLevelBlockId] = usePropertyValue(block, topLevelBlockIdProp)
  const [panelViewMode] = usePropertyValue(block, panelViewModeProp)
  const [panelMaximized] = usePropertyValue(block, panelMaximizedProp)
  const blockContext = useBlockContext()
  const canClosePanel = Boolean(blockContext.canClosePanel)
  const canMaximizePanel = Boolean(blockContext.canMaximizePanel)
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
  // The restore this pane already drained, kept so StrictMode's effect replay
  // sees the same answer the first setup did. `consumeRestore` is destructive,
  // and the replay would otherwise find nothing, peek the cursor
  // `writePanelContent` MANUFACTURES for a cursorless visit, and anchor to the
  // top — undoing the offset the first pass had just restored. Keyed by
  // (pane, content) so a real navigation drains a fresh one; only ever one
  // slot, so A → B → A re-consumes correctly.
  const consumedRestoreRef = useRef<{key: string; state: VisitState | undefined} | null>(null)

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

  // DELETABLE SHIM (2026-07): legacy outline:-scope migration; remove after
  // deploys settle. Pre-deploy panel rows persisted focus locations under the
  // pane's old `outline:<topLevelBlockId>` scope; renders now use
  // `panel:<panelId>:<topLevelBlockId>`, and the strict scope compare (focus
  // highlight, NORMAL_MODE surface activation) would leave keyboard nav dead
  // until the first click. Rewrite the stored location once on mount.
  useEffect(() => {
    if (!topLevelBlockId) return
    const location = peekFocusedBlockLocation(block)
    if (!location) return
    const isLegacyScope = location.renderScopeId === outlineRenderScopeId(topLevelBlockId) ||
      location.renderScopeId === outlineRenderScopeId(location.blockId)
    if (!isLegacyScope) return
    void block.set(focusedBlockLocationProp, {
      ...location,
      renderScopeId: panelRenderScopeId(block.id, topLevelBlockId),
    })
  }, [block, topLevelBlockId])

  // Register a snapshotter so panelHistory can capture (focused block,
  // scroll, view mode) before any navigation away from the current
  // top-level. The panel block holds focusedBlockLocationProp and
  // panelViewModeProp; scroll lives in the DOM and we read it from the ref.
  useEffect(() => {
    return panelHistory.registerSnapshotter(block.id, () => ({
      focusedLocation: peekFocusedBlockLocation(block),
      scrollTop: scrollRef.current?.scrollTop,
      viewMode: block.peekProperty(panelViewModeProp),
    }))
  }, [block])

  // Consume any pending restore queued by goBackInPanel /
  // goForwardInPanel. focusedBlockLocationProp was already restored
  // synchronously by the helper (so the new render starts with the
  // right cursor); scroll restoration has to wait for the new content
  // to lay out, which is exactly what this post-effect window gives us.
  //
  // The cursor is the anchor, not the stored pixel offset: rows mount lazily
  // and their measured heights die with the page, so the same `scrollTop`
  // means a different place after a reload (see `panelScrollAnchor`). The
  // offset is still the fallback for a pane with no cursor at all — a page
  // opened and scrolled but never clicked or navigated in.
  useEffect(() => {
    if (!topLevelBlockId) return
    const restoreKey = `${block.id}:${topLevelBlockId}`
    let restore: VisitState | undefined
    if (consumedRestoreRef.current?.key === restoreKey) {
      restore = consumedRestoreRef.current.state
    } else {
      restore = panelHistory.consumeRestore(block.id)
      consumedRestoreRef.current = {key: restoreKey, state: restore}
    }
    const scrollEl = scrollRef.current
    if (!scrollEl) return
    // A history snapshot answers for itself. A visit that was scrolled but never
    // focused captured a `scrollTop` and no cursor — and `writePanelContent`
    // then MANUFACTURES a cursor on the destination's top-level block, so
    // peeking at the pane here would read that invention and anchor to the top,
    // throwing away the offset the snapshot exists to replay. That case is the
    // norm for anyone who scrolls without clicking, since scrolling alone never
    // creates a cursor.
    const location = restore ? restore.focusedLocation : peekFocusedBlockLocation(block)
    const scrollTop = restore?.scrollTop ?? block.peekProperty(scrollTopProp)
    if (location) {
      // The offset rides along as the floor, not as the alternative: a cursor
      // whose row can never be re-resolved (see `fallbackScrollTop`) would
      // otherwise strand the pane at the top, which is worse than the pixel
      // restore this replaced.
      return alignScrollportToRow(scrollEl, location, {
        ...(scrollTop != null ? {fallbackScrollTop: scrollTop} : {}),
      })
    }
    if (scrollTop != null) scrollEl.scrollTop = scrollTop
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
      {/* `|| panelMaximized`: a flag must never be unclearable from the pane
          that carries it. `canMaximizePanel` goes false whenever maximizing
          would be pointless — mobile, or the siblings closed down to one —
          and a pane that got flagged BEFORE that would otherwise keep its
          state with no way to drop it. */}
      {(canMaximizePanel || panelMaximized) && (
        <Button
          variant="ghost"
          size="icon"
          className={PANEL_ACTION_BUTTON_CLASS}
          onFocus={trackPanelFocus ? activatePanel : undefined}
          onClick={() => {
            void togglePanelMaximized(repo, block.id, {canRenderSplit: !isMobileViewport()})
          }}
          aria-label={panelMaximized ? 'Restore panel' : 'Maximize panel'}
          title={panelMaximized ? 'Restore panel' : 'Maximize panel'}
        >
          {panelMaximized ? <Minimize2 className="h-4 w-4"/> : <Maximize2 className="h-4 w-4"/>}
        </Button>
      )}
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
    // panelViewMode rides the context so renderer resolution (useRenderer /
    // canRender) can pick a mode-specific renderer for the top-level block.
    // NOTE: NestedBlockContextProvider children INHERIT context, so nested
    // BlockComponents see the field too unless a renderer clears it —
    // VideoNotesLayout does exactly that around its notes region.
    <NestedBlockContextProvider
      overrides={{
        layoutBoundary: false,
        renderScopeId: panelRenderScopeId(block.id, topLevelBlockId),
        scopeRootId: topLevelBlockId,
        panelViewMode,
      }}
    >
      <BlockComponent blockId={topLevelBlockId}/>
    </NestedBlockContextProvider>
  )

  return (
    <div
      data-panel-id={block.id}
      data-panel-active={isActivePanel ? 'true' : undefined}
      onPointerDown={activatePanel}
      className={`panel min-w-0 max-w-full flex flex-col relative ${
        stackedPanel ? 'overflow-visible' : 'h-full flex-grow overflow-hidden'
      } ${isActivePanel ? 'panel-active' : ''}`}>
      {isActivePanel && <PanelMultiSelectActionContext scopeRootId={topLevelBlockId}/>}
      {/* Keeps this panel's focused row mounted even when it's still a lazy
          placeholder — see the component. Renders null. */}
      <FocusedRowLazyMount block={block} scopeRootId={topLevelBlockId}/>
      {/* Same always-mounted treatment as the content frame below, for the
          same reason — a conditional wrapper here remounts the buttons on the
          crossing, dropping keyboard focus if it happens to be on one. */}
      <div
        className={wideScrollSurface
          ? 'pointer-events-none absolute inset-x-0 top-1 z-10'
          : 'pointer-events-none absolute top-1 right-0.5 z-10 flex gap-0.5'}
      >
        <div
          className={wideScrollSurface
            ? 'pointer-events-none mx-auto flex w-full max-w-3xl justify-end gap-0.5'
            : 'contents'}
        >
          {actionButtons}
        </div>
      </div>
      <div
        ref={scrollRef}
        // Stable handle for the pane's scrollport. Runtime callers find it by
        // walking ancestors for a scrolling overflow (nearestScrollableAncestor),
        // which is robust to wrappers; this is for tests, so they don't pin the
        // chain depth and break when one is added.
        data-panel-scrollport=""
        className={stackedPanel ? 'overflow-visible' : 'flex-grow overflow-y-auto scrollbar-none pb-[calc(env(safe-area-inset-bottom)+4rem)] md:pb-0'}
        onPointerDownCapture={activatePanel}
        onFocusCapture={trackPanelFocus ? activatePanel : undefined}
        onScroll={scheduleScrollTopWrite}
      >
        {/* The content frame is ALWAYS mounted and swaps its class, rather
            than wrapping conditionally. `wideScrollSurface` flips whenever the
            layout crosses between one pane and several, and a conditional
            wrapper changes the element type at this position — so React
            unmounted and rebuilt the entire panel body on every first split
            and every collapse back. That threw away scroll position, editor
            state, and anything mid-playback, and on a big view (an agenda with
            thousands of rows) it is visible as a full reload. `contents`
            generates no box, so the non-wide layout is unchanged — but note it
            is still a real node for selector matching, so a `>` or
            `:nth-child()` rule anchored above the body must account for it. */}
        <div className={wideScrollSurface ? 'mx-auto w-full max-w-3xl' : 'contents'}>
          {panelBody}
        </div>
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
