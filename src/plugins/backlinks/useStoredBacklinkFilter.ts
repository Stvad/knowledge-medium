import { useCallback, useEffect, useState } from 'react'
import {
  BACKLINK_FILTER_CHANGED_EVENT,
  loadBacklinkFilter,
  saveBacklinkFilter,
  type BacklinkFilterChangedDetail,
} from './filterStorage.ts'
import {
  normalizeBacklinksFilter,
  type BacklinksFilter,
} from './query.ts'

export const useStoredBacklinkFilter = (
  workspaceId: string,
  targetId: string,
): [BacklinksFilter, (filter: BacklinksFilter) => void] => {
  const [filter, setFilterState] = useState<BacklinksFilter>(() =>
    workspaceId ? loadBacklinkFilter(workspaceId, targetId) : {},
  )

  useEffect(() => {
    const handleFilterChange = (event: Event) => {
      const detail = (event as CustomEvent<BacklinkFilterChangedDetail>).detail
      if (
        detail?.workspaceId !== workspaceId ||
        detail.targetId !== targetId
      ) {
        return
      }
      setFilterState(detail.filter)
    }
    window.addEventListener(BACKLINK_FILTER_CHANGED_EVENT, handleFilterChange)
    return () => {
      window.removeEventListener(BACKLINK_FILTER_CHANGED_EVENT, handleFilterChange)
    }
  }, [targetId, workspaceId])

  const setFilter = useCallback((next: BacklinksFilter) => {
    const normalized = normalizeBacklinksFilter(next)
    setFilterState(normalized)
    if (workspaceId) saveBacklinkFilter(workspaceId, targetId, normalized)
  }, [targetId, workspaceId])

  return [filter, setFilter]
}
