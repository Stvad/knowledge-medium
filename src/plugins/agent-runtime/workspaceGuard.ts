import type { Repo } from '@/data/repo'

/** Refuse a bridge mutation aimed at a workspace this client does not have open.
 *
 *  Field-row recognition resolves the definition through
 *  `Repo.propertySchemaResolverFor`, which serves the active workspace and the
 *  retained previous one and fails CLOSED for any other — so a mutation run
 *  against a background workspace runs with recognition off, and a delete
 *  there rewrites `::((fieldId))` field rows to prose instead of leaving the
 *  dangling ref intact (#790).
 *
 *  Not in the kernel: `repo.tx` is workspace-agnostic on purpose — sync
 *  arrival writes background rows through a path that needs no recognition,
 *  and tests seed unopened workspaces directly — so a throw there would refuse
 *  both. The bridge is where a block ID can name a row outside the workspace
 *  its client is paired to. `eval` and raw `sql execute` reach `repo` directly
 *  and stay unguardable. */
export const assertActiveWorkspace = (repo: Repo, verb: string, workspaceId: string): void => {
  if (workspaceId === repo.activeWorkspaceId) return
  throw new Error(
    `${verb}: target is in workspace ${workspaceId}, which is not the active one `
    + `(${repo.activeWorkspaceId ?? 'none'}) in the app tab serving this call. `
    + 'This is not a permission check — the token reaches every workspace of its user, '
    + "and reads can name any of them — but writes resolve through the open workspace's "
    + 'property and alias registries, which resolve nothing for another workspace. '
    + 'Switch the app tab to that workspace and re-run. If another tab already has it open, '
    + `a call carrying workspaceId ${workspaceId}, or made with AGENT_RUNTIME_WORKSPACE=${workspaceId} `
    + 'set, is routed to that tab.',
  )
}

/** `assertActiveWorkspace` for every existing block a verb is about to touch.
 *
 *  Contract for callers:
 *    - MISSING blocks PASS, so each verb still reports its own not-found error.
 *    - The read is raw, not `repo.load`, so it sees tombstones —
 *      `restore-block`'s target always is one.
 *    - Pass the whole id set; it is deduplicated into one query.
 *    - ISSUE THE WRITE on the synchronous path immediately after this
 *      resolves. The lookup is async and the active workspace can move during
 *      it, so the pin re-check at the end is the last word — an await between
 *      it and the write reopens the window it closes.
 *
 *  Two residuals are accepted, both needing the check inside the writing
 *  transaction: an id absent here that sync delivers before the mutator's
 *  transaction opens, and a switch during a `run-action` handler. See the
 *  kernel-side follow-up issue. */
export const assertActiveWorkspaceBlocks = async (
  repo: Repo,
  verb: string,
  blockIds: readonly (string | undefined)[],
): Promise<void> => {
  const unique = [...new Set(blockIds.filter((id): id is string => id !== undefined && id !== ''))]
  if (unique.length === 0) return
  const pinned = repo.activeWorkspaceId
  const rows = await repo.db.getAll<{workspace_id: string}>(
    'SELECT workspace_id FROM blocks WHERE id IN (SELECT value FROM json_each(?))',
    [JSON.stringify(unique)],
  )
  for (const row of rows) assertActiveWorkspace(repo, verb, row.workspace_id)
  if (repo.activeWorkspaceId !== pinned) {
    throw new Error(
      `${verb}: the active workspace changed from ${pinned ?? 'none'} to `
      + `${repo.activeWorkspaceId ?? 'none'} while checking this command's targets. `
      + 'Refusing rather than writing against a registry they were not checked '
      + 'for — re-run against the workspace you want.',
    )
  }
}

export const assertActiveWorkspaceBlock = (
  repo: Repo,
  verb: string,
  blockId: string,
): Promise<void> => assertActiveWorkspaceBlocks(repo, verb, [blockId])
