import { createContext, useContext } from 'react'
import { Repo } from '@/data/repo'
import {RepoContext as AutomergeRepoContext} from '@automerge/automerge-repo-react-hooks'

const RepoContext = createContext<Repo | undefined>(undefined)

import { ReactNode } from 'react'

interface RepoProviderProps {
    children: ReactNode
    value: Repo
}

export function RepoProvider({ children, value }: RepoProviderProps) {
    return (
        <RepoContext.Provider value={value}>
            <AutomergeRepoContext value={value.automergeRepo}>
                {children}
            </AutomergeRepoContext>
        </RepoContext.Provider>
    )
}

export function useRepo(): Repo {
    const context = useContext(RepoContext)
    if (context === undefined) {
        throw new Error('useRepo must be used within a RepoContext')
    }
    return context
}
