import { useEffect, useLayoutEffect } from 'react'
import { usePropertyValue } from '@/hooks/block.ts'
import { focusBlock, focusedBlockIdProp } from '@/data/properties'
import type { Block } from '@/data/block'
import {
  locateInstance,
  panelById,
  panelInstances,
  peekPositionHint,
  rememberInstancePosition,
} from './walker.ts'

/**
 * Per-panel watchdog that keeps `focusedBlockId` pointed at a block
 * that actually exists in the panel DOM. Two cases motivate this:
 *
 *   1. The user edits a block in the backlinks section so it stops
 *      matching the backlink query. The block unmounts but its id is
 *      still written on the panel's `focusedBlockId`. h/j/k/l would
 *      have no anchor to walk from and the highlight goes dark.
 *   2. The user collapses the parent of the focused block. The child
 *      unmounts; same problem.
 *
 * Recovery target: "block just above where the user was". For the
 * backlinks case that's the preceding sibling; for the collapse case
 * that's the parent itself (which sits immediately above its now-gone
 * child in DOM order). `walker.locateInstance` returns this via its
 * tier-3 positional hint — provided we've previously called
 * `rememberInstancePosition` for the focused block, which is exactly
 * what this component does on every render where the focused block
 * IS mounted. The blockId-match guard inside `locateInstance` prevents
 * misfires for panels the user has never visited.
 *
 * Mounted via `panelMountsFacet`, so one instance lives inside each
 * `<PanelRenderer/>`, scoped to that panel's UI-state block.
 */
export function PanelFocusRecovery({block}: {block: Block}) {
  // Re-render whenever the focused block changes. Cheap: this
  // component renders null, so a re-render is just running the
  // layout-effect's check.
  const [focusedBlockId] = usePropertyValue(block, focusedBlockIdProp)

  // Run the check after every commit (focus changed OR the panel
  // rendered for some other reason). `useLayoutEffect` so the
  // recovery write fires before paint, avoiding a one-frame flash
  // where the highlight is gone before the new focus lands.
  useLayoutEffect(() => {
    runRecoveryCheck(block, focusedBlockId)
  }, [block, focusedBlockId])

  // Also watch the panel's DOM for childList changes — the focused
  // block can disappear without `focusedBlockId` itself changing
  // (e.g., a backlink list re-renders internally, or a parent
  // collapse unmounts a subtree). MutationObserver coalesces bursts
  // via the microtask scheduling below.
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
        runRecoveryCheck(block, currentFocused)
      })
    }

    const observer = new MutationObserver(scheduleCheck)
    observer.observe(panelEl, {childList: true, subtree: true})
    return () => observer.disconnect()
  }, [block])

  return null
}

const runRecoveryCheck = (block: Block, focusedBlockId: string | undefined): void => {
  if (!focusedBlockId) return

  const panelEl = panelById(block.id)
  if (!panelEl) return

  const instances = panelInstances(panelEl)
  if (instances.length === 0) return

  const focusedInstance = instances.find(el => el.dataset.blockId === focusedBlockId)

  if (focusedInstance) {
    // Block is alive in the panel — update the positional hint so
    // future recoveries land on the natural "block above".
    rememberInstancePosition(block.id, focusedInstance)
    return
  }

  // Block is gone. Only recover if we've previously confirmed that
  // focusedBlockId sat in this panel; otherwise `focusedBlockId`
  // probably points to a block whose data hasn't loaded yet (initial
  // panel mount, route change with hydration pending) and stealing
  // focus to whatever happens to be rendered would lose the user's
  // intended target. `locateInstance`'s tier-4 fallback (first
  // instance) is correct for keystroke-time recovery but wrong here.
  const hint = peekPositionHint(block.id)
  if (!hint || hint.blockId !== focusedBlockId) return

  const recoveryEl = locateInstance(block.id, {focusedBlockId})
  const recoveryBlockId = recoveryEl?.dataset.blockId
  if (!recoveryBlockId || recoveryBlockId === focusedBlockId) return

  void focusBlock(block, recoveryBlockId)
}
