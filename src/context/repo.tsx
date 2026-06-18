import { createContext, ReactNode, use, useContext } from 'react'
import { PowerSyncContext } from '@powersync/react'
import type { AbstractPowerSyncDatabase } from '@powersync/common'
import { Repo } from '../data/repo'
import { BlockCache } from '@/data/blockCache'
import { useIsLocalOnly, useUser } from '@/components/Login'
import { ensurePowerSyncReady, getPowerSyncDb, syncObserverDepsFor } from '@/data/repoProvider'
import { User } from '@/types.js'
import { memoize } from 'lodash-es'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { staticDataExtensions } from '@/extensions/staticDataExtensions.js'
import { surfaceProcessorRejection } from '@/extensions/processorRejectionToast.js'

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
    const repo = new Repo({
      db,
      cache,
      user: {id: user.id, name: user.name},
      syncObserverDeps: syncObserverDepsFor(user.id),
    })
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
    return repo
  },
  (user, useRemoteSync) => `${user.id}:${useRemoteSync ? 'remote' : 'local'}`,
)

const RepoContext = createContext<Repo | undefined>(undefined)

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
