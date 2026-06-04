import { createContext, ReactNode, use, useContext } from 'react'
import { PowerSyncContext } from '@powersync/react'
import type { AbstractPowerSyncDatabase } from '@powersync/common'
import { Repo } from '../data/repo'
import { BlockCache } from '@/data/blockCache'
import { useIsLocalOnly, useUser } from '@/components/Login'
import { ensurePowerSyncReady, getPowerSyncDb } from '@/data/repoProvider'
import { createSyncResolver } from '@/sync/keys/resolver.js'
import { getWorkspaceKeyStore } from '@/sync/keys/keyStore.js'
import { User } from '@/types.js'
import { memoize } from 'lodash'
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
import { staticDataExtensions } from '@/extensions/staticDataExtensions.js'
import { surfaceProcessorRejectionFor } from '@/utils/processorRejectionToast.js'

// Memoize on (userId, useRemoteSync) so toggling local-only doesn't reuse a
// previously-connected repo. In practice the toggle is followed by a reload
// (sign-out / "Use without sync" both reload the page), but keying the cache
// correctly keeps the contract honest.
const initRepo = memoize(
  async (user: User, useRemoteSync: boolean): Promise<Repo> => {
    // ensurePowerSyncReady runs the §6 rollout pin-seed between db.init() and
    // db.connect(), so pins are settled (from pre-connect on-disk rows only)
    // before the observer/gate read them below.
    await ensurePowerSyncReady(user.id, useRemoteSync)
    const db = getPowerSyncDb(user.id)
    // §6 mode/key resolver — shared store + pins drive both the observer
    // (decrypt/copy/defer) and (via the connector) encrypt-on-upload.
    const resolver = createSyncResolver(() => user.id, getWorkspaceKeyStore())
    const cache = new BlockCache()
    const repo = new Repo({
      db,
      cache,
      user: {id: user.id, name: user.name},
      syncObserverDeps: {
        getMaterializability: resolver.getMaterializability,
        getCek: resolver.getCek,
      },
    })
    repo.setFacetRuntime(resolveFacetRuntimeSync(staticDataExtensions, {
      repo,
      workspaceId: null,
      safeMode: false,
      generation: 'repo-bootstrap',
    }))
    // Subscribe at bootstrap so user-surfaceable errors from any
    // `repo.tx` call site (mutators, palette actions, programmatic
    // writes, etc.) route through the toast layer without each call
    // site having to know about `ProcessorRejection`. The Repo is a
    // process singleton in practice; we don't bother unsubscribing.
    repo.onUserError(surfaceProcessorRejectionFor(repo))
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
