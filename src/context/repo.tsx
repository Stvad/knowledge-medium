import { createContext, ReactNode, use, useContext } from 'react'
import { PowerSyncContext } from '@powersync/react'
import { Repo } from '@/data/repo'
import { useUser } from '@/components/Login'
import { ensurePowerSyncReady, powerSyncDb, undoRedoManager } from '@/data/repoInstance'
import { User } from '@/types.ts'
import { memoize } from 'lodash'

const initRepo = memoize(async (user: User) => {
  await ensurePowerSyncReady(user.id)
  return new Repo(powerSyncDb, undoRedoManager, user)
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
      <PowerSyncContext value={repoInstance.db}>
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
