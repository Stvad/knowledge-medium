import { useEffect } from 'react'
import { usePropertyValue } from '@/hooks/block.js'
import {
  focusBlock,
  focusedBlockLocationProp,
  isEditingProp,
  peekFocusedBlockLocation,
} from '@/data/properties.js'
import type { Block } from '@/data/block.js'
import { panelById } from '@/plugins/spatial-navigation/walker.js'
import { resolveSpatialNavExclusions } from '@/plugins/spatial-navigation/exclusionsFacet.js'
import { findInstance, isRowInViewport, resolveSettledAnchor } from './viewportAnchor.ts'

/** Re-anchor once scrolling has stopped, not while it's happening. Two reasons:
 *  a fling would otherwise write a focus location per frame, and the row we
 *  pick mid-flight is off screen again a moment later — which is the one thing
 *  that makes the focus decorator scroll and fight the user. 150ms clears the
 *  gaps between momentum events without being perceptible. */
const SCROLL_SETTLE_MS = 150

/** How long to keep watching for the cursor's row to appear before giving up on
 *  ever seeing it on screen — see `seenOnScreen` below. Covers a cold load
 *  hydrating a deferred row and its ancestors; past that, a row that still
 *  isn't there is one the user has scrolled away from, and the next scroll
 *  samples it anyway. */
const CURSOR_MOUNT_WATCH_MS = 3000

/**
 * Emacs's rule, per panel: scrolling the cursor out of the window moves the
 * cursor rather than leaving it behind. Without it the cursor and the viewport
 * drift apart, and the next `j` teleports the view back to wherever the cursor
 * was sitting.
 *
 * Two things keep this from turning into a scroll fight:
 *
 *   - Every row it picks is one `BlockFocusShellDecorator` agrees needs no
 *     scrolling, so the decorator does nothing on the focus change this writes.
 *     `isRowInViewport` implies the decorator's own predicate rather than
 *     equalling it (that one is strictly more permissive) — the implication is
 *     the direction the guarantee needs; see its docblock for where they differ
 *     and why that gap is left open.
 *   - It only fires for a cursor it has SEEN on screen since focus landed
 *     there. A focus write whose row starts off screen is a move the app is
 *     still catching up to — keyboard navigation to a row below the fold, or a
 *     restore aligning the panel to its stored cursor — and both scroll the
 *     row in. Reacting to those would cancel the very navigation that caused
 *     them; `seenOnScreen` is what tells the two apart.
 *
 * Mounted per panel via `panelMountsFacet`. Toggleable: with the plugin off,
 * the cursor stays where it was put and the app behaves like vim (the view
 * snaps back to the cursor on the next motion) instead of like Emacs.
 *
 * Soft-depends on the spatial-navigation plugin, whose shell decorator writes
 * the `data-block-nav-item` / `data-block-surface` tagging every lookup here
 * reads. Turn that off with this left on and this goes inert — stated in the
 * toggle's own description so the pairing is visible where it's switched.
 * Reading core's shell attributes instead would remove the dependency but also
 * the surface exclusions, making breadcrumb rows eligible anchors; and with
 * spatial navigation off there is no `j`/`k` to teleport in the first place,
 * which is the problem this exists to solve.
 */
export function PanelCursorFollowsScroll({block}: {block: Block}) {
  const [focusedLocation] = usePropertyValue(block, focusedBlockLocationProp)
  const focusedBlockId = focusedLocation?.blockId
  const renderScopeId = focusedLocation?.renderScopeId

  // Depend on the two primitives, not the decoded object: a fresh identity on
  // an unrelated re-render would re-run the effect and clear `seenOnScreen`
  // mid-scroll, which reads as "the cursor was never on screen" and silently
  // switches the behaviour off until the next focus change.
  useEffect(() => {
    if (!focusedBlockId || !renderScopeId) return
    const panelEl = panelById(block.id)
    if (!panelEl) return
    const location = {blockId: focusedBlockId, renderScopeId}

    let settleTimer: ReturnType<typeof setTimeout> | null = null
    let mountWatcher: MutationObserver | null = null
    let seenOnScreen = false

    // Re-resolved per use rather than captured: the facet runtime can be
    // swapped (a plugin toggled) while this effect is alive, same as
    // `PanelFocusRecovery` does.
    const excluded = () => resolveSpatialNavExclusions(block.repo.facetRuntime)

    const stopWatchingForMount = () => {
      mountWatcher?.disconnect()
      mountWatcher = null
    }

    const sample = () => {
      if (seenOnScreen) return
      const row = findInstance(panelEl, location, excluded())
      if (row && isRowInViewport(row)) {
        seenOnScreen = true
        stopWatchingForMount()
      }
    }

    // The decision itself is pure and lives in `resolveSettledAnchor`, so its
    // refusals are testable directly — the staleness one especially, which the
    // effect cleanup below hides in any ordering a test can stage.
    const settle = () => {
      settleTimer = null
      const next = resolveSettledAnchor({
        panelEl,
        armedFor: location,
        currentLocation: peekFocusedBlockLocation(block),
        isEditing: Boolean(block.peekProperty(isEditingProp)),
        excludedSurfaces: excluded(),
      })
      if (!next) return
      void focusBlock(block, next.blockId, {renderScopeId: next.renderScopeId})
    }

    const onScroll = () => {
      sample()
      if (!seenOnScreen) return
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = setTimeout(settle, SCROLL_SETTLE_MS)
    }

    sample()
    // The cursor's row often doesn't exist yet — a cold load, or a restore
    // waiting on `FocusedRowLazyMount` to materialize deferred ancestors. Watch
    // for it rather than leaving `seenOnScreen` to the next scroll event: a
    // single coarse gesture (a scrollbar drag, a fling) can move the row from
    // never-sampled straight to off-screen, and it would then be mistaken for a
    // cursor the app was still scrolling toward.
    if (!seenOnScreen) {
      mountWatcher = new MutationObserver(sample)
      mountWatcher.observe(panelEl, {childList: true, subtree: true})
    }
    const mountWatchDeadline = setTimeout(stopWatchingForMount, CURSOR_MOUNT_WATCH_MS)

    // Capture at the document: scroll doesn't bubble, and which element
    // actually scrolls varies (the panel's own overflow container normally, an
    // ancestor for a stacked panel, a nested port inside a mode renderer).
    // Scrolls belonging to other panels reach us too and cost a settle check
    // that finds this cursor still on screen.
    document.addEventListener('scroll', onScroll, {capture: true, passive: true})
    return () => {
      document.removeEventListener('scroll', onScroll, {capture: true})
      if (settleTimer) clearTimeout(settleTimer)
      clearTimeout(mountWatchDeadline)
      stopWatchingForMount()
    }
  }, [block, focusedBlockId, renderScopeId])

  return null
}
