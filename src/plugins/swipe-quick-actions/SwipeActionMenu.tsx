import { useCallback, useEffect, useLayoutEffect, useState, useRef, useMemo, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { Circle, MoreHorizontal, X } from 'lucide-react'
import { useIsMobile } from '@/utils/react.tsx'
import { useUIStateBlock } from '@/data/globalState'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { actionsFacet } from '@/extensions/core.ts'
import { usePropertyValue } from '@/hooks/block.ts'
import type { ActionConfig, ActionIcon } from '@/shortcuts/types.ts'
import { topLevelBlockIdProp } from '@/data/properties.ts'
import {
  quickActionItemsFacet,
  type QuickActionItem,
} from './actions.ts'
import {
  isSwipeQuickActionMenuEvent,
  SWIPE_QUICK_ACTION_CLOSE_EVENT,
  SWIPE_QUICK_ACTION_OPEN_EVENT,
} from './events.ts'

interface AnchorRect {
  top: number
  height: number
  right: number
}

/** Track the swiped block's bounding rect so the floating bar follows
 *  it across scroll / re-layouts (e.g. mid-flight property toggles).
 *
 *  `panelRoot` scopes the lookup so the same block id rendered in
 *  another panel can't be picked up here — Codex's panel-disambiguation
 *  guard. The panel-local event listener means each panel's menu only
 *  opens from its own swiped block id, but the scope still matters inside
 *  one panel: if a block is transcluded via embed, querySelector picks the
 *  first match and we accept that as the anchor target. */
const useAnchorRect = (
  panelRoot: HTMLElement | null,
  blockId: string | undefined,
): AnchorRect | null => {
  const [rect, setRect] = useState<AnchorRect | null>(null)

  // Reset stale rect on id/scope change synchronously during render —
  // the alternative (setRect in an effect body) is the cascading-render
  // anti-pattern that `react-hooks/set-state-in-effect` forbids.
  const trackedKey = blockId && panelRoot ? `${blockId}` : null
  const [tracked, setTracked] = useState<string | null>(trackedKey)
  if (tracked !== trackedKey) {
    setTracked(trackedKey)
    setRect(null)
  }

  useLayoutEffect(() => {
    if (!panelRoot || !blockId) return

    const find = (): HTMLElement | null =>
      panelRoot.querySelector<HTMLElement>(blockSelector(blockId))

    const measure = (): void => {
      const element = find()
      if (!element) {
        setRect(null)
        return
      }
      const r = element.getBoundingClientRect()
      setRect({top: r.top, height: r.height, right: r.right})
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
  }, [panelRoot, blockId])

  return rect
}

interface ResolvedQuickAction {
  item: QuickActionItem
  /** The matched action from `actionsFacet`, or undefined if unknown
   *  (mis-configured plugin reference). The button still renders so the
   *  miss is visible — clicking surfaces the same console error. */
  action: ActionConfig | undefined
  Icon: ActionIcon
  label: string
}

const FallbackIcon: ActionIcon = (props) => <Circle {...props}/>

const TOOLBAR_HEIGHT_PX = 28

const blockSelector = (blockId: string): string =>
  `[data-block-id="${CSS.escape(blockId)}"]`

/** Build a render-ready view for the toolbar from `(items, registry)`,
 *  so the JSX below stays focused on layout. */
const useResolvedActions = (
  items: readonly QuickActionItem[],
  registry: readonly ActionConfig[],
): readonly ResolvedQuickAction[] => useMemo(() => items.map(item => {
  const action = registry.find(a => a.id === item.actionId)
  return {
    item,
    action,
    Icon: action?.icon ?? FallbackIcon,
    label: item.label ?? action?.description ?? item.actionId,
  }
}), [items, registry])

interface ActionButtonProps {
  resolved: ResolvedQuickAction
  onRun: (resolved: ResolvedQuickAction) => void
}

const ActionButton = ({resolved, onRun}: ActionButtonProps) => {
  const {Icon, label, item} = resolved
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
      className={`flex h-7 w-7 items-center justify-center rounded transition-colors active:bg-accent ${
        item.destructive
          ? 'text-destructive hover:bg-destructive/10 active:bg-destructive/20'
          : 'text-foreground hover:bg-muted'
      }`}
    >
      <Icon className="h-4 w-4"/>
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
  // Inline anchor placed inside the panel; we walk upward to find the
  // panel root and scope querySelector to it so the same block id in
  // another panel can't be picked up.
  const inlineAnchorRef = useRef<HTMLDivElement | null>(null)
  const [panelRoot, setPanelRoot] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    setPanelRoot(inlineAnchorRef.current?.closest<HTMLElement>('.panel') ?? null)
  }, [])

  const anchor = useAnchorRect(
    isMobile ? panelRoot : null,
    isMobile ? activeBlockId : undefined,
  )
  const [showOverflow, setShowOverflow] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const dismiss = useCallback((): void => {
    setActiveBlockId(undefined)
  }, [])

  // Resolve action metadata once per runtime — the registries are stable
  // across renders so this is effectively a one-time lookup that lets
  // every render re-use the same icon / label.
  const allActions = runtime.read(actionsFacet)
  const actionItems = runtime.read(quickActionItemsFacet)
  const [primaryItems, overflowItems] = useMemo(() => {
    const primary: QuickActionItem[] = []
    const overflow: QuickActionItem[] = []
    for (const item of actionItems) {
      if (item.overflow) overflow.push(item)
      else primary.push(item)
    }
    return [primary, overflow] as const
  }, [actionItems])
  const primaryResolved = useResolvedActions(primaryItems, allActions)
  const overflowResolved = useResolvedActions(overflowItems, allActions)

  // Close the overflow popout whenever the active block changes, so a
  // re-swipe on a different row doesn't carry stale popout state. Done
  // during render rather than in an effect to avoid the cascading-render
  // anti-pattern flagged by `react-hooks/set-state-in-effect`.
  const [trackedActiveId, setTrackedActiveId] = useState(activeBlockId)
  if (trackedActiveId !== activeBlockId) {
    setTrackedActiveId(activeBlockId)
    if (showOverflow) setShowOverflow(false)
  }

  const [trackedTopLevelBlockId, setTrackedTopLevelBlockId] = useState(topLevelBlockId)
  if (trackedTopLevelBlockId !== topLevelBlockId) {
    setTrackedTopLevelBlockId(topLevelBlockId)
    if (activeBlockId) setActiveBlockId(undefined)
  }

  useEffect(() => {
    if (!panelRoot) return

    const handleOpen = (event: Event): void => {
      if (!isSwipeQuickActionMenuEvent(event)) return
      event.preventDefault()
      setActiveBlockId(event.detail.blockId)
    }

    const handleClose = (event: Event): void => {
      if (!isSwipeQuickActionMenuEvent(event)) return
      if (event.detail.blockId !== activeBlockId) return
      event.preventDefault()
      setActiveBlockId(undefined)
    }

    panelRoot.addEventListener(SWIPE_QUICK_ACTION_OPEN_EVENT, handleOpen)
    panelRoot.addEventListener(SWIPE_QUICK_ACTION_CLOSE_EVENT, handleClose)
    return () => {
      panelRoot.removeEventListener(SWIPE_QUICK_ACTION_OPEN_EVENT, handleOpen)
      panelRoot.removeEventListener(SWIPE_QUICK_ACTION_CLOSE_EVENT, handleClose)
    }
  }, [activeBlockId, panelRoot])

  useEffect(() => {
    if (!activeBlockId || !isMobile || !panelRoot) return

    const id = window.setTimeout(() => {
      const anchorElement = panelRoot.querySelector<HTMLElement>(blockSelector(activeBlockId))
      const block = repo.block(activeBlockId)
      if (!anchorElement || !block.peek()) dismiss()
    }, 0)

    return () => window.clearTimeout(id)
  }, [activeBlockId, dismiss, isMobile, panelRoot, repo])

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

  if (!isMobile || !activeBlockId || !anchor) return inlineAnchor

  // The block whose handler we'll dispatch lives in this panel; resolve
  // it from the active id via the same repo that owns uiStateBlock.
  const block = repo.block(activeBlockId)
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
      detail: {actionId: item.actionId},
    })
    void Promise.resolve(action.handler({block, uiStateBlock}, trigger)).catch(error => {
      console.error(`[swipe-quick-actions] Action "${item.actionId}" failed`, error)
    })
    dismiss()
  }

  // Block touch events from bubbling to the underlying block so the
  // gesture contribution doesn't see a touch on the menu and reopen /
  // re-trigger anything.
  const swallowTouch = (event: { stopPropagation: () => void }) => {
    event.stopPropagation()
  }

  // Align the strip's vertical center to the swiped row's center so it
  // replaces one normal text row (Workflowy-style), while spanning the
  // viewport horizontally.
  const centerY = anchor.top + anchor.height / 2
  const toolbarTop = Math.min(
    Math.max(centerY, TOOLBAR_HEIGHT_PX / 2),
    window.innerHeight - TOOLBAR_HEIGHT_PX / 2,
  )

  return (
    <>
      {inlineAnchor}
      {createPortal(
        <div
          ref={containerRef}
          className="swipe-action-menu fixed left-0 right-0 z-50 -translate-y-1/2"
          style={{top: `${toolbarTop}px`}}
          data-block-interaction="ignore"
          onTouchStart={swallowTouch}
          onTouchMove={swallowTouch}
          onTouchEnd={swallowTouch}
        >
          <div
            className="flex h-7 w-full items-center justify-around border-y border-border bg-background/95 px-4 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/85"
          >
            {primaryResolved.map(resolved => (
              <ActionButton
                key={resolved.item.actionId}
                resolved={resolved}
                onRun={handleRun}
              />
            ))}
            {overflowResolved.length > 0 && (
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
            <button
              type="button"
              aria-label="Close"
              title="Close"
              data-block-interaction="ignore"
              onClick={event => {
                event.preventDefault()
                event.stopPropagation()
                dismiss()
              }}
              className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted active:bg-accent"
            >
              <X className="h-4 w-4"/>
            </button>
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
                    <Icon className="h-4 w-4"/>
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
