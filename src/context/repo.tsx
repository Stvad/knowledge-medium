import { createContext, ReactNode, use, useContext } from 'react'
import { PowerSyncContext } from '@powersync/react'
import type { AbstractPowerSyncDatabase } from '@powersync/common'
import { Repo } from '../data/repo'
import { BlockCache } from '@/data/blockCache'
import { useIsLocalOnly, useUser } from '@/components/Login'
import { ensurePowerSyncReady, getPowerSyncDb } from '@/data/repoProvider'
import { User } from '@/types.ts'
import { memoize } from 'lodash'

// Memoize on (userId, useRemoteSync) so toggling local-only doesn't reuse a
// previously-connected repo. In practice the toggle is followed by a reload
// (sign-out / "Use without sync" both reload the page), but keying the cache
// correctly keeps the contract honest.
const initRepo = memoize(
  async (user: User, useRemoteSync: boolean): Promise<Repo> => {
    await ensurePowerSyncReady(user.id, useRemoteSync)
    const db = getPowerSyncDb(user.id)
    const cache = new BlockCache()
    return new Repo({db, cache, user: {id: user.id, name: user.name}})
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
