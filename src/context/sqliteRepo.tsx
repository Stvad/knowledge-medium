import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { SqliteRepo } from '@/data/sqliteRepo'
import { useStorageEngine } from '@/context/storage'
import { useUser } from '@/components/Login'

const SqliteRepoContext = createContext<SqliteRepo | null>(null)

export function SqliteRepoProvider({ children }: { children: ReactNode }) {
  const { engine, isSqliteBackend, ready } = useStorageEngine()
  const user = useUser()

  if (!isSqliteBackend) {
    return <>{children}</>
  }

  const repo = useMemo(() => {
    if (!engine || !ready || !user) return null
    return new SqliteRepo(engine, user)
  }, [engine, ready, user?.id])

  useEffect(() => {
    if (!repo) return
    void repo.ensureSeedData()
  }, [repo])

  if (!repo) {
    return <div className="p-4 text-slate-400 text-center">Initializing SQLite storage…</div>
  }

  return <SqliteRepoContext.Provider value={repo}>{children}</SqliteRepoContext.Provider>
}

export function useSqliteRepo(): SqliteRepo {
  const repo = useContext(SqliteRepoContext)
  if (!repo) {
    throw new Error('useSqliteRepo must be used within SqliteRepoProvider while SQLite backend is enabled')
  }
  return repo
}
