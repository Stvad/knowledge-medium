/**
 * Boot layout resolution: which workspace this run lands on, the §6 access
 * gate, then the bootstrap writes — in that fixed order, because each phase
 * depends on the last (the gate must decide BEFORE any write, or those writes
 * land plaintext into an encrypted-but-locked workspace).
 *
 * The result is cached per (repo, hash, sync mode, navigation version) and the
 * cached promise is stamped fulfilled on resolution so `use()` reads it
 * synchronously (`resolvedThenable.ts`): the boot path prepares it before the
 * React tree renders (`prepareInitialLayout`), and a cache hit must never cost
 * a Suspense fallback — React 19 holds a retry commit until 300 ms after the
 * last fallback flip.
 */
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { getLocalMemberRole, getLocalWorkspace } from '@/data/workspaces.js'
import { parseLayout } from '@/utils/routing.js'
import { resolveWorkspaceEntry } from '@/sync/keys/resolveWorkspaceEntry.js'
import { resolveWorkspace } from '@/bootstrap/resolveWorkspace.js'
import { bootstrapWorkspace } from '@/bootstrap/workspaceBootstrap.js'
import { markStartup } from '@/utils/startupTimeline.js'
import { stampFulfilled } from '@/utils/resolvedThenable.js'

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

const INITIAL_LAYOUT_CACHE_LIMIT = 64
const initialLayoutCache = new Map<string, Promise<InitialLayout>>()

// The bootstrap pipeline's composing function: it owns the phase ORDERING that
// was previously encoded only in comments. Three extracted phases run in a fixed
// sequence — resolve the workspace, clear the §6 access gate, then run the
// bootstrap writes — because each depends on the last: the gate must decide
// BEFORE any write (those writes would otherwise land plaintext into an
// encrypted-but-locked workspace). First-run seeding now lives in the
// onboarding plugin's landing resolver, invoked from within
// `bootstrapWorkspace`'s landing step.
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

export const getInitialLayout = (
  repo: Repo,
  requestedHash: string,
  useRemoteSync: boolean,
  navigationVersion: number,
  resolver: typeof resolveInitialLayout = resolveInitialLayout,
): Promise<InitialLayout> => {
  const key = initialLayoutCacheKey(repo, requestedHash, useRemoteSync, navigationVersion)
  const cached = initialLayoutCache.get(key)
  if (cached) {
    initialLayoutCache.delete(key)
    initialLayoutCache.set(key, cached)
    return cached
  }

  const promise = resolver(repo, requestedHash, useRemoteSync)
  initialLayoutCache.set(key, promise)
  void promise.then(value => stampFulfilled(promise, value), () => {})
  if (initialLayoutCache.size > INITIAL_LAYOUT_CACHE_LIMIT) {
    const oldest = initialLayoutCache.keys().next().value
    if (oldest) initialLayoutCache.delete(oldest)
  }
  void promise.catch(() => {
    if (initialLayoutCache.get(key) === promise) initialLayoutCache.delete(key)
  })
  return promise
}


// The hash each repo's boot layout was prepared for. App must key its first
// lookup on this exact string (not a re-read of location.hash — the bootstrap
// landing step may already have rewritten it) or the prepared entry is missed.
const preparedHashes = new Map<number, string>()

/** Resolve the boot layout ahead of the first render so App's `use()` hits a
 *  fulfilled cache entry. Failures are left to that lookup to surface. */
export const prepareInitialLayout = (repo: Repo, useRemoteSync: boolean): Promise<InitialLayout> => {
  const hash = getCurrentHash()
  preparedHashes.set(repo.instanceId, hash)
  return getInitialLayout(repo, hash, useRemoteSync, 0)
}

export const preparedInitialHash = (repo: Repo): string | undefined =>
  preparedHashes.get(repo.instanceId)
