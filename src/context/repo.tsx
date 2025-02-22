import { createContext, useContext, useMemo } from 'react'
import { Repo } from '@/data/repo'
import { RepoContext as AutomergeRepoContext } from '@automerge/automerge-repo-react-hooks'
import { ReactNode } from 'react'
import { useUser } from '@/components/Login'
import { automergeRepo, undoRedoManager } from '@/data/repoInstance'

export let repo: Repo | undefined
const RepoContext = createContext<Repo | undefined>(undefined)

export function RepoProvider({ children }: { children: ReactNode }) {
  const user = useUser()
  if (!user) {
    throw new Error('User must be set before creating Repo')
  }

  const repoInstance = useMemo(() => {
    repo = new Repo(automergeRepo, undoRedoManager, user)
    return repo
  }, [user])

  return (
    <RepoContext value={repoInstance}>
      <AutomergeRepoContext value={repoInstance.automergeRepo}>
        {children}
      </AutomergeRepoContext>
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
