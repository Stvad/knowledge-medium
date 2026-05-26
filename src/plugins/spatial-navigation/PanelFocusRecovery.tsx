import { useEffect, useLayoutEffect, useRef } from 'react'
import { usePropertyValue } from '@/hooks/block.js'
import { focusBlock, focusedBlockIdProp } from '@/data/properties'
import type { Block } from '@/data/block'
import {
  findRecoveryAnchor,
  panelById,
  panelInstances,
  rememberInstancePosition,
} from './walker.ts'

/**
 * How long to wait before committing a recovery write after the focused
 * block first appears to be gone. Two pressures point in opposite
 * directions and the value below is the compromise.
 *
 * Short side: anything that re-mounts the block in a subsequent React
 * commit — tab/shift-tab tree-moves, Enter splitting a block,
 * fast-refresh, virtualization scroll-in/out — briefly removes the
 * instance from the DOM. We must not race ahead of React's second
 * commit and write a (wrong) recovery target. Even 80ms is enough
 * headroom for concurrent-mode batched commits.
 *
 * Long side: query-driven re-renders. The big offender is rescheduling
 * a backlink — the reactive query refetches, the snapshot is replaced,
 * and the list resorts / regroups across several commits. If we fire
 * recovery before the new sibling layout has landed, tiers 1/2 miss
 * (the previous neighbors aren't where they used to be) and we fall
 * through to the positional clamp, which lands somewhere arbitrary.
 * The watcher's mutation observer extends the debounce on every
 * mutation burst, so a steady stream of churn pushes recovery out
 * naturally — but isolated re-render storms with sub-frame gaps
 * between bursts still slip through with 80ms.
 *
 * 250ms is comfortably above typical re-render lengths and short
 * enough that the user can't tell the difference when recovery is
 * the right answer — by the time a human registers a focus change,
 * we're past the debounce. The viewport-aware tier 4 in
 * `findRecoveryAnchor` keeps us honest when this still isn't enough.
 */
const RECOVERY_DEBOUNCE_MS = 250

/**
 * Per-panel watchdog that keeps `focusedBlockId` pointed at a block
 * that actually exists in the panel DOM. Two cases motivate this:
 *
 *   1. The user edits a block in the backlinks section so it stops
 *      matching the backlink query. The block unmounts but its id is
 *      still written on the panel's `focusedBlockId`. Movement actions
 *      would have no anchor to walk from and the highlight goes dark.
 *   2. The user collapses the parent of the focused block. The child
 *      unmounts; same problem.
 *
 * Recovery target priority (see `walker.findRecoveryAnchor` for the
 * implementation): the block that was previously below the focused
 * one (baseline — the natural shift-up behavior of a list), else
 * "previously above" when it was the last entry, else the closest
 * surviving ancestor (handles collapse: when a parent unmounts a
 * whole subtree, neither sibling survives but the parent itself
 * does, so we land on it). The neighbor map is populated by this
 * component itself on every render where the focused block IS
 * mounted, via `rememberInstancePosition`. The blockId-match guard
 * inside `findRecoveryAnchor` prevents misfires for panels the user
 * has never visited.
 *
 * The recovery write is debounced via `RECOVERY_DEBOUNCE_MS` so that
 * brief unmount/remount cycles (tab/shift-tab moves, Enter creating
 * a new sibling) don't race to recover before React's reconciliation
 * settles. Every entry into the check cancels any pending timer;
 * a real disappearance ends up writing because the timer outlives
 * the burst of mutations.
 *
 * Mounted via `panelMountsFacet`, so one instance lives inside each
 * `<PanelRenderer/>`, scoped to that panel's UI-state block.
 */
export function PanelFocusRecovery({block}: {block: Block}) {
  // Re-render whenever the focused block changes. Cheap: this
  // component renders null, so a re-render is just running the
  // layout-effect's check.
  const [focusedBlockId] = usePropertyValue(block, focusedBlockIdProp)

  // Pending-recovery timer. Lives on the component so it's per-panel
  // (a separate panel could be debouncing its own recovery in parallel
  // without interference) and gets reliably cleared on unmount.
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Run the check after every commit (focus changed OR the panel
  // rendered for some other reason). `useLayoutEffect` so any sibling-
  // remember work happens before paint.
  useLayoutEffect(() => {
    runRecoveryCheck(block, focusedBlockId, pendingTimerRef)
  }, [block, focusedBlockId])

  // Watch the panel's DOM for childList changes — the focused block
  // can disappear without `focusedBlockId` itself changing (a backlink
  // list re-renders internally, a parent collapse unmounts a subtree).
  // MutationObserver coalesces bursts via the microtask scheduling
  // below.
  useEffect(() => {
    const panelEl = panelById(block.id)
    if (!panelEl) return

    let scheduled = false
    const scheduleCheck = () => {
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        const currentFocused = block.peekProperty(focusedBlockIdProp)
        runRecoveryCheck(block, currentFocused, pendingTimerRef)
      })
    }

    const observer = new MutationObserver(scheduleCheck)
    observer.observe(panelEl, {childList: true, subtree: true})
    return () => {
      observer.disconnect()
      if (pendingTimerRef.current != null) {
        clearTimeout(pendingTimerRef.current)
        pendingTimerRef.current = null
      }
    }
  }, [block])

  return null
}

const runRecoveryCheck = (
  block: Block,
  focusedBlockId: string | undefined,
  pendingTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>,
): void => {
  // Every entry cancels any pending recovery and re-evaluates from
  // scratch. This is what gives tab/shift-tab + Enter their free pass:
  // the block briefly leaves the DOM (one observer fire schedules
  // recovery), then reappears in the next React commit (a second
  // observer fire enters here, cancels, sees the block is alive,
  // and exits without rescheduling).
  if (pendingTimerRef.current != null) {
    clearTimeout(pendingTimerRef.current)
    pendingTimerRef.current = null
  }

  if (!focusedBlockId) return

  const panelEl = panelById(block.id)
  if (!panelEl) return

  const instances = panelInstances(panelEl)
  if (instances.length === 0) return

  const focusedInstance = instances.find(el => el.dataset.blockId === focusedBlockId)

  if (focusedInstance) {
    // Block is alive in the panel — refresh the sibling/ancestor hint
    // so the next disappearance lands on the right recovery target.
    rememberInstancePosition(block.id, focusedInstance)
    return
  }

  // Block is gone, but we may be mid-burst (tab move, Enter split,
  // etc.). Schedule the recovery write for `RECOVERY_DEBOUNCE_MS`
  // and let any subsequent check cancel it if the block reappears.
  // We early-exit if there's no stored hint matching `focusedBlockId`
  // (which `findRecoveryAnchor` enforces) — that quietly leaves the
  // panel alone during initial mounts where the focused block's data
  // hasn't loaded yet.
  if (!findRecoveryAnchor(block.id, focusedBlockId)) return

  pendingTimerRef.current = setTimeout(() => {
    pendingTimerRef.current = null
    // Re-verify at the moment of write — anything could have changed
    // during the debounce window.
    const stillFocused = block.peekProperty(focusedBlockIdProp)
    if (stillFocused !== focusedBlockId) return
    const panel = panelById(block.id)
    if (!panel) return
    const refreshed = panelInstances(panel)
    if (refreshed.find(el => el.dataset.blockId === focusedBlockId)) return
    const anchor = findRecoveryAnchor(block.id, focusedBlockId)
    const recoveryBlockId = anchor?.dataset.blockId
    if (!recoveryBlockId || recoveryBlockId === focusedBlockId) return
    void focusBlock(block, recoveryBlockId)
  }, RECOVERY_DEBOUNCE_MS)
}
