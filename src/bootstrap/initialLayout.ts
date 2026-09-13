/**
 * Boot layout resolution: which workspace this run lands on, the §6 access
 * gate, then the bootstrap writes — in that fixed order, because the gate must
 * decide BEFORE any write (those writes would otherwise land plaintext into an
 * encrypted-but-locked workspace).
 *
 * The boot path prepares the result before the React tree renders
 * (`prepareInitialLayout`) so App's first `use()` is a cache hit and mounts no
 * Suspense fallback (see resolvedThenable.ts).
 */
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { getLocalMemberRole, getLocalWorkspace } from '@/data/workspaces.js'
import { parseLayout } from '@/utils/routing.js'
import { resolveWorkspaceEntry } from '@/sync/keys/resolveWorkspaceEntry.js'
import { resolveWorkspace } from '@/bootstrap/resolveWorkspace.js'
import { bootstrapWorkspace } from '@/bootstrap/workspaceBootstrap.js'
import { markStartup } from '@/utils/startupTimeline.js'
import { memoizeAsync } from '@/utils/memoize.js'

export const getCurrentHash = (): string =>
  typeof window === 'undefined' ? '' : window.location.hash

export type InitialLayout =
  | {kind: 'ready'; workspaceId: string; layoutSessionBlock: Block}
  | {
      kind: 'locked'
      workspaceId: string
      workspaceName: string | null
      reason: 'key-required' | 'quarantine'
      canary: string | null
    }
  | {kind: 'waiting'; workspaceId: string}

export const resolveInitialLayout = async (
  repo: Repo,
  requestedHash: string,
  useRemoteSync: boolean,
): Promise<InitialLayout> => {
  const route = parseLayout(requestedHash)

  // Phase 1 — resolve which workspace this run lands on (URL / remembered /
  // ensure-personal / local-only). Pure async; see bootstrap/resolveWorkspace.
  const {id: workspaceId, freshlyCreated} = await resolveWorkspace(
    repo,
    route.workspaceId,
    useRemoteSync,
  )
  repo.setActiveWorkspaceId(workspaceId)

  // Derive read-only from the local membership row. workspace_members rides
  // the same sync stream as workspaces, so for any workspace we just
  // resolved as accessible, the role row is normally already local. Null
  // (membership not yet synced) defaults to read-only=false; if the role
  // is actually 'viewer', the very next sync tick flips us — and any
  // edits attempted in the meantime would be RLS-rejected server-side
  // anyway.
  const role = await getLocalMemberRole(repo, workspaceId, repo.user.id)
  repo.setReadOnly(role === 'viewer')

  // Phase 2 — §6 rule 3 access gate. Resolve whether this workspace can be
  // materialized for us right now BEFORE any bootstrap write below — those
  // writes (daily note, properties/types/recents pages, ui-state) would
  // otherwise write plaintext into an encrypted-but-locked workspace. If it
  // can't, return a `locked`/`waiting` layout and App renders the gate/loader.
  // The read-inputs + decide halves live together in resolveWorkspaceEntry; the
  // local workspace row read is injected to keep that module within sync/keys.
  const entry = await resolveWorkspaceEntry(repo.user.id, workspaceId, id =>
    getLocalWorkspace(repo, id),
  )
  markStartup('workspaceResolved')
  if (entry.kind === 'waiting') {
    // The workspaces row hasn't replicated yet and the pin can't settle access
    // without it. Don't bootstrap (would write plaintext into a possibly-e2ee
    // workspace) and don't gate with a null canary — wait for the row.
    repo.setReadOnly(true)
    return {kind: 'waiting', workspaceId}
  }
  if (entry.kind === 'locked') {
    repo.setReadOnly(true)
    return {
      kind: 'locked',
      workspaceId,
      workspaceName: entry.workspaceName,
      reason: entry.reason,
      canary: entry.canary,
    }
  }

  // Phase 3 — bootstrap writes (remember-as-default, backfills, tutorial, the
  // Properties/Types/Recents pages, ui-state) + URL→layout application. Runs
  // only past the gate; see bootstrap/workspaceBootstrap.
  const layoutSessionBlock = await bootstrapWorkspace({
    repo,
    workspaceId,
    freshlyCreated,
    requestedHash,
    requestedWorkspaceId: route.workspaceId,
  })
  markStartup('bootstrapDone')

  return {kind: 'ready', workspaceId, layoutSessionBlock}
}

const initialLayoutCacheKey = (
  repo: Repo,
  requestedHash: string,
  useRemoteSync: boolean,
  navigationVersion: number,
): string =>
  [
    repo.instanceId,
    requestedHash || '__empty_hash__',
    useRemoteSync ? 'remote' : 'local',
    navigationVersion,
  ].join(':')

/** Memoized per (repo, hash, sync mode, navigation version): the entry is
 *  stamped fulfilled on resolution so `use()` reads a hit synchronously, and a
 *  rejected one is evicted so the next lookup retries. */
export const getInitialLayout = memoizeAsync(
  (repo: Repo, requestedHash: string, useRemoteSync: boolean, navigationVersion: number): Promise<InitialLayout> => {
    void navigationVersion // part of the key only: a bump forces a fresh resolution
    return resolveInitialLayout(repo, requestedHash, useRemoteSync)
  },
  initialLayoutCacheKey,
)


// The hash each repo's boot layout was prepared for. App must key its first
// lookup on this exact string (not a re-read of location.hash — the bootstrap
// landing step may already have rewritten it) or the prepared entry is missed.
const preparedHashes = new Map<number, string>()

/** Resolve the boot layout ahead of the first render so App's `use()` hits a
 *  fulfilled cache entry. */
export const prepareInitialLayout = (repo: Repo, useRemoteSync: boolean): Promise<InitialLayout> => {
  const hash = getCurrentHash()
  preparedHashes.set(repo.instanceId, hash)
  return getInitialLayout(repo, hash, useRemoteSync, 0)
}

export const preparedInitialHash = (repo: Repo): string | undefined =>
  preparedHashes.get(repo.instanceId)
