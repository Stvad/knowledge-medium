import { createContext, ReactNode, useCallback, useContext, useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import { createGraphBackfillClaim } from '@/data/internals/graphBackfillClaim'
import { getOrCreateMigrationsPage } from '@/data/migrationsPage'
import { getClientId } from '@/utils/clientId'
import { PowerSyncContext } from '@powersync/react'
import type { AbstractPowerSyncDatabase } from '@powersync/common'
import { Repo } from '../data/repo'
import type { ClientContextReader } from '../data/clientContext'
import { BlockCache } from '@/data/blockCache'
import { useIsLocalOnly, useUser } from '@/components/Login'
import { ensurePowerSyncReady, getPowerSyncDb, syncObserverDepsFor } from '@/data/repoProvider'
import { User } from '@/types.js'
import { memoizeAsync } from '@/utils/memoize.js'
import type { FulfilledThenable } from '@/utils/resolvedThenable.js'
import { remoteSyncEnabled } from '@/services/powersync.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { staticDataExtensions } from '@/extensions/staticDataExtensions.js'
import { surfaceProcessorRejection } from '@/extensions/processorRejectionToast.js'
import { markStartup } from '@/utils/startupTimeline.js'
import { SuspenseFallback } from '@/components/util/suspense.js'

// Memoize on (userId, useRemoteSync) so toggling local-only doesn't reuse a
// previously-connected repo. In practice the toggle is followed by a reload
// (sign-out / "Use without sync" both reload the page), but keying the cache
// correctly keeps the contract honest.
const repoKey = (user: User, useRemoteSync: boolean): string => `${user.id}:${useRemoteSync ? 'remote' : 'local'}`

const initRepo = memoizeAsync(
  async (user: User, useRemoteSync: boolean): Promise<Repo> => {
    await ensurePowerSyncReady(user.id, useRemoteSync)
    const db = getPowerSyncDb(user.id)
    const cache = new BlockCache()
    // §6 mode/key resolver is built once in repoProvider and shared with the
    // upload connector; the observer deps (decrypt/copy/defer + key lookup)
    // are drawn from it here.
    // The claim needs the Repo it is being built for (tx, db, the settle gate),
    // so it binds lazily. Safe: nothing calls it until a workspace opens, long
    // after construction returns.
    let repoRef: Repo | null = null
    const requireRepo = (): Repo => {
      if (!repoRef) throw new Error('backfill claim used before the repo was constructed')
      return repoRef
    }
    const backfillCompletionClaim = createGraphBackfillClaim({
      get db() { return requireRepo().db },
      // Load-bearing, not diagnostic: `decideClaim` proceeds only when a live
      // claim names US, so this has to survive a reload or a crashed tab —
      // otherwise the device that started a pass can never resume it.
      claimantId: getClientId(),
      tx: (fn, opts) => requireRepo().tx(fn, opts),
      ensureHome: (workspaceId) => getOrCreateMigrationsPage(requireRepo(), workspaceId),
    })
    const repo = new Repo({
      db,
      cache,
      user: {id: user.id, name: user.name},
      syncObserverDeps: syncObserverDepsFor(user.id),
      backfillCompletionClaim,
      // A local-only session still gets a real PowerSyncDatabase, but
      // `ensurePowerSyncReady` returns before `db.connect()` — so the default
      // gate (connected && !downloading) would never open and this session
      // would never run a workspace backfill, on this or any later open. There
      // is no server to be behind here, so nothing to wait for.
      ...(useRemoteSync ? {} : {backfillSyncGate: (cb: () => void) => { cb(); return () => {} }}),
    })
    repoRef = repo
    repo.setFacetRuntime(resolveFacetRuntimeSync(staticDataExtensions, {
      repo,
      workspaceId: null,
      safeMode: false,
      generation: 'repo-bootstrap',
    }))
    // Subscribe at bootstrap so user-surfaceable errors from any
    // `repo.tx` call site (mutators, palette actions, bootstrap writes)
    // route through the toast layer from the moment the repo exists. The
    // subscriber is a GENERIC router (no plugin knowledge): it reads the
    // per-rejection toast contributions off `repo.facetRuntime`, so plugin
    // toasts apply once the app runtime is installed, while early/bootstrap
    // rejections (data-only runtime) surface via the raw-message fallback.
    // The Repo is a process singleton; we don't unsubscribe.
    repo.onUserError(error => surfaceProcessorRejection(error, repo))
    markStartup('repoReady')
    return repo
  },
  repoKey,
)

export type RepoBoot = (user: User, useRemoteSync: boolean) => Promise<Repo>
type Prepare = (repo: Repo, useRemoteSync: boolean) => Promise<unknown>

/** The boot promise resolves only after `prepare` (the app passes the boot-layout
 *  resolution) has run, so App's first `use()` hits a fulfilled cache entry and
 *  the boot path mounts no Suspense fallback (see resolvedThenable.ts). A prepare
 *  failure fails the boot: one attempt, surfaced by the error boundary.
 *  `prepare` is injected from main.tsx, not imported here: this module is
 *  imported by nearly every plugin and the bootstrap graph imports it back. */
export const createRepoBoot = (prepare: Prepare, init: RepoBoot = initRepo): RepoBoot =>
  memoizeAsync(async (user: User, useRemoteSync: boolean): Promise<Repo> => {
    const repo = await init(user, useRemoteSync)
    await prepare(repo, useRemoteSync)
    return repo
  }, repoKey)

const bareBoot = createRepoBoot(async () => {})

// Exported for tests that need to provide a directly-constructed Repo
// (e.g. via createTestRepo) without going through the full PowerSync
// bootstrap in RepoProvider below.
export const RepoContext = createContext<Repo | undefined>(undefined)

/** main.tsx passes the boot that also prepares the layout; a bare repo boot is
 *  the default for other roots and tests. A boot must be memoized per (user,
 *  sync mode): a fresh promise per call would never read as settled here. */
export function RepoProvider({children, boot = bareBoot}: { children: ReactNode; boot?: RepoBoot }) {
  const user = useUser()
  const localOnly = useIsLocalOnly()
  if (!user) {
    throw new Error('User must be set before creating Repo')
  }

  // Waits as plain state, not through `use()`: a Suspense fallback here would
  // be the fallback flip that throttles the layout commit (see createRepoBoot).
  // `memoizeAsync` stamps the promise with React's fulfilled protocol on settle.
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const [failure, setFailure] = useState<{reason: unknown} | null>(null)
  // Not looked up again once it failed: memoizeAsync evicts a rejected entry,
  // so the render that throws to the boundary would otherwise start a second
  // boot (workspace bootstrap writes included) nobody observes.
  const promise = failure ? null : boot(user, remoteSyncEnabled(localOnly)) as FulfilledThenable<Repo>
  const ready = promise?.status === 'fulfilled'
  useEffect(() => {
    if (!promise || ready) return
    let live = true
    void promise.then(() => { if (live) bump() }, (reason: unknown) => { if (live) setFailure({reason}) })
    return () => { live = false }
  }, [promise, ready])
  if (failure) throw failure.reason
  if (!promise || !ready) return <SuspenseFallback/>
  const repoInstance = promise.value as Repo

  return (
    <RepoContext value={repoInstance}>
      <PowerSyncContext value={repoInstance.db as unknown as AbstractPowerSyncDatabase}>
        {children}
      </PowerSyncContext>
    </RepoContext>
  )
}

export function useRepo(): Repo {
  const context = useContext(RepoContext)
  if (context === undefined) {
    throw new Error('useRepo must be used within a RepoContext')
  }
  return context
}

/** The client's indexical "acting-as" state (user, active workspace pin,
 *  active layout session) — see `src/data/clientContext.ts`. Returns the
 *  {@link ClientContextReader} view (reads + subscribe, no set methods —
 *  mutate via `repo.setActiveWorkspaceId` / `repo.setActiveLayoutSessionId`).
 *
 *  Deliberately NOT a separate React context/provider: a `ClientContext`'s
 *  identity is 1:1 with the Repo that constructed it (`repo.client`,
 *  assigned once in Repo's constructor), so a dedicated provider could only
 *  ever restate — or desync from — what `useRepo()` already scopes.
 *  Components that want the acting-as object without spelling
 *  `useRepo().client` use this hook.
 *
 *  Reactive: subscribes to `client.onActingAsChange` so a component reading
 *  `activeWorkspaceId` / `activeLayoutSessionId` through this hook re-renders
 *  on an effective change, rather than silently going stale. The object
 *  identity of `client` itself never changes (it's the same instance for
 *  the Repo's lifetime), so `useSyncExternalStore` tracks a locally-bumped
 *  revision counter purely to force the re-render — the returned value is
 *  still the reader, not the revision. */
export function useClientContext(): ClientContextReader {
  const client = useRepo().client
  const revision = useRef(0)
  const subscribe = useCallback(
    (onStoreChange: () => void) => client.onActingAsChange(() => {
      revision.current++
      onStoreChange()
    }),
    [client],
  )
  const getSnapshot = useCallback(() => revision.current, [])
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return client
}
