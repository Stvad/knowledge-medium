import { createContext, ReactNode, use, useContext } from 'react'
import { PowerSyncContext } from '@powersync/react'
import type { AbstractPowerSyncDatabase } from '@powersync/common'
import { Repo } from '../data/repo'
import { BlockCache } from '@/data/blockCache'
import { useIsLocalOnly, useUser } from '@/components/Login'
import { ensurePowerSyncReady, getPowerSyncDb, syncObserverDepsFor } from '@/data/repoProvider'
import { User } from '@/types.js'
import { memoize } from 'lodash-es'
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
    const repo = new Repo({
      db,
      cache,
      user: {id: user.id, name: user.name},
      syncObserverDeps: syncObserverDepsFor(user.id),
    })
    // The Repo comes up kernel-only (its constructor installs the kernel
    // runtime via `installKernelRuntime`). Plugin data ownership is no
    // longer installed here from a separate `staticDataExtensions` list —
    // it's resolved (toggle-aware) from the single `staticAppExtensions`
    // tree and installed in `bootstrapWorkspace`, before the bootstrap
    // writes that need it (the daily-notes landing resolver, seedTutorial's
    // references processor). Nothing between construction and bootstrap
    // consumes non-kernel plugin data (resolveWorkspace / the access gate /
    // role lookup are kernel-only). Doing the install workspace-side also
    // makes it honour the workspace's toggle overrides, so a disabled
    // plugin's data is genuinely absent rather than silently registered.
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
