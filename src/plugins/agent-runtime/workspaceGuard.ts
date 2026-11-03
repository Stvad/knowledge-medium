import { WorkspaceRegistryUnavailableError } from '@/data/api'
import type { Repo } from '@/data/repo'

/** The kernel's tx admission refusal, raised early: before a bridge verb
 *  parses its payload or creates a target page, and where it answers with an
 *  id that no write re-checks. Inside a tx, `tx.assertWritableWorkspace` is
 *  the same rule. */
export const assertActiveWorkspace = (repo: Repo, workspaceId: string): void => {
  if (workspaceId === repo.activeWorkspaceId) return
  throw new WorkspaceRegistryUnavailableError(repo.activeWorkspaceId ?? null, workspaceId)
}
