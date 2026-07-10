import type { Repo } from '@/data/repo.js'
import {
  canAccessRemoteWorkspace,
  ensureLocalPersonalWorkspace,
  ensurePersonalWorkspace,
  getLocalWorkspace,
  listLocalWorkspaces,
  primeLocalWorkspaceAndMember,
} from '@/data/workspaces.js'
import { recallRememberedWorkspace } from '@/utils/lastWorkspace.js'
import { confirmPlaintextForSession, setModePin } from '@/sync/keys/modePin.js'

// Resolved-workspace bundle. `freshlyCreated` is true only when this run
// inserted a brand-new personal workspace via ensure_personal_workspace;
// the caller uses it to install the starter tutorial alongside today's
// daily note. Any path that returned an existing workspace (URL nav,
// remembered, RPC returned an already-existing row) leaves it false —
// those workspaces already have whatever pages the user has built up.
export interface ResolvedWorkspace {
  id: string
  freshlyCreated: boolean
}

// Pin a workspace plaintext, best-effort: a blocked/quota localStorage write
// must not abort bootstrap (the create dialog catches the same failure). Worst
// case the workspace shows the quarantine gate once on next load.
const pinPlaintextBestEffort = (userId: string, workspaceId: string): void => {
  try {
    setModePin(userId, workspaceId, 'plaintext')
  } catch (err) {
    console.warn(
      `[App] plaintext pin failed for ${workspaceId}; confirming plaintext for this session`,
      err,
    )
    confirmPlaintextForSession(userId, workspaceId)
  }
}

export const resolveWorkspace = async (
  repo: Repo,
  requestedWorkspaceId: string | undefined,
  useRemoteSync: boolean,
): Promise<ResolvedWorkspace> => {
  if (requestedWorkspaceId) {
    // Fast path: if PowerSync has already replicated this workspace into
    // our local DB, RLS allowed it — we have access, trust the URL.
    const localWs = await getLocalWorkspace(repo, requestedWorkspaceId)
    if (localWs) return {id: localWs.id, freshlyCreated: false}

    // Slow path: not local. This could be either "we don't have access"
    // or "we have access but sync hasn't replicated yet". Ask the server
    // (RLS-gated) to disambiguate. We can't poll local sqlite for this:
    // `db.waitForFirstSync` resolves instantly on subsequent sessions
    // (persistent IndexedDB), and a missing row could legitimately mean
    // either case.
    if (useRemoteSync) {
      const access = await canAccessRemoteWorkspace(requestedWorkspaceId)
      if (access.kind === 'allowed') {
        // Server confirms access; getInitialLayout will poll for the blocks
        // to land via sync.
        return {id: requestedWorkspaceId, freshlyCreated: false}
      }
      if (access.kind === 'unknown') {
        // Transport-level failure (offline, 5xx, JWT mid-refresh). We don't
        // know if the user has access. Trust the URL hash rather than
        // silently bumping them to a different workspace — the misroute is
        // worse UX than a momentary "no blocks yet" page (which the user
        // can fix with a reload once back online). If they really lack
        // access, the next online bootstrap re-runs this check and falls
        // through cleanly.
        console.warn(
          `canAccessRemoteWorkspace failed for ${requestedWorkspaceId}; trusting URL workspace and proceeding`,
          access.error,
        )
        return {id: requestedWorkspaceId, freshlyCreated: false}
      }
      console.warn(
        `Workspace ${requestedWorkspaceId} from URL is not accessible; falling back to default workspace.`,
      )
    }
    // Confirmed-denied (or no remote sync) — fall through to default flow.
    // The eventual layout normalization will overwrite the bad hash.
  }

  const remembered = recallRememberedWorkspace()
  if (remembered) {
    const ws = await getLocalWorkspace(repo, remembered)
    if (ws) return {id: ws.id, freshlyCreated: false}
  }

  if (useRemoteSync) {
    const result = await ensurePersonalWorkspace()
    // Prime with the canonical member row from the RPC. Priming with a
    // synthetic id (and waiting for sync to deliver the real one) would
    // leave two membership rows in local sqlite, since the raw table has
    // no (workspace_id, user_id) UNIQUE constraint.
    await primeLocalWorkspaceAndMember(repo, result.workspace, result.member)
    // A workspace WE just created is plaintext-confirmed (§8.1) — pin it so the
    // §6 gate never quarantines it. An already-existing personal workspace
    // (inserted=false) is left for the seed/gate to resolve.
    if (result.inserted) pinPlaintextBestEffort(repo.user.id, result.workspace.id)
    return {id: result.workspace.id, freshlyCreated: result.inserted}
  }

  const locals = await listLocalWorkspaces(repo)
  if (locals.length > 0) return {id: locals[0].id, freshlyCreated: false}

  // Remote sync disabled (e.g. dev mode without VITE_SUPABASE_*) and
  // nothing local yet: synthesize a deterministic per-user personal
  // workspace + owner membership locally so the rest of bootstrap
  // (onboarding seed, daily note + Tutorial bullet via the onboarding
  // landing resolver) can run unchanged.
  const local = await ensureLocalPersonalWorkspace(repo)
  // Same plaintext-confirm as the remote path (§8.1) so the gate stays out of
  // the way in local-only mode.
  if (local.inserted) pinPlaintextBestEffort(repo.user.id, local.workspace.id)
  return {id: local.workspace.id, freshlyCreated: local.inserted}
}
