import { useEffect, useRef } from 'react'
import type { Block } from '@/data/block.js'
import type { Repo } from '@/data/repo.js'
import { useBlockExists, usePropertyValue } from '@/hooks/block.js'
import { topLevelBlockIdProp } from '@/data/properties.js'
import {
  panelHasSeenLive,
  recoverPanelOffDeadContent,
  rememberPanelSeenLive,
} from '@/utils/panelHistory.js'
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
 * Only recovers a block it has previously observed live, so an initial mount
 * where the block hasn't loaded yet isn't mistaken for a deletion.
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

    if (shownExists) {
      rememberPanelSeenLive(block.id, topLevelBlockId)
      return
    }

    // Not live — but `useBlockExists` reports "still loading" and "confirmed
    // missing" identically, and a confirmation produces no further transition
    // to re-run this effect. So ask the loader directly instead of inferring
    // absence from what this pane happens to have seen: that inference left
    // panes stranded forever on any id they never observed live (a stale
    // bookmark, a shared link, a browser-history entry for a since-deleted
    // page).
    let cancelled = false

    const armRecovery = () => {
      if (cancelled) return
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        // Re-verify at fire time: same shown block, and still gone (not
        // restored by undo, not a mid-load blip that resolved).
        if (block.peekProperty(topLevelBlockIdProp) !== topLevelBlockId) return
        if (block.repo.block(topLevelBlockId).peek()) return
        // Deliberately NOT forgetting the seen-live entry here: recovery is a
        // documented no-op when nothing live exists, and dropping the memory
        // would send a later effect run down the wait-for-sync branch for a
        // block we know was deleted. It's cleared with the panel instead.
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

    void shown.load().then(data => {
      if (cancelled || data) return
      // Watched this block be live, so its absence now is a delete — recover.
      if (panelHasSeenLive(block.id, topLevelBlockId)) {
        armRecovery()
        return
      }
      // Never live in this pane, so `load()` returning null is ambiguous:
      // deleted, or simply not replicated here yet. Ask the row directly and
      // recover ONLY on a real tombstone — a missing row means "unknown", and
      // moving the pane off a valid deep link that is still syncing would lose
      // it (the layout projection then rewrites the URL in place, so browser
      // Back can't get it back either).
      //
      // An earlier version waited on `onFirstSync` instead. That gate was
      // vacuous: PowerSync's `hasSynced` persists across sessions (see
      // repoProvider's "already completed in a prior session" note), so on every
      // warm client the callback fired synchronously and decided nothing.
      void isBlockTombstoned(block.repo, topLevelBlockId).then(tombstoned => {
        if (!cancelled && tombstoned) armRecovery()
      }).catch(error => console.error('[panel-content-recovery] liveness read failed', error))
    })
      // The db can go away under us (sign-out, workspace switch) while a pane
      // is mid-check. Leaving the pane as-is is the right outcome; an
      // unhandled rejection is not.
      .catch(error => console.error('[panel-content-recovery] load failed', error))

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
