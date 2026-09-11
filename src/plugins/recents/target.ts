import type { Repo } from '@/data/repo'
import { getOrCreateRecentsPage, recentsPageBlockId } from '@/data/recentsPage.js'
import type { NavigationTargetEnsure } from '@/utils/navigation.js'

/** The Recents page as a navigation target: its derived id, the workspace that
 *  id was derived from, and how to materialize its row — all from ONE workspace
 *  read, because the three must name the same workspace or the navigation lands
 *  somewhere the ensure did not write. `null` when no workspace is active.
 *
 *  `ensureSystemPages` reports a failing `ensure` and carries on, so this page
 *  can be absent for the rest of the session (see the `SystemPage` doc).
 *  Get-or-creating at the point of use is what the Journal and Locations pages
 *  already do (#931); the id is enough to navigate on because it is derived
 *  rather than read.
 *
 *  The PIN, not `activeWorkspaceIdPreferringHash`. That helper routes a command
 *  to the workspace the hash already names mid-switch, which is right for a
 *  gesture that only navigates — but this one also WRITES, and every gate on
 *  that write (`repo.isReadOnly`, the access decision) is a single Repo-wide
 *  flag an async App effect moves with the pin (#226). Resolved from the hash,
 *  the create would be checked against a different workspace than it lands in.
 *  The cost is a gesture fired mid-switch opening the workspace the user just
 *  left — idempotent, and the next one is correct. */
export const recentsNavigationTarget = (repo: Repo): NavigationTargetEnsure | null => {
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) return null
  return {
    blockId: recentsPageBlockId(workspaceId),
    workspaceId,
    ensure: () => getOrCreateRecentsPage(repo, workspaceId),
  }
}
