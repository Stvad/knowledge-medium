import {
  normalizeBacklinksFilter,
  type BacklinksFilter,
} from './query.ts'

const STORAGE_PREFIX = 'backlinks.filter'
export const BACKLINK_FILTER_CHANGED_EVENT = 'backlinks-filter-changed'

export interface BacklinkFilterChangedDetail {
  workspaceId: string
  targetId: string
  filter: Required<BacklinksFilter>
}

const storageKey = (workspaceId: string, targetId: string): string =>
  `${STORAGE_PREFIX}:${workspaceId}:${targetId}`

const getStorage = (): Storage | null => {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

const parseStoredFilter = (value: unknown): BacklinksFilter => {
  if (!value || typeof value !== 'object') return {}
  const record = value as Record<string, unknown>
  return {
    includeIds: Array.isArray(record.includeIds)
      ? record.includeIds.filter((id): id is string => typeof id === 'string')
      : [],
    removeIds: Array.isArray(record.removeIds)
      ? record.removeIds.filter((id): id is string => typeof id === 'string')
      : [],
  }
}

export const loadBacklinkFilter = (
  workspaceId: string,
  targetId: string,
): BacklinksFilter => {
  const storage = getStorage()
  if (!storage || !workspaceId || !targetId) return {}
  try {
    const raw = storage.getItem(storageKey(workspaceId, targetId))
    if (!raw) return {}
    return normalizeBacklinksFilter(parseStoredFilter(JSON.parse(raw)))
  } catch (error) {
    console.error('Failed to load backlinks filter', error)
    return {}
  }
}

export const saveBacklinkFilter = (
  workspaceId: string,
  targetId: string,
  filter: BacklinksFilter,
): void => {
  const storage = getStorage()
  if (!storage || !workspaceId || !targetId) return
  const normalized = normalizeBacklinksFilter(filter)
  const empty = normalized.includeIds.length === 0 && normalized.removeIds.length === 0
  try {
    if (empty) {
      storage.removeItem(storageKey(workspaceId, targetId))
    } else {
      storage.setItem(storageKey(workspaceId, targetId), JSON.stringify(normalized))
    }
  } catch (error) {
    console.error('Failed to save backlinks filter', error)
  }

  window.dispatchEvent(new CustomEvent<BacklinkFilterChangedDetail>(
    BACKLINK_FILTER_CHANGED_EVENT,
    {detail: {workspaceId, targetId, filter: normalized}},
  ))
}
