import { useEffect, useRef } from 'react'
import { usePropertyValue } from '@/hooks/block.js'
import {
  focusBlock,
  focusedBlockLocationProp,
  isEditingProp,
  peekFocusedBlockLocation,
  sameFocusedBlockLocation,
  type FocusedBlockLocation,
} from '@/data/properties.js'
import type { Block } from '@/data/block.js'
import { panelById } from '@/plugins/spatial-navigation/walker.js'
import { resolveSpatialNavExclusions } from '@/plugins/spatial-navigation/exclusionsFacet.js'
import { findInstance, isRowInViewport, resolveSettledAnchor } from './viewportAnchor.ts'
import { createSettleScheduler } from './settleScheduler.ts'

/** Re-anchor once scrolling has stopped, not while it's happening. Two reasons:
 *  a fling would otherwise write a focus location per frame, and the row we
 *  pick mid-flight is off screen again a moment later — which is the one thing
 *  that makes the focus decorator scroll and fight the user. 150ms clears the
 *  gaps between momentum events without being perceptible. */
const SCROLL_SETTLE_MS = 150

/** A fast scroll can outrun lazy mounting: the rows now filling the viewport
 *  are still placeholders when the settle fires, so there is no candidate to
 *  anchor to and the attempt would be dropped for good — nothing schedules
 *  another, because a row mounting need not move `scrollTop`. Retry a few times
 *  instead, bounded so a genuinely empty viewport doesn't spin. */
const SETTLE_RETRY_MS = 250
const SETTLE_RETRIES = 4


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
  // Subscribed, not just peeked: a scroll that happens while the editor is open
  // is REFUSED, and nothing schedules another attempt — so leaving the editor
  // has to be its own trigger, or the cursor stays on the row the user scrolled
  // away from and the next motion (or restore) goes back to it.
  const [isEditing] = usePropertyValue(block, isEditingProp)
  const focusedBlockId = focusedLocation?.blockId
  const renderScopeId = focusedLocation?.renderScopeId
  // The live settle, reachable from the edit-mode effect below without making
  // `isEditing` a dependency of the main one. It was a dependency for exactly
  // one revision, and that made the retry INERT: re-running the effect resets
  // `seenOnScreen`, and the row is off screen in the very case the retry
  // exists for, so the retry's own precondition was never met.
  const settleRef = useRef<(() => void) | null>(null)

  // Depend on the two primitives, not the decoded object: a fresh identity on
  // an unrelated re-render would re-run the effect and clear `seenOnScreen`
  // mid-scroll, which reads as "the cursor was never on screen" and silently
  // switches the behaviour off until the next focus change.
  useEffect(() => {
    if (!focusedBlockId || !renderScopeId) return
    const panelEl = panelById(block.id)
    if (!panelEl) return
    const location = {blockId: focusedBlockId, renderScopeId}

    let retriesLeft = 0
    let seenOnScreen = false
    /** Set when a scroll's settle was refused because the editor was open, so
     *  closing it knows there is something to reconsider. Without it the retry
     *  fires for a cursor that merely LANDED off screen in edit mode, whose
     *  catch-up scroll is still in flight — re-anchoring away from the very row
     *  the app is scrolling toward. */
    let suppressedWhileEditing = false

    // Re-resolved per use rather than captured: the facet runtime can be
    // swapped (a plugin toggled) while this effect is alive, same as
    // `PanelFocusRecovery` does.
    const excluded = () => resolveSpatialNavExclusions(block.repo.facetRuntime)

    const sample = () => {
      if (seenOnScreen) return
      const row = findInstance(panelEl, location, excluded())
      if (row && isRowInViewport(row)) seenOnScreen = true
    }

    // The decision itself is pure and lives in `resolveSettledAnchor`, so its
    // refusals are testable directly — the staleness one especially, which the
    // effect cleanup below hides in any ordering a test can stage.
    const settle = () => {
      const next = resolveSettledAnchor({
        panelEl,
        armedFor: location,
        currentLocation: peekFocusedBlockLocation(block),
        isEditing: Boolean(block.peekProperty(isEditingProp)),
        excludedSurfaces: excluded(),
      })
      if (next) {
        void focusBlock(block, next.blockId, {renderScopeId: next.renderScopeId})
        return
      }
      // Null is ambiguous: "nothing to do" and "nothing rendered YET" look the
      // same from here. Retry only in the shape that means the second — the
      // cursor is off screen, so a move was wanted and no candidate was found.
      if (retriesLeft <= 0) return
      if (block.peekProperty(isEditingProp)) return
      const row = findInstance(panelEl, location, excluded())
      if (!row || isRowInViewport(row)) return
      retriesLeft -= 1
      scheduler.schedule(SETTLE_RETRY_MS)
    }
    const scheduler = createSettleScheduler(() => settle())

    const onScroll = () => {
      sample()
      if (!seenOnScreen) return
      if (block.peekProperty(isEditingProp)) suppressedWhileEditing = true
      retriesLeft = SETTLE_RETRIES
      scheduler.schedule(SCROLL_SETTLE_MS)
    }

    // Re-measure with the real predicate. Every signal below funnels here
    // instead of deciding for itself, because none of them can express what
    // `isRowInViewport` asks: an absolute line-height minimum, clipped through
    // EVERY scrollport above the row.
    //
    // IntersectionObserver was tried for this and cannot do it, twice over. An
    // element-rooted observer computes intersection through that root alone, so
    // a nested port sliding behind an OUTER clip produces no callback at all;
    // and its thresholds are area ratios, so on a tall row the slide from 21px
    // to 15px visible — straight across the predicate's cutoff — moves the ratio
    // by 0.002 and crosses nothing. Both are structural, not tuning.
    const remeasure = () => {
      sample()
      if (!seenOnScreen) return
      const row = findInstance(panelEl, location, excluded())
      if (!row || isRowInViewport(row)) return
      if (block.peekProperty(isEditingProp)) suppressedWhileEditing = true
      retriesLeft = SETTLE_RETRIES
      scheduler.schedule(SCROLL_SETTLE_MS)
    }

    // What moves the cursor out of view besides scrolling:
    //   - content above it growing. On WebKit, which has no scroll anchoring,
    //     every lazy row above the cursor swapping its estimated height for a
    //     measured one shoves the cursor down with no scroll event at all —
    //     and mounting a row is itself a mutation, so the watcher sees it.
    //   - an image or font resizing IN PLACE inside a row above it, which
    //     produces no mutation at all. Hence both observers.
    const contentObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(remeasure)
    const observeRows = () => {
      if (!contentObserver) return
      for (const row of panelEl.querySelectorAll<HTMLElement>('[data-block-id][data-render-scope-id]')) {
        contentObserver.observe(row)
      }
    }
    // Also how the cursor's row is noticed ARRIVING: on a cold load it is a
    // deferred placeholder for the first few commits, and `sample` has to see
    // it appear before `seenOnScreen` can ever become true.
    const changeWatcher = new MutationObserver(() => {
      observeRows()
      remeasure()
    })

    settleRef.current = () => {
      if (!suppressedWhileEditing) return
      suppressedWhileEditing = false
      scheduler.runNow()
    }

    sample()
    changeWatcher.observe(panelEl, {childList: true, subtree: true})
    observeRows()

    // Capture at the document: scroll doesn't bubble, and which element
    // actually scrolls varies (the panel's own overflow container normally, an
    // ancestor for a stacked panel, a nested port inside a mode renderer).
    // Scrolls belonging to other panels reach us too and cost a settle check
    // that finds this cursor still on screen.
    document.addEventListener('scroll', onScroll, {capture: true, passive: true})
    return () => {
      document.removeEventListener('scroll', onScroll, {capture: true})
      scheduler.cancel()
      changeWatcher.disconnect()
      contentObserver?.disconnect()
      settleRef.current = null
    }
  }, [block, focusedBlockId, renderScopeId])

  // Leaving the editor re-runs the decision once, which is what makes the
  // edit-mode refusal a DEFERRAL rather than a silent drop: a scroll while the
  // editor is open is declined, and without this nothing would reconsider until
  // the user happened to scroll again — leaving the cursor on the row they
  // scrolled away from, and the next motion or restore going back to it.
  //
  // Its own effect, so the main one keeps running across the transition and
  // `seenOnScreen` survives it. Deliberately NOT gated on `seenOnScreen`: there
  // is no catch-up scroll in flight when an editor closes, which is the only
  // thing that gate protects against.
  // Holds the cursor that was being EDITED, so the retry can tell "the editor
  // closed" from "focus moved somewhere else and the editor closed with it".
  // An action can do the latter in a single write (`focusBlock(target, {edit:
  // false})` sets both props in one tx), and the main effect re-runs first —
  // so by the time this fires, `settleRef` already belongs to the DESTINATION.
  // Running it then would treat a row the app is still scrolling toward as a
  // stale off-screen cursor and re-anchor away from it, undoing the action.
  const editedLocation = useRef<FocusedBlockLocation | null>(null)
  useEffect(() => {
    const wasEditing = editedLocation.current
    const current = focusedBlockId && renderScopeId
      ? {blockId: focusedBlockId, renderScopeId}
      : undefined
    editedLocation.current = isEditing ? (current ?? null) : null
    if (!wasEditing || isEditing) return
    if (!sameFocusedBlockLocation(wasEditing, current)) return
    settleRef.current?.()
  }, [isEditing, focusedBlockId, renderScopeId])

  return null
}
