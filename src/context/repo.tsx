import { createContext, ReactNode, use, useContext } from 'react'
import { PowerSyncContext } from '@powersync/react'
import type { AbstractPowerSyncDatabase } from '@powersync/common'
import { Repo } from '@/data/internals/repo'
import { BlockCache } from '@/data/blockCache'
import { useUser } from '@/components/Login'
import { ensurePowerSyncReady, getPowerSyncDb } from '@/data/repoProvider'
import { User } from '@/types.ts'
import { memoize } from 'lodash'

const initRepo = memoize(async (user: User): Promise<Repo> => {
  await ensurePowerSyncReady(user.id)
  const db = getPowerSyncDb(user.id)
  const cache = new BlockCache()
  return new Repo({db, cache, user: {id: user.id, name: user.name}})
}, (user) => user.id)

const RepoContext = createContext<Repo | undefined>(undefined)

export function RepoProvider({children}: { children: ReactNode }) {
  const user = useUser()
  if (!user) {
    throw new Error('User must be set before creating Repo')
  }

  const repoInstance = use(initRepo(user))

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
