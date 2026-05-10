import { useEffect, useLayoutEffect, useState, useRef, useMemo, type MouseEvent, type TouchEvent } from 'react'
import { createPortal } from 'react-dom'
import { Circle, MoreHorizontal, X } from 'lucide-react'
import { useIsMobile } from '@/utils/react.tsx'
import { useRepo } from '@/context/repo'
import { useUIStateBlock } from '@/data/globalState'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { actionsFacet } from '@/extensions/core.ts'
import type { ActionConfig, ActionIcon } from '@/shortcuts/types.ts'
import { useActiveSwipeBlockId, setActiveSwipeBlockId } from './store.ts'
import {
  PRIMARY_ACTIONS,
  OVERFLOW_ACTIONS,
  type QuickActionItem,
} from './actions.ts'

interface AnchorRect {
  top: number
  height: number
  right: number
}

/** Track the swiped block's bounding rect so the floating bar follows
 *  it across scroll / re-layouts (e.g. mid-flight property toggles). */
const useAnchorRect = (blockId: string | null): AnchorRect | null => {
  const [rect, setRect] = useState<AnchorRect | null>(null)

  // Reset stale rect on block-id change synchronously during render —
  // the alternative (setRect in an effect body) is the cascading-render
  // anti-pattern that `react-hooks/set-state-in-effect` forbids.
  const [trackedId, setTrackedId] = useState(blockId)
  if (trackedId !== blockId) {
    setTrackedId(blockId)
    setRect(null)
  }

  useLayoutEffect(() => {
    if (!blockId) return

    const measure = (): void => {
      const element = document.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"]`)
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
    const targetEl = document.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"]`)
    if (targetEl) observer.observe(targetEl)

    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [blockId])

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
  // Touch buttons need to defeat the default 300ms tap delay synthesis
  // and the synthetic click that fires after touchend — running on
  // `pointerup` keeps the action snappy and avoids a second invocation
  // when the synthesized click bubbles. The `onClick` mirror keeps
  // keyboard activation (Enter/Space) functional.
  const handlePointerUp = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
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
      onPointerUp={handlePointerUp}
      onClick={handlePointerUp}
      className={`flex h-10 w-10 items-center justify-center rounded-md transition-colors active:bg-accent ${
        item.destructive
          ? 'text-destructive hover:bg-destructive/10 active:bg-destructive/20'
          : 'text-foreground hover:bg-muted'
      }`}
    >
      <Icon className="h-5 w-5"/>
    </button>
  )
}

/** Floating action bar that appears when a block is swiped left.
 *  Anchored to the right edge of the swiped block; tap-outside or
 *  swipe-right dismisses (the latter handled by the gesture contribution).
 *
 *  Mobile-only: desktop already has a right-click context menu on the
 *  bullet, and the gesture handler likewise gates on mobile by virtue of
 *  not firing without touch input — this component just hides outright
 *  to avoid mounting cost on desktop. */
export const SwipeActionMenu = () => {
  const isMobile = useIsMobile()
  const activeBlockId = useActiveSwipeBlockId()
  const repo = useRepo()
  const uiStateBlock = useUIStateBlock()
  const runtime = useAppRuntime()
  const anchor = useAnchorRect(isMobile ? activeBlockId : null)
  const [showOverflow, setShowOverflow] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Resolve action metadata once per runtime — the registry is stable
  // across renders so this is effectively a one-time lookup that lets
  // every render re-use the same icon / label.
  const allActions = runtime.read(actionsFacet)
  const primaryResolved = useResolvedActions(PRIMARY_ACTIONS, allActions)
  const overflowResolved = useResolvedActions(OVERFLOW_ACTIONS, allActions)

  // Close the overflow popout whenever the active block changes, so a
  // re-swipe on a different row doesn't carry stale popout state. Done
  // during render rather than in an effect to avoid the cascading-render
  // anti-pattern flagged by `react-hooks/set-state-in-effect`.
  const [trackedActiveId, setTrackedActiveId] = useState(activeBlockId)
  if (trackedActiveId !== activeBlockId) {
    setTrackedActiveId(activeBlockId)
    if (showOverflow) setShowOverflow(false)
  }

  // Dismiss on tap/click anywhere outside the floating bar. Capture phase
  // beats descendant click handlers so an action elsewhere in the tree
  // doesn't fire alongside the dismiss.
  useEffect(() => {
    if (!activeBlockId) return

    const handlePointer = (event: PointerEvent | MouseEvent | globalThis.MouseEvent) => {
      const target = event.target as Node | null
      if (target && containerRef.current?.contains(target)) return
      setActiveSwipeBlockId(null)
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
  }, [activeBlockId])

  // Dismiss on Escape — keyboard accessibility for hybrid devices.
  useEffect(() => {
    if (!activeBlockId) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActiveSwipeBlockId(null)
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [activeBlockId])

  if (!isMobile || !activeBlockId || !anchor) return null

  const block = repo.block(activeBlockId)
  // The gesture handler doesn't fire for unloaded blocks (the user has to
  // see them to swipe them), but be defensive anyway — repo.block is a
  // synchronous handle that returns even for unknown ids.
  if (!block.peek()) return null

  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) return null

  /** Dispatch the resolved action's handler with our block-level deps.
   *  We call the handler directly rather than going through `useRunAction`
   *  because the dispatcher requires the action's context to be active
   *  (e.g. NORMAL_MODE), and the swipe gesture is itself the activation.
   *  The handler is the same one the keyboard binding invokes, so
   *  semantics (focus restoration, etc.) stay in lockstep. */
  const handleRun = (resolved: ResolvedQuickAction): void => {
    const {item, action} = resolved
    if (!action) {
      console.error(`[swipe-quick-actions] Action "${item.actionId}" not registered`)
      setActiveSwipeBlockId(null)
      return
    }
    const trigger = new CustomEvent('swipe-quick-action', {
      detail: {actionId: item.actionId},
    })
    void Promise.resolve(action.handler({block, uiStateBlock}, trigger)).catch(error => {
      console.error(`[swipe-quick-actions] Action "${item.actionId}" failed`, error)
    })
    setActiveSwipeBlockId(null)
  }

  // Block touch events from bubbling to the underlying block so the
  // gesture contribution doesn't see a touch on the menu and reopen /
  // re-trigger anything.
  const swallowTouch = (event: TouchEvent) => {
    event.stopPropagation()
  }

  // Pin to the right edge of the viewport, vertically centered on the
  // swiped block. The block's `right` is the rightmost pixel of its
  // bounding box; we anchor the bar's right edge to the viewport's
  // right edge minus a small inset so the bar sits in the empty
  // gutter even when the block extends close to the edge.
  const top = anchor.top + anchor.height / 2

  return createPortal(
    <div
      ref={containerRef}
      className="swipe-action-menu fixed z-50 -translate-y-1/2"
      style={{top: `${top}px`, right: '8px'}}
      data-block-interaction="ignore"
      onTouchStart={swallowTouch}
      onTouchMove={swallowTouch}
      onTouchEnd={swallowTouch}
    >
      <div
        className="flex items-center gap-1 rounded-lg border border-border bg-background/95 p-1 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/85"
      >
        {primaryResolved.map(resolved => (
          <ActionButton
            key={resolved.item.actionId}
            resolved={resolved}
            onRun={handleRun}
          />
        ))}
        <button
          type="button"
          aria-label="More actions"
          title="More actions"
          aria-expanded={showOverflow}
          data-block-interaction="ignore"
          onPointerUp={event => {
            event.preventDefault()
            event.stopPropagation()
            setShowOverflow(prev => !prev)
          }}
          onClick={event => {
            event.preventDefault()
            event.stopPropagation()
            setShowOverflow(prev => !prev)
          }}
          className="flex h-10 w-10 items-center justify-center rounded-md text-foreground hover:bg-muted active:bg-accent"
        >
          <MoreHorizontal className="h-5 w-5"/>
        </button>
        <button
          type="button"
          aria-label="Close"
          title="Close"
          data-block-interaction="ignore"
          onPointerUp={event => {
            event.preventDefault()
            event.stopPropagation()
            setActiveSwipeBlockId(null)
          }}
          onClick={event => {
            event.preventDefault()
            event.stopPropagation()
            setActiveSwipeBlockId(null)
          }}
          className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-muted active:bg-accent"
        >
          <X className="h-5 w-5"/>
        </button>
      </div>

      {showOverflow && (
        <div
          className="mt-1 flex flex-col gap-0.5 rounded-lg border border-border bg-background/95 p-1 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/85"
        >
          {overflowResolved.map(resolved => {
            const {Icon, label, item} = resolved
            return (
              <button
                key={item.actionId}
                type="button"
                aria-label={label}
                data-block-interaction="ignore"
                onPointerUp={event => {
                  event.preventDefault()
                  event.stopPropagation()
                  handleRun(resolved)
                }}
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
  )
}
