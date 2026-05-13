import { useEffect, useState } from 'react'
import { useRepo } from '@/context/repo'

export interface DbQueryState<T> {
  data: T[]
  isLoading: boolean
  error: Error | null
}

export const useDbQuery = <T,>(
  sql: string,
  params: readonly unknown[] = [],
): DbQueryState<T> => {
  const repo = useRepo()
  const paramsKey = JSON.stringify(params)
  const [state, setState] = useState<DbQueryState<T>>({
    data: [],
    isLoading: true,
    error: null,
  })

  useEffect(() => {
    let cancelled = false
    const queryParams = JSON.parse(paramsKey) as unknown[]

    const refresh = async () => {
      try {
        const data = await repo.db.getAll<T>(sql, queryParams)
        if (!cancelled) {
          setState({data, isLoading: false, error: null})
        }
      } catch (error) {
        if (!cancelled) {
          setState(current => ({
            ...current,
            isLoading: false,
            error: error instanceof Error ? error : new Error(String(error)),
          }))
        }
      }
    }

    void refresh()
    const unsubscribe = repo.db.onChange({
      onChange: refresh,
      onError: error => {
        if (!cancelled) {
          setState(current => ({
            ...current,
            isLoading: false,
            error: error instanceof Error ? error : new Error(String(error)),
          }))
        }
      },
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [repo, sql, paramsKey])

  return state
}
