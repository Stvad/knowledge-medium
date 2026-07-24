import { useEffect, useRef } from 'react'
import type { Block } from '@/data/block.js'
import type { Repo } from '@/data/repo.js'
import { usePropertyValue } from '@/hooks/block.js'
import { useBlockExists } from '@/hooks/block.js'
import { topLevelBlockIdProp } from '@/data/properties.js'
import { recoverPanelOffDeadContent } from '@/utils/panelHistory.js'
import { onFirstSync, type SyncStatusDb } from '@/data/internals/firstSync.js'
import {
  panelMountsFacet,
  workspaceLandingFacet,
  type PanelMountContribution,
} from '@/extensions/core.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'

/**
 * How long to wait after the shown block first looks gone before committing a
 * recovery. A block delete is durable, but a loader re-resolve can briefly
 * yield `undefined` mid-flight, and undo can restore a just-deleted block a tick
 * later — a short debounce + a fire-time re-check keeps a transient blip from
 * bouncing the pane. Kept well below human-perceptible latency: by the time a
 * user registers the content changed, we're past it.
 */
const RECOVERY_DEBOUNCE_MS = 120

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
  /** Blocks this pane has watched be live. Only used to pick the debounce:
   *  a page that vanished under us is certainly deleted, while one that was
   *  never live here might still be syncing in. */
  const seenLiveRef = useRef<Set<string>>(new Set())
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (!topLevelBlockId) return

    if (shownExists) {
      seenLiveRef.current.add(topLevelBlockId)
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
    let disposeSyncWait: (() => void) | undefined

    const armRecovery = () => {
      if (cancelled) return
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        // Re-verify at fire time: same shown block, and still gone (not
        // restored by undo, not a mid-load blip that resolved).
        if (block.peekProperty(topLevelBlockIdProp) !== topLevelBlockId) return
        if (block.repo.block(topLevelBlockId).peek()) return
        seenLiveRef.current.delete(topLevelBlockId)
        // The landing resolver is passed as a thunk, not a resolved id: it can
        // write (get-or-create), so it must only run if history yields nothing
        // live. `recoverPanelOffDeadContent` re-checks that the pane is still
        // stranded on this block before it writes, covering the case where the
        // user navigates or undoes while that resolution is in flight.
        void recoverPanelOffDeadContent(block, topLevelBlockId, () =>
          resolveLandingId(block.repo, topLevelBlockId),
        )
      }, RECOVERY_DEBOUNCE_MS)
    }

    void shown.load().then(data => {
      if (cancelled || data) return
      // Watched this block be live, so its absence now is a delete — recover.
      if (seenLiveRef.current.has(topLevelBlockId)) {
        armRecovery()
        return
      }
      // Never live in this pane. A missing local row means "deleted" OR "hasn't
      // replicated yet", and those are indistinguishable here — so wait for the
      // initial sync to settle and re-ask before concluding it's gone. Without
      // this, opening a valid shared link in a not-yet-synced workspace would
      // bounce the pane to the landing page and canonicalize the URL, losing
      // the deep link. In a local-only/offline session `onFirstSync` never
      // fires, which is the safe outcome: leave the pane where it is.
      // Cast per the established idiom (see startup-metrics/record.ts): the
      // Repo's wrapped db type doesn't declare the optional sync-status fields,
      // and onFirstSync treats an object without them as already-synced.
      disposeSyncWait = onFirstSync(block.repo.db as unknown as SyncStatusDb, () => {
        void shown.load().then(afterSync => {
          if (!cancelled && !afterSync) armRecovery()
        })
      })
    })

    return () => {
      cancelled = true
      disposeSyncWait?.()
      if (timerRef.current != null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [block, shown, topLevelBlockId, shownExists])

  return null
}

const panelContentRecoveryMount: PanelMountContribution = {
  id: 'core.panel-content-recovery',
  component: PanelContentRecovery,
}

/** Always-on (essential) mount: panels must never be left rendering a deleted
 *  page, independent of which navigation plugins are enabled. */
export const panelContentRecoveryExtension: AppExtension = systemToggle({
  id: 'system:panel-content-recovery',
  name: 'Panel content recovery',
  description:
    'Steps a panel off a page that was just deleted — its own delete, a duplicate pane, or a remote delete — onto the nearest live view.',
  essential: true,
}).of([
  panelMountsFacet.of(panelContentRecoveryMount, {source: 'core'}),
])
