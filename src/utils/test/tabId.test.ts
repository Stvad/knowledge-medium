import { describe, expect, it, beforeEach } from 'vitest'
import {
  __resetTabIdForTesting,
  TAB_ID_STORAGE_KEY,
  getTabId,
  readOrCreateTabId,
  type TabIdStorage,
} from '@/utils/tabId'

class MemoryStorage implements TabIdStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

beforeEach(() => {
  __resetTabIdForTesting()
  window.sessionStorage.clear()
})

describe('getTabId', () => {
  it('persists the generated id in sessionStorage', () => {
    const first = getTabId()
    expect(window.sessionStorage.getItem(TAB_ID_STORAGE_KEY)).toBe(first)
    __resetTabIdForTesting()
    expect(getTabId()).toBe(first)
  })

  it('memoizes within the module lifetime', () => {
    const first = getTabId()
    window.sessionStorage.setItem(TAB_ID_STORAGE_KEY, 'external-change')
    expect(getTabId()).toBe(first)
  })
})

describe('readOrCreateTabId', () => {
  it('reuses an existing storage value', () => {
    const storage = new MemoryStorage()
    storage.setItem(TAB_ID_STORAGE_KEY, 'tab-existing')

    expect(readOrCreateTabId(storage, () => 'tab-new')).toBe('tab-existing')
  })

  it('keeps simulated tabs independent by using each tab storage', () => {
    const tabA = new MemoryStorage()
    const tabB = new MemoryStorage()

    expect(readOrCreateTabId(tabA, () => 'tab-a')).toBe('tab-a')
    expect(readOrCreateTabId(tabB, () => 'tab-b')).toBe('tab-b')
    expect(readOrCreateTabId(tabA, () => 'unused')).toBe('tab-a')
    expect(readOrCreateTabId(tabB, () => 'unused')).toBe('tab-b')
  })
})
