import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { SqliteStorageEngine, type SqliteStorageOptions } from '@/data/storage/sqliteEngine'
import { FEATURE_SQLITE_BACKEND } from '@/config/featureFlags'

interface StorageContextValue {
  engine: SqliteStorageEngine | null
  isSqliteBackend: boolean
}

const StorageContext = createContext<StorageContextValue>({
  engine: null,
  isSqliteBackend: false,
})

const SQLITE_DEFAULT_OPTIONS: SqliteStorageOptions = {
  filename: 'omniliner-local.db',
}

export function StorageProvider({ children }: { children: ReactNode }) {
  const engine = useMemo(() => {
    if (!FEATURE_SQLITE_BACKEND) return null
    return new SqliteStorageEngine(SQLITE_DEFAULT_OPTIONS)
  }, [])

  useEffect(() => {
    if (!engine) return
    void engine.open()
    return () => {
      void engine.close()
    }
  }, [engine])

  const value = useMemo<StorageContextValue>(() => {
    return {
      engine,
      isSqliteBackend: FEATURE_SQLITE_BACKEND,
    }
  }, [engine])

  return <StorageContext.Provider value={value}>{children}</StorageContext.Provider>
}

export function useStorageEngine(): StorageContextValue {
  return useContext(StorageContext)
}
