import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { SqliteStorageEngine, type SqliteStorageOptions } from '@/data/storage/sqliteEngine'
import { FEATURE_SQLITE_BACKEND } from '@/config/featureFlags'

interface StorageContextValue {
  engine: SqliteStorageEngine | null
  isSqliteBackend: boolean
  ready: boolean
}

const StorageContext = createContext<StorageContextValue>({
  engine: null,
  isSqliteBackend: false,
  ready: false,
})

const SQLITE_DEFAULT_OPTIONS: SqliteStorageOptions = {
  filename: 'omniliner-local6.db',
}

export function StorageProvider({ children }: { children: ReactNode }) {
  const engine = useMemo(() => {
    if (!FEATURE_SQLITE_BACKEND) return null
    return new SqliteStorageEngine(SQLITE_DEFAULT_OPTIONS)
  }, [])
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!engine) {
      setReady(false)
      return
    }

    let cancelled = false
    const start = async () => {
      await engine.open()
      if (!cancelled) setReady(true)
    }
    void start()

    return () => {
      cancelled = true
      setReady(false)
      void engine.close()
    }
  }, [engine])

  const value = useMemo<StorageContextValue>(() => {
    return {
      engine,
      isSqliteBackend: FEATURE_SQLITE_BACKEND,
      ready,
    }
  }, [engine, ready])

  return <StorageContext.Provider value={value}>{children}</StorageContext.Provider>
}

export function useStorageEngine(): StorageContextValue {
  return useContext(StorageContext)
}
