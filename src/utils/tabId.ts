import { v4 as uuidv4 } from 'uuid'

export const TAB_ID_STORAGE_KEY = 'ws-nav.tabId'

let memoizedTabId: string | null = null

export interface TabIdStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const readOrCreateTabId = (
  storage: TabIdStorage,
  makeId: () => string = uuidv4,
): string => {
  const stored = storage.getItem(TAB_ID_STORAGE_KEY)
  if (stored) return stored
  const generated = makeId()
  storage.setItem(TAB_ID_STORAGE_KEY, generated)
  return generated
}

const getSessionStorage = (): Storage | null => {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export const getTabId = (): string => {
  if (memoizedTabId) return memoizedTabId
  const storage = getSessionStorage()
  if (!storage) {
    memoizedTabId = uuidv4()
    return memoizedTabId
  }
  try {
    memoizedTabId = readOrCreateTabId(storage)
  } catch {
    memoizedTabId = uuidv4()
  }
  return memoizedTabId
}

export const __resetTabIdForTesting = (): void => {
  memoizedTabId = null
}
