import { useEffect, useRef } from 'react'
import type { Block } from '@/data/block.js'
import type { Repo } from '@/data/repo.js'
import { usePropertyValue } from '@/hooks/block.js'
import { useBlockExists } from '@/hooks/block.js'
import { topLevelBlockIdProp } from '@/data/properties.js'
import { recoverPanelOffDeadContent } from '@/utils/panelHistory.js'
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
  /** EVERY block this pane has seen live, not just the latest. Browser
   *  Back/Forward can reconcile the pane onto a page it showed earlier — if
   *  that page has since been deleted, a single-slot memo would read it as
   *  "never seen, still loading" and refuse to recover, stranding the pane on
   *  the tombstone. Grows with pages visited in this pane, which is bounded by
   *  the session and holds only ids. */
  const seenLiveRef = useRef<Set<string>>(new Set())
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (!topLevelBlockId) return

    if (shownExists) {
      // Confirmed live — remember it so a later disappearance reads as a delete.
      seenLiveRef.current.add(topLevelBlockId)
      return
    }
    // Not live. Unless we've seen THIS block live, treat it as still-loading
    // (initial mount), not deleted — don't recover.
    if (!seenLiveRef.current.has(topLevelBlockId)) return

    timerRef.current = setTimeout(() => {
      timerRef.current = null
      // Re-verify at fire time: same shown block, and still gone (not restored
      // by undo, not a mid-load blip that resolved).
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

    return () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [block, topLevelBlockId, shownExists])

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
