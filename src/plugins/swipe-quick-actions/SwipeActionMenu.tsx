import { useCallback, useEffect, useLayoutEffect, useState, useRef, useMemo, type MouseEvent, type TouchEvent } from 'react'
import { createPortal } from 'react-dom'
import { MoreHorizontal } from 'lucide-react'
import { useIsMobile } from '@/utils/react.js'
import { useUIStateBlock } from '@/data/globalState'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { usePropertyValue } from '@/hooks/block.js'
import { getEffectiveActions } from '@/shortcuts/effectiveActions.js'
import { dispatchActionWithDeps } from '@/shortcuts/runAction.js'
import type { ActionConfig, ActionIcon } from '@/shortcuts/types.js'
import { topLevelBlockIdProp } from '@/data/properties.js'
import {
  quickActionItemsFacet,
  type QuickActionItem,
} from './actions.ts'
import {
  isSwipeQuickActionRunEvent,
  isSwipeQuickActionMenuEvent,
  isSwipeQuickActionProgressEvent,
  SWIPE_QUICK_ACTION_CLOSE_EVENT,
  SWIPE_QUICK_ACTION_OPEN_EVENT,
  SWIPE_QUICK_ACTION_PROGRESS_EVENT,
  SWIPE_QUICK_ACTION_RUN_EVENT,
} from './events.ts'
import {
  findSwipeActionBlockElement,
  findSwipeActionAnchorElement,
  getSwipeActionAnchorRect,
  type AnchorRect,
} from './anchor.ts'
import { SWIPE_TRIGGER_PX } from './swipeGesture.ts'

/** Track the swiped block content's bounding rect so the floating bar
 *  follows the visible text row, not the full block shell with open
 *  properties or children.
 *
 *  `panelRoot` scopes the lookup so the same block id rendered in
 *  another panel can't be picked up here — Codex's panel-disambiguation
 *  guard. The panel-local event listener means each panel's menu only
 *  opens from its own swiped block id, but the scope still matters inside
 *  one panel: if a block is transcluded via embed, renderScopeId narrows
 *  the lookup to the exact rendered occurrence. */
const useAnchorRect = (
  panelRoot: HTMLElement | null,
  blockId: string | undefined,
  renderScopeId: string | undefined,
): AnchorRect | null => {
  const [rect, setRect] = useState<AnchorRect | null>(null)

  // Reset stale rect on id/scope change synchronously during render —
  // the alternative (setRect in an effect body) is the cascading-render
  // anti-pattern that `react-hooks/set-state-in-effect` forbids.
  const trackedKey = blockId && panelRoot ? `${blockId}\u0000${renderScopeId ?? ''}` : null
  const [tracked, setTracked] = useState<string | null>(trackedKey)
  if (tracked !== trackedKey) {
    setTracked(trackedKey)
    setRect(null)
  }

  useLayoutEffect(() => {
    if (!panelRoot || !blockId) return

    const find = (): HTMLElement | null =>
      findSwipeActionAnchorElement(panelRoot, blockId, renderScopeId)

    const measure = (): void => {
      const nextRect = getSwipeActionAnchorRect(panelRoot, blockId, renderScopeId)
      if (!nextRect) {
        setRect(null)
        return
      }
      setRect(nextRect)
    }

    measure()

    // Capture `scroll` so containers anywhere in the ancestor chain (the
    // panel scroller, the document) refresh the anchor without us having
    // to find the right scroll parent.
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)

    let raf = 0
    const observer = new ResizeObserver(() => {
      // Coalesce — ResizeObserver fires synchronously on attribute writes
      // that other handlers in the same frame might also trigger.
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    })
    const targetEl = find()
    if (targetEl) observer.observe(targetEl)

    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [panelRoot, blockId, renderScopeId])

  return rect
}

interface ResolvedQuickAction {
  item: QuickActionItem
  /** The matched effective action, or undefined if unknown
   *  (mis-configured plugin reference). The button still renders so the
   *  miss is visible — clicking surfaces the same console error. */
  action: ActionConfig | undefined
  Icon: ActionIcon | undefined
  label: string
}

const TOOLBAR_ROW_HEIGHT_PX = 28

/** Drag distance at which the toolbar is fully revealed during a
 *  preview. Intentionally larger than `SWIPE_TRIGGER_PX` so releasing
 *  at the commit threshold still has room for a satisfying "complete
 *  the appearance" snap (think the Workflowy left-swipe pull-out). */
const PREVIEW_FULL_REVEAL_PX = 100

/** Duration of the snap-to-resting-state animation after the finger
 *  lifts. Long enough to read, short enough to feel responsive. */
const SETTLE_DURATION_MS = 200

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

/** Map an opening-drag delta (dx ≤ 0) to the toolbar's hide percent —
 *  0 = fully visible, 100 = parked off-screen right. */
const computeOpenHidePercent = (dx: number): number =>
  clamp(100 + (dx / PREVIEW_FULL_REVEAL_PX) * 100, 0, 100)

/** Same mapping for a close-drag on an already-open menu (dx ≥ 0). */
const computeCloseHidePercent = (dx: number): number =>
  clamp((dx / PREVIEW_FULL_REVEAL_PX) * 100, 0, 100)

/** Build a render-ready view for the toolbar from `(items, registry)`,
 *  so the JSX below stays focused on layout. */
const resolveActions = (
  items: readonly QuickActionItem[],
  registry: readonly ActionConfig[],
): readonly ResolvedQuickAction[] => items.map(item => {
  const action = registry.find(a => a.id === item.actionId)
  return {
    item,
    action,
    Icon: action?.icon,
    label: item.label ?? action?.description ?? item.actionId,
  }
})

const swipeTargetKey = (
  blockId: string | null | undefined,
  renderScopeId: string | undefined,
): string | null =>
  blockId ? `${blockId}\u0000${renderScopeId ?? ''}` : null

const sameSwipeTarget = (
  leftBlockId: string | null | undefined,
  leftRenderScopeId: string | undefined,
  rightBlockId: string | null | undefined,
  rightRenderScopeId: string | undefined,
): boolean =>
  leftBlockId === rightBlockId && leftRenderScopeId === rightRenderScopeId

interface MenuTouchStart {
  x: number
  y: number
  identifier: number
}

type MenuTouchPoint = Pick<MenuTouchStart, 'identifier'> & {
  clientX: number
  clientY: number
}

interface ActionButtonProps {
  resolved: ResolvedQuickAction
  onRun: (resolved: ResolvedQuickAction) => void
}

const ActionButton = ({resolved, onRun}: ActionButtonProps) => {
  const {Icon, label, item} = resolved
  const hasIcon = Boolean(Icon)
  // Single onClick: a touch tap synthesizes touchend → pointerup → click,
  // so listening on both `pointerup` and `click` would fire the action
  // twice (and toggle-style state would cancel itself out — see commit
  // history). `click` covers touch, mouse, and Enter/Space for keyboard.
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    onRun(resolved)
  }

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-block-interaction="ignore"
      onClick={handleClick}
      className={`flex h-7 items-center justify-center rounded transition-colors active:bg-accent ${
        hasIcon
          ? 'w-7'
          : 'min-w-11 max-w-[5.5rem] px-2 text-[11px] font-medium leading-none'
      } ${
        item.destructive
          ? 'text-destructive hover:bg-destructive/10 active:bg-destructive/20'
          : 'text-foreground hover:bg-muted'
      }`}
    >
      {Icon ? (
        <Icon className="h-4 w-4"/>
      ) : (
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
      )}
    </button>
  )
}

/** Floating action bar that appears when a block in this panel is
 *  swiped left. Mounted via `blockHeaderFacet` on each panel's
 *  top-level block, so each panel has its own independent menu and
 *  the same block id rendered in two panels can't confuse anchoring.
 *
 *  Mobile-only: desktop has a right-click context menu on the bullet,
 *  and the gesture handler likewise gates on mobile by virtue of not
 *  firing without touch input — this component just hides outright to
 *  avoid mounting cost on desktop.
 *
 *  `blockHeaderFacet` passes a `{block}` prop (the panel row); we read
 *  the same panel's UI-state block only for action dependencies and keep
 *  the currently open menu target in local React state. */
export const SwipeActionMenu = () => {
  const isMobile = useIsMobile()
  const uiStateBlock = useUIStateBlock()
  const repo = uiStateBlock.repo
  const runtime = useAppRuntime()
  const [topLevelBlockId] = usePropertyValue(uiStateBlock, topLevelBlockIdProp)
  const [activeBlockId, setActiveBlockId] = useState<string | undefined>(undefined)
  const [activeRenderScopeId, setActiveRenderScopeId] = useState<string | undefined>(undefined)
  // Inline anchor placed inside the panel; we walk upward to find the
  // panel root and scope querySelector to it so the same block id in
  // another panel can't be picked up.
  const inlineAnchorRef = useRef<HTMLDivElement | null>(null)
  const [panelRoot, setPanelRoot] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    setPanelRoot(inlineAnchorRef.current?.closest<HTMLElement>('.panel') ?? null)
  }, [])

  // Block currently being "previewed" — i.e. the user has started a
  // leftward swipe and the toolbar is following the finger but the
  // gesture hasn't committed yet. Set independently of activeBlockId so
  // we can anchor and render the toolbar before commit.
  const [previewBlockId, setPreviewBlockId] = useState<string | null>(null)
  const [previewRenderScopeId, setPreviewRenderScopeId] = useState<string | undefined>(undefined)
  // Live hide percent (0..100). `null` means "use the resting position
  // for the current activeBlockId" — i.e. 0 if open, 100 if not. While
  // a drag is in flight or the menu is settling, this carries the
  // intermediate value so the toolbar can track the finger / animate.
  const [dragOffsetPercent, setDragOffsetPercent] = useState<number | null>(null)
  // True while the toolbar is animating to its resting position
  // (released without commit, committed mid-preview, dismissing). The
  // CSS transition is gated on this flag — during the drag itself it
  // must be off so the transform tracks the finger exactly.
  const [isSettling, setIsSettling] = useState(false)
  const settleTimerRef = useRef<number | null>(null)
  // Tracked for the settle timer: if the timer fires while still
  // pointed at 'closed', we need to drop activeBlockId.
  const settleTargetRef = useRef<'open' | 'closed' | null>(null)

  // Anchor to the previewed block before commit so the toolbar lines
  // up with the row the user is dragging on; fall through to the
  // committed activeBlockId once the gesture lands.
  const anchorBlockId = previewBlockId ?? activeBlockId
  const anchorRenderScopeId = previewBlockId ? previewRenderScopeId : activeRenderScopeId
  const anchor = useAnchorRect(
    isMobile ? panelRoot : null,
    isMobile ? anchorBlockId : undefined,
    isMobile ? anchorRenderScopeId : undefined,
  )
  const [showOverflow, setShowOverflow] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const menuTouchStartRef = useRef<MenuTouchStart | null>(null)

  const clearSettleTimer = useCallback((): void => {
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current)
      settleTimerRef.current = null
    }
    settleTargetRef.current = null
  }, [])

  // Kick off a settle animation toward the given resting state. On
  // timer end we tear down preview state and, for 'closed', drop the
  // active block so the menu unmounts.
  const startSettle = useCallback((target: 'open' | 'closed'): void => {
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current)
    }
    settleTargetRef.current = target
    setIsSettling(true)
    setDragOffsetPercent(target === 'open' ? 0 : 100)
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null
      const finalTarget = settleTargetRef.current
      settleTargetRef.current = null
      setIsSettling(false)
      setPreviewBlockId(null)
      setPreviewRenderScopeId(undefined)
      setDragOffsetPercent(null)
      if (finalTarget === 'closed') {
        setActiveBlockId(undefined)
        setActiveRenderScopeId(undefined)
      }
    }, SETTLE_DURATION_MS)
  }, [])

  // Clear any in-flight settle on unmount AND on panel navigation.
  // Without the topLevelBlockId dependency, a settle scheduled in the
  // previous panel scope could fire after the user has opened a fresh
  // menu in the new scope and reset `activeBlockId`, closing the new
  // menu unexpectedly.
  useEffect(() => () => clearSettleTimer(), [clearSettleTimer, topLevelBlockId])

  const dismiss = useCallback((): void => {
    clearSettleTimer()
    setActiveBlockId(undefined)
    setActiveRenderScopeId(undefined)
    setPreviewBlockId(null)
    setPreviewRenderScopeId(undefined)
    setDragOffsetPercent(null)
    setIsSettling(false)
  }, [clearSettleTimer])

  // Resolve action metadata once per runtime — the registries are stable
  // across renders so this is effectively a one-time lookup that lets
  // every render re-use the same icon / label.
  const allActions = useMemo(() => getEffectiveActions(runtime), [runtime])
  const runBlockAction = useCallback((
    actionId: string,
    blockId: string,
    renderScopeId: string | undefined,
    trigger: CustomEvent,
  ): boolean => {
    const block = repo.block(blockId)
    // Swipe runs actions imperatively (outside a block's React context), so
    // scopeRootId isn't injected by useShortcutSurfaceActivations. The menu is
    // panel-scoped and operates on the main outline, so the panel's top-level
    // block is the scope root — the same value the structural handlers need
    // (delete/indent/move). The gesture supplies these deps through the unified
    // dispatch path (resolveDeps validation + canDispatch gate + error logging)
    // rather than looking the action up and invoking its handler directly. The
    // returned boolean tells the gesture whether to preventDefault / fall back.
    const deps = {block, uiStateBlock, scopeRootId: topLevelBlockId, ...(renderScopeId ? {renderScopeId} : {})}
    return dispatchActionWithDeps(actionId, deps, trigger)
  }, [repo, uiStateBlock, topLevelBlockId])
  const actionItems = runtime.read(quickActionItemsFacet)
  // Filter via the referenced action's `isVisible` (the swipe surface is
  // presentational — semantic availability lives on the action). The
  // filter runs at menu-open time, not reactively. Items whose action
  // isn't registered fall through so the missing-action error is still
  // visible on click.
  const visibleItems = useMemo(() => {
    // Filter against the previewed block too so the buttons that slide
    // in during the drag match the ones that'll be there after commit.
    const blockId = activeBlockId ?? previewBlockId
    const renderScopeId = activeBlockId ? activeRenderScopeId : previewRenderScopeId
    if (!blockId) return actionItems
    const block = repo.block(blockId)
    if (!block.peek()) return actionItems
    const deps = {block, uiStateBlock, scopeRootId: topLevelBlockId, ...(renderScopeId ? {renderScopeId} : {})}
    return actionItems.filter(item => {
      const action = allActions.find(a => a.id === item.actionId)
      if (!action) return true
      if (!action.isVisible) return true
      return action.isVisible(deps)
    })
  }, [
    actionItems, allActions,
    activeBlockId, activeRenderScopeId,
    previewBlockId, previewRenderScopeId,
    repo, uiStateBlock, topLevelBlockId,
  ])
  const [primaryRows, overflowItems] = useMemo(() => {
    const rows = new Map<number, QuickActionItem[]>()
    const overflow: QuickActionItem[] = []
    for (const item of visibleItems) {
      if (item.overflow) overflow.push(item)
      else {
        const row = item.row ?? 1
        const existing = rows.get(row)
        if (existing) existing.push(item)
        else rows.set(row, [item])
      }
    }
    return [
      [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, items]) => items),
      overflow,
    ] as const
  }, [visibleItems])
  const primaryRowsResolved = useMemo(
    () => primaryRows.map(items => resolveActions(items, allActions)),
    [primaryRows, allActions],
  )
  const overflowResolved = useMemo(
    () => resolveActions(overflowItems, allActions),
    [overflowItems, allActions],
  )

  // Close the overflow popout whenever the active block changes, so a
  // re-swipe on a different row doesn't carry stale popout state. Done
  // during render rather than in an effect to avoid the cascading-render
  // anti-pattern flagged by `react-hooks/set-state-in-effect`.
  const activeTargetKey = swipeTargetKey(activeBlockId, activeRenderScopeId)
  const [trackedActiveTargetKey, setTrackedActiveTargetKey] = useState(activeTargetKey)
  if (trackedActiveTargetKey !== activeTargetKey) {
    setTrackedActiveTargetKey(activeTargetKey)
    if (showOverflow) setShowOverflow(false)
  }

  const [trackedTopLevelBlockId, setTrackedTopLevelBlockId] = useState(topLevelBlockId)
  if (trackedTopLevelBlockId !== topLevelBlockId) {
    setTrackedTopLevelBlockId(topLevelBlockId)
    // Panel navigated mid-gesture: drop visible state synchronously
    // (we don't want a leftover preview rendering against an unrelated
    // block in the new panel scope). A pending settle timer will still
    // fire but its setState calls are no-ops once everything is
    // already cleared, so we don't reach into the ref from render.
    if (activeBlockId) setActiveBlockId(undefined)
    if (activeRenderScopeId) setActiveRenderScopeId(undefined)
    if (previewBlockId !== null) setPreviewBlockId(null)
    if (previewRenderScopeId) setPreviewRenderScopeId(undefined)
    if (dragOffsetPercent !== null) setDragOffsetPercent(null)
    if (isSettling) setIsSettling(false)
  }

  useEffect(() => {
    if (!panelRoot) return

    const handleOpen = (event: Event): void => {
      if (!isSwipeQuickActionMenuEvent(event)) return
      event.preventDefault()
      const {blockId, renderScopeId} = event.detail
      setActiveBlockId(blockId)
      setActiveRenderScopeId(renderScopeId)
      // If the open came after a preview of the same block, animate
      // the toolbar's remaining offset to fully visible — the
      // "completes appearing" snap. Otherwise no animation is needed:
      // either we weren't previewing or we were previewing a different
      // block (rare), and the menu should just appear at rest.
      if (
        sameSwipeTarget(previewBlockId, previewRenderScopeId, blockId, renderScopeId) &&
        dragOffsetPercent !== null
      ) {
        startSettle('open')
      } else {
        clearSettleTimer()
        setPreviewBlockId(null)
        setPreviewRenderScopeId(undefined)
        setDragOffsetPercent(null)
        setIsSettling(false)
      }
    }

    const handleClose = (event: Event): void => {
      if (!isSwipeQuickActionMenuEvent(event)) return
      if (!sameSwipeTarget(
        event.detail.blockId,
        event.detail.renderScopeId,
        activeBlockId,
        activeRenderScopeId,
      )) return
      event.preventDefault()
      startSettle('closed')
    }

    const handleRun = (event: Event): void => {
      if (!isSwipeQuickActionRunEvent(event)) return
      if (!runBlockAction(
        event.detail.actionId,
        event.detail.blockId,
        event.detail.renderScopeId,
        event,
      )) return
      event.preventDefault()
    }

    const handleProgress = (event: Event): void => {
      if (!isSwipeQuickActionProgressEvent(event)) return
      const {blockId, renderScopeId, dx, phase} = event.detail
      if (phase === 'active') {
        // Drag still in flight — follow the finger without animation.
        // Re-grabbing a different block mid-gesture just retargets.
        clearSettleTimer()
        setIsSettling(false)
        setPreviewBlockId(blockId)
        setPreviewRenderScopeId(renderScopeId)
        setDragOffsetPercent(computeOpenHidePercent(dx))
      } else if (
        phase === 'cancel' &&
        sameSwipeTarget(previewBlockId, previewRenderScopeId, blockId, renderScopeId)
      ) {
        // Released without commit — animate the toolbar back to hidden.
        startSettle('closed')
      }
    }

    panelRoot.addEventListener(SWIPE_QUICK_ACTION_OPEN_EVENT, handleOpen)
    panelRoot.addEventListener(SWIPE_QUICK_ACTION_CLOSE_EVENT, handleClose)
    panelRoot.addEventListener(SWIPE_QUICK_ACTION_RUN_EVENT, handleRun)
    panelRoot.addEventListener(SWIPE_QUICK_ACTION_PROGRESS_EVENT, handleProgress)
    return () => {
      panelRoot.removeEventListener(SWIPE_QUICK_ACTION_OPEN_EVENT, handleOpen)
      panelRoot.removeEventListener(SWIPE_QUICK_ACTION_CLOSE_EVENT, handleClose)
      panelRoot.removeEventListener(SWIPE_QUICK_ACTION_RUN_EVENT, handleRun)
      panelRoot.removeEventListener(SWIPE_QUICK_ACTION_PROGRESS_EVENT, handleProgress)
    }
  }, [
    activeBlockId, activeRenderScopeId,
    dragOffsetPercent,
    panelRoot,
    previewBlockId, previewRenderScopeId,
    runBlockAction, startSettle, clearSettleTimer,
  ])

  useEffect(() => {
    if (!activeBlockId || !isMobile || !panelRoot) return

    const id = window.setTimeout(() => {
      const anchorElement = findSwipeActionBlockElement(
        panelRoot,
        activeBlockId,
        activeRenderScopeId,
      )
      const block = repo.block(activeBlockId)
      if (!anchorElement || !block.peek()) dismiss()
    }, 0)

    return () => window.clearTimeout(id)
  }, [activeBlockId, activeRenderScopeId, dismiss, isMobile, panelRoot, repo])

  // Dismiss on tap/click anywhere outside the floating bar. Capture phase
  // beats descendant click handlers so an action elsewhere in the tree
  // doesn't fire alongside the dismiss.
  useEffect(() => {
    if (!activeBlockId) return

    const handlePointer = (event: PointerEvent | MouseEvent | globalThis.MouseEvent) => {
      const target = event.target as Node | null
      if (target && containerRef.current?.contains(target)) return
      dismiss()
    }

    // Defer attach by a microtask so the same touchend that opened the
    // menu doesn't immediately dismiss it.
    const id = window.setTimeout(() => {
      document.addEventListener('pointerdown', handlePointer, true)
    }, 0)

    return () => {
      window.clearTimeout(id)
      document.removeEventListener('pointerdown', handlePointer, true)
    }
  }, [activeBlockId, dismiss])

  // Dismiss on Escape — keyboard accessibility for hybrid devices.
  useEffect(() => {
    if (!activeBlockId) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [activeBlockId, dismiss])

  // Always render the inline anchor (zero-size, invisible) so we have a
  // ref into this panel's DOM regardless of menu state.
  const inlineAnchor = (
    <div ref={inlineAnchorRef} className="swipe-action-menu-anchor" aria-hidden="true"/>
  )

  // Render whenever the menu is committed OR a swipe preview is in
  // flight. The preview branch lets the toolbar slide in tracking the
  // finger before commit, matching the Workflowy-style pull-out.
  const renderedBlockId = activeBlockId ?? previewBlockId
  const renderedRenderScopeId = activeBlockId ? activeRenderScopeId : previewRenderScopeId
  if (!isMobile || !renderedBlockId || !anchor) return inlineAnchor

  // The block whose handler we'll dispatch lives in this panel; resolve
  // it via the same repo that owns uiStateBlock. Buttons only become
  // tappable once activeBlockId is set, so a preview can safely
  // reference a block that might disappear between drag and commit.
  const block = repo.block(renderedBlockId)
  if (!block.peek()) return inlineAnchor

  /** Dispatch the resolved action's handler with our block-level deps.
   *  We call the handler directly rather than going through
   *  `useRunAction` because the dispatcher requires the action's context
   *  to be active (e.g. NORMAL_MODE), and the swipe gesture is itself
   *  the activation. The handler is the same one the keyboard binding
   *  invokes, so semantics (focus restoration, etc.) stay in lockstep. */
  const handleRun = (resolved: ResolvedQuickAction): void => {
    const {item, action} = resolved
    if (!action) {
      console.error(`[swipe-quick-actions] Action "${item.actionId}" not registered`)
      dismiss()
      return
    }
    const trigger = new CustomEvent('swipe-quick-action', {
      detail: renderedRenderScopeId
        ? {
          actionId: item.actionId,
          blockId: block.id,
          renderScopeId: renderedRenderScopeId,
        }
        : {actionId: item.actionId, blockId: block.id},
    })
    runBlockAction(item.actionId, block.id, renderedRenderScopeId, trigger)
    dismiss()
  }

  const trackedMenuTouch = (event: TouchEvent): MenuTouchPoint | null => {
    const start = menuTouchStartRef.current
    if (!start) return null
    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches[i]
      if (touch.identifier === start.identifier) return touch
    }
    return null
  }

  // Block touch events from bubbling to the underlying block so the
  // gesture contribution doesn't see a touch on the menu and reopen /
  // re-trigger anything. A rightward swipe on the menu mirrors the
  // block-surface close gesture.
  const handleMenuTouchStart = (event: TouchEvent) => {
    event.stopPropagation()
    const touch = event.changedTouches[0]
    if (!touch) return
    menuTouchStartRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      identifier: touch.identifier,
    }
  }

  const handleMenuTouchMove = (event: TouchEvent) => {
    event.stopPropagation()
    const touch = trackedMenuTouch(event)
    const start = menuTouchStartRef.current
    if (!touch || !start) return

    const dx = touch.clientX - start.x
    const dy = touch.clientY - start.y

    // Live-track the close-drag: as the finger moves right we slide
    // the menu out proportionally. Only kick in once the gesture is
    // clearly horizontal-rightward, otherwise vertical scroll-like
    // micromotion would jitter the offset.
    if (dx > 0 && Math.abs(dx) > Math.abs(dy)) {
      clearSettleTimer()
      setIsSettling(false)
      setDragOffsetPercent(computeCloseHidePercent(dx))
    }
  }

  const handleMenuTouchEnd = (event: TouchEvent) => {
    event.stopPropagation()
    const touch = trackedMenuTouch(event)
    const start = menuTouchStartRef.current
    if (!touch || !start) return

    menuTouchStartRef.current = null
    const dx = touch.clientX - start.x
    const dy = touch.clientY - start.y

    // Past commit threshold and clearly horizontal → animate fully out
    // and dismiss. Below threshold but with a live drag offset → snap
    // back to fully open. Otherwise the touch was a tap / scroll and
    // we leave the menu as-is.
    if (dx >= SWIPE_TRIGGER_PX && Math.abs(dx) > Math.abs(dy)) {
      event.preventDefault()
      startSettle('closed')
    } else if (dragOffsetPercent !== null) {
      startSettle('open')
    }
  }

  const handleMenuTouchCancel = (event: TouchEvent) => {
    event.stopPropagation()
    if (trackedMenuTouch(event)) {
      menuTouchStartRef.current = null
      // If the drag put the menu mid-way out, recover to fully open.
      if (dragOffsetPercent !== null) startSettle('open')
    }
  }

  // Align the strip's vertical center to the swiped row's center so it
  // replaces one normal text row (Workflowy-style), while spanning the
  // viewport horizontally.
  const toolbarHeight = Math.max(primaryRowsResolved.length, 1) * TOOLBAR_ROW_HEIGHT_PX
  const centerY = anchor.top + anchor.height / 2
  const toolbarTop = Math.min(
    Math.max(centerY, toolbarHeight / 2),
    window.innerHeight - toolbarHeight / 2,
  )

  // Compose translateY(-50%) for vertical-row centering with translateX
  // for the swipe reveal. The hide percent is 0 when the menu is at
  // rest open, 100 when fully parked off-screen right, and a live value
  // in between while dragging or settling.
  const hidePercent = dragOffsetPercent ?? (activeBlockId ? 0 : 100)
  const toolbarTransform = `translate(${hidePercent}%, -50%)`
  const toolbarTransition = isSettling
    ? `transform ${SETTLE_DURATION_MS}ms ease-out`
    : undefined

  return (
    <>
      {inlineAnchor}
      {createPortal(
        <div
          ref={containerRef}
          className="swipe-action-menu fixed left-0 right-0 z-50"
          style={{
            top: `${toolbarTop}px`,
            transform: toolbarTransform,
            transition: toolbarTransition,
            // Hint the compositor while a drag is in flight; once
            // settled we drop the hint so the browser can recycle the
            // layer.
            willChange: dragOffsetPercent !== null ? 'transform' : undefined,
          }}
          data-block-interaction="ignore"
          onTouchStart={handleMenuTouchStart}
          onTouchMove={handleMenuTouchMove}
          onTouchEnd={handleMenuTouchEnd}
          onTouchCancel={handleMenuTouchCancel}
        >
          <div className="w-full border-y border-border bg-background/95 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/85">
            {primaryRowsResolved.map((rowResolved, rowIndex) => (
              <div
                key={`row-${rowIndex}`}
                className={`flex h-7 items-center justify-around px-4 ${rowIndex > 0 ? 'border-t border-border/80' : ''}`}
              >
                {rowResolved.map(resolved => (
                  <ActionButton
                    key={resolved.item.actionId}
                    resolved={resolved}
                    onRun={handleRun}
                  />
                ))}
                {rowIndex === 0 && overflowResolved.length > 0 && (
                  <button
                    type="button"
                    aria-label="More actions"
                    title="More actions"
                    aria-expanded={showOverflow}
                    data-block-interaction="ignore"
                    onClick={event => {
                      event.preventDefault()
                      event.stopPropagation()
                      setShowOverflow(prev => !prev)
                    }}
                    className="flex h-7 w-7 items-center justify-center rounded text-foreground hover:bg-muted active:bg-accent"
                  >
                    <MoreHorizontal className="h-4 w-4"/>
                  </button>
                )}
              </div>
            ))}
          </div>

          {showOverflow && overflowResolved.length > 0 && (
            <div
              // Absolutely positioned so the toolbar stays vertically
              // anchored to the swiped row when the overflow opens —
              // without this, the -translate-y-1/2 above would re-center
              // the now-taller toolbar+overflow container and shift the
              // toolbar off the row.
              className="absolute right-2 top-full mt-1 flex flex-col gap-0.5 rounded-md border border-border bg-background/95 p-0.5 shadow-md backdrop-blur supports-[backdrop-filter]:bg-background/85"
            >
              {overflowResolved.map(resolved => {
                const {Icon, label, item} = resolved
                return (
                  <button
                    key={item.actionId}
                    type="button"
                    aria-label={label}
                    data-block-interaction="ignore"
                    onClick={event => {
                      event.preventDefault()
                      event.stopPropagation()
                      handleRun(resolved)
                    }}
                    className="flex items-center gap-2 rounded-md px-2 py-2 text-sm text-foreground hover:bg-muted active:bg-accent"
                  >
                    {Icon && <Icon className="h-4 w-4"/>}
                    <span>{label}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
