import { useEffect, useRef } from 'react'
import type { Block } from '@/data/block.js'
import type { Repo } from '@/data/repo.js'
import { useBlockExists, usePropertyValue } from '@/hooks/block.js'
import { topLevelBlockIdProp } from '@/data/properties.js'
import { recoverPanelOffDeadContent } from '@/utils/panelHistory.js'
import { isBlockTombstoned } from '@/data/blockLiveness.js'
import { workspaceLandingFacet } from '@/extensions/core.js'

/**
 * How long to wait after the shown block first looks gone before committing a
 * recovery. A block delete is durable, but a loader re-resolve can briefly
 * yield `undefined` mid-flight, and undo can restore a just-deleted block a tick
 * later — a short debounce + a fire-time re-check keeps a transient blip from
 * bouncing the pane. Kept well below human-perceptible latency: by the time a
 * user registers the content changed, we're past it.
 */
export const RECOVERY_DEBOUNCE_MS = 120


/** Resolve the workspace's landing block (today's daily note, by default) off
 *  the live app runtime — the terminal fallback when a recovering pane has no
 *  live history to step back to. Returns null with no runtime / no resolver
 *  (headless), so recovery degrades to history-only rather than throwing.
 *
 *  `excludeBlockId` is the page being recovered off. Landing resolvers are
 *  get-or-create, and the daily-note one RESTORES a soft-deleted row — so
 *  without the exclusion, deleting today's daily note would resolve a landing
 *  that resurrects it and silently undoes the delete. */
const resolveLandingId = async (repo: Repo, excludeBlockId: string): Promise<string | null> => {
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) return null
  const resolvers = repo.facetRuntime?.read(workspaceLandingFacet) ?? []
  // Highest precedence is appended last (see workspaceLandingFacet); walk in
  // reverse and take the first non-null, matching the bootstrap landing walk.
  for (let i = resolvers.length - 1; i >= 0; i -= 1) {
    try {
      const id = await resolvers[i]({repo, workspaceId, freshlyCreated: false, excludeBlockId})
      if (id) return id
    } catch (error) {
      console.error('[panel-content-recovery] landing resolver threw', error)
    }
  }
  return null
}

/**
 * Per-panel watchdog that keeps a pane off a tombstone. When the block a panel
 * is showing (`topLevelBlockIdProp`) is deleted — by this pane's own Delete, by
 * another pane showing the same page, or by a remote/sync delete — this steps
 * the pane onto the nearest live destination (nearest live history entry →
 * workspace landing page). Because it's mounted once inside every
 * `<PanelRenderer/>` (via `panelMountsFacet`), a page open in several panes is
 * recovered in all of them, and the delete handler doesn't have to know about
 * any of it — it just deletes.
 *
 * Only recovers on a confirmed TOMBSTONE, never on a merely-absent row, so an
 * initial mount before the block has loaded — or a deep link whose row hasn't
 * replicated yet — is not mistaken for a deletion.
 */
export function PanelContentRecovery({block}: {block: Block}) {
  const [topLevelBlockId] = usePropertyValue(block, topLevelBlockIdProp)
  // `repo.block` is id-memoized, so `shown` is stable until the pane navigates.
  // Fall back to the panel block itself when no content is set, so the hook is
  // always called on a real block (the effect below gates on topLevelBlockId).
  const shown = block.repo.block(topLevelBlockId ?? block.id)
  const shownExists = useBlockExists(shown)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (!topLevelBlockId) return

    if (shownExists) return

    // Not live — but `useBlockExists` reports "still loading" and "confirmed
    // missing" identically, and a confirmation produces no further transition
    // to re-run this effect. So ask the row directly: it is the only source
    // that separates "deleted" from "not replicated here yet", and recovering
    // on the latter would move the pane off a valid deep link that is still
    // syncing (the projection then rewrites the URL in place, so browser Back
    // can't get it back either).
    //
    // This pane's own memory of having seen the block live used to gate a
    // faster path here. It was redundant — a block this pane watched vanish is
    // precisely a block whose row is now a tombstone, so both branches asked
    // the same question — and it was one more piece of cross-pane state to
    // keep honest.
    //
    // An earlier version instead waited on `onFirstSync` before concluding
    // anything. That gate was vacuous: PowerSync's `hasSynced` persists across
    // sessions (see repoProvider's "already completed in a prior session"
    // note), so on every warm client it fired synchronously and decided nothing.
    let cancelled = false

    const armRecovery = () => {
      if (cancelled) return
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        // Re-verify at fire time: same shown block, and still gone (not
        // restored by undo, not a mid-load blip that resolved).
        if (block.peekProperty(topLevelBlockIdProp) !== topLevelBlockId) return
        if (block.repo.block(topLevelBlockId).peek()) return
        // The landing resolver is passed as a thunk, not a resolved id: it can
        // write (get-or-create), so it must only run if history yields nothing
        // live. `recoverPanelOffDeadContent` re-checks that the pane is still
        // stranded on this block before it writes, covering the case where the
        // user navigates or undoes while that resolution is in flight.
        void recoverPanelOffDeadContent(block, topLevelBlockId, () =>
          resolveLandingId(block.repo, topLevelBlockId),
        ).catch(error => console.error('[panel-content-recovery] recovery failed', error))
      }, RECOVERY_DEBOUNCE_MS)
    }

    void isBlockTombstoned(block.repo, topLevelBlockId)
      .then(tombstoned => {
        if (!cancelled && tombstoned) armRecovery()
      })
      // The db can go away under us (sign-out, workspace switch) while a pane
      // is mid-check. Leaving the pane as-is is the right outcome; an
      // unhandled rejection is not.
      .catch(error => console.error('[panel-content-recovery] liveness read failed', error))

    return () => {
      cancelled = true
      if (timerRef.current != null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [block, shown, topLevelBlockId, shownExists])

  return null
}

// Mounted by `spatialNavigationPlugin`, beside its sibling `PanelFocusRecovery`
// — this is a navigation nicety, not an invariant. With it off, a pane that
// loses its page just renders empty until you navigate away.
