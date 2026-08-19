import { createContext, ReactNode, use, useCallback, useContext, useRef, useSyncExternalStore } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { createGraphBackfillClaim } from '@/data/internals/graphBackfillClaim'
import { getOrCreateMigrationsPage } from '@/data/migrationsPage'
import { PowerSyncContext } from '@powersync/react'
import type { AbstractPowerSyncDatabase } from '@powersync/common'
import { Repo } from '../data/repo'
import type { ClientContextReader } from '../data/clientContext'
import { BlockCache } from '@/data/blockCache'
import { useIsLocalOnly, useUser } from '@/components/Login'
import { ensurePowerSyncReady, getPowerSyncDb, syncObserverDepsFor } from '@/data/repoProvider'
import { User } from '@/types.js'
import { memoize } from 'lodash-es'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { staticDataExtensions } from '@/extensions/staticDataExtensions.js'
import { surfaceProcessorRejection } from '@/extensions/processorRejectionToast.js'
import { markStartup } from '@/utils/startupTimeline.js'

// Memoize on (userId, useRemoteSync) so toggling local-only doesn't reuse a
// previously-connected repo. In practice the toggle is followed by a reload
// (sign-out / "Use without sync" both reload the page), but keying the cache
// correctly keeps the contract honest.
const initRepo = memoize(
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
      // Identifies which client left an in-flight claim behind. Diagnostic
      // only — nothing branches on exclusivity.
      claimantId: uuidv4(),
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
  (user, useRemoteSync) => `${user.id}:${useRemoteSync ? 'remote' : 'local'}`,
)

// Exported for tests that need to provide a directly-constructed Repo
// (e.g. via createTestRepo) without going through the full PowerSync
// bootstrap in RepoProvider below.
export const RepoContext = createContext<Repo | undefined>(undefined)

export function RepoProvider({children}: { children: ReactNode }) {
  const user = useUser()
  const localOnly = useIsLocalOnly()
  if (!user) {
    throw new Error('User must be set before creating Repo')
  }

  const repoInstance = use(initRepo(user, !localOnly))

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
