import type { Repo } from '@/data/repo'
import { getOrCreateRecentsPage } from '@/data/recentsPage.js'

/** Materialize the workspace's Recents page and say where to open it; `null`
 *  when no workspace is active. `ensureSystemPages` may have SKIPPED this page,
 *  so it can be absent for the rest of the session — see the `SystemPage` doc.
 *
 *  The PIN, not `activeWorkspaceIdPreferringHash`: that helper routes a command
 *  to the workspace the hash names mid-switch, which is right for a gesture that
 *  only navigates, but this one WRITES and the read-only gate the write is
 *  checked against moves with the pin (#226). The cost is a gesture fired
 *  mid-switch opening the workspace the user just left — idempotent, and the
 *  next one is correct. */
export const openRecentsPage = async (
  repo: Repo,
): Promise<{blockId: string; workspaceId: string} | null> => {
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) return null
  const page = await getOrCreateRecentsPage(repo, workspaceId)
  return {blockId: page.id, workspaceId}
}
