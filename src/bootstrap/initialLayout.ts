/**
 * Boot layout resolution: which workspace this run lands on, the §6 access
 * gate, the first-sync gate, then the bootstrap writes — in that fixed order,
 * because both gates must decide BEFORE any write.
 *
 * The boot path prepares the result before the React tree renders
 * (`prepareInitialLayout`) so App's first `use()` is a cache hit and mounts no
 * Suspense fallback (see resolvedThenable.ts).
 */
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { getLocalMemberRole, getLocalWorkspace } from '@/data/workspaces.js'
import { parseLayout } from '@/utils/routing.js'
import { resolveWorkspaceEntry, type EntryLockReason } from '@/sync/keys/resolveWorkspaceEntry.js'
import { resolveWorkspace } from '@/bootstrap/resolveWorkspace.js'
import { bootstrapWorkspace } from '@/bootstrap/workspaceBootstrap.js'
import { markStartup } from '@/utils/startupTimeline.js'
import { memoizeAsync } from '@/utils/memoize.js'
import { forgetWorkspaceFirstSync, readWorkspaceFirstSync, recordWorkspaceFirstSync } from '@/data/workspaceFirstSync.js'

export const getCurrentHash = (): string =>
  typeof window === 'undefined' ? '' : window.location.hash

export type InitialLayout =
  | {kind: 'ready'; workspaceId: string; layoutSessionBlock: Block}
  | {
      kind: 'locked'
      workspaceId: string
      workspaceName: string | null
      reason: EntryLockReason
      canary: string | null
    }
  // Not caught up on this device (`workspaceFirstSync`), or — with
  // `awaitingRow` — its row has not arrived, so access is not decided yet.
  | {
      kind: 'syncing'
      workspaceId: string
      workspaceName: string | null
      awaitingRow: boolean
    }

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
  // Read-only is set once the gates decide, not before: across the awaits the
  // outgoing workspace's tree is only hidden, and a commit it lands then must
  // not be refused. Every gated layout is read-only; `ready` takes the role.
  const gated = (layout: InitialLayout): InitialLayout => {
    repo.setReadOnly(true)
    return layout
  }

  // Phase 2 — §6 rule 3 access gate, BEFORE any bootstrap write: those writes
  // (daily note, properties/types/recents pages, ui-state) would otherwise land
  // plaintext in an encrypted-but-locked workspace. The local workspace row
  // read is injected to keep resolveWorkspaceEntry within sync/keys.
  const entry = await resolveWorkspaceEntry(repo.user.id, workspaceId, id =>
    getLocalWorkspace(repo, id),
  )
  markStartup('workspaceResolved')
  if (entry.kind === 'locked') {
    return gated({
      kind: 'locked',
      workspaceId,
      workspaceName: entry.workspaceName,
      reason: entry.reason,
      canary: entry.canary,
    })
  }
  if (entry.kind === 'waiting') {
    await forgetWorkspaceFirstSync(repo.db, workspaceId)
    return gated({kind: 'syncing', workspaceId, workspaceName: null, awaitingRow: true})
  }

  // Phase 3 — the first-sync gate: bootstrap's get-or-creates must find the
  // server's rows, not race them. Past the access gate, so recording is safe.
  if (freshlyCreated) {
    await recordWorkspaceFirstSync(repo.db, workspaceId)
  } else if (useRemoteSync) {
    const firstSync = await readWorkspaceFirstSync(repo, workspaceId)
    if (firstSync.kind === 'pending') {
      return gated({
        kind: 'syncing',
        workspaceId,
        workspaceName: (await getLocalWorkspace(repo, workspaceId))?.name ?? null,
        awaitingRow: false,
      })
    }
    if (firstSync.kind === 'caught-up') await recordWorkspaceFirstSync(repo.db, workspaceId)
  }

  // A null role (membership not synced yet) opens writable: a viewer's next
  // sync tick flips it, and the server rejects its writes meanwhile.
  const role = await getLocalMemberRole(repo.db, workspaceId, repo.user.id)
  repo.setReadOnly(role === 'viewer')

  // Phase 4 — bootstrap writes (remember-as-default, backfills, tutorial, the
  // Properties/Types/Recents pages, ui-state) + URL→layout application; see
  // bootstrap/workspaceBootstrap.
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
 *  rejected one is evicted so the next lookup retries. Bounded: the version
 *  bumps on every cross-workspace navigation, and each entry retains a Block. */
export const getInitialLayout = memoizeAsync(
  (repo: Repo, requestedHash: string, useRemoteSync: boolean, navigationVersion: number): Promise<InitialLayout> => {
    void navigationVersion // part of the key only: a bump forces a fresh resolution
    return resolveInitialLayout(repo, requestedHash, useRemoteSync)
  },
  initialLayoutCacheKey,
  64,
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
