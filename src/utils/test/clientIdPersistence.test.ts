// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getClientId, isClientIdPersistent, resetClientIdCache } from '@/utils/clientId'

afterEach(() => { resetClientIdCache(); vi.restoreAllMocks() })

describe('isClientIdPersistent', () => {
  it('is true when the id round-trips through localStorage', () => {
    expect(isClientIdPersistent()).toBe(true)
    const first = getClientId()
    resetClientIdCache()
    expect(getClientId()).toBe(first)
  })

  // The case that matters: a browser that accepts the write and keeps nothing
  // hands out a fresh id every load, so anything keyed on it accumulates
  // history the next session can never read.
  it('is false when the store accepts the write but keeps nothing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {})
    expect(isClientIdPersistent()).toBe(false)
  })

  it('is false when storage access throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError') })
    expect(isClientIdPersistent()).toBe(false)
    expect(getClientId()).toBeTruthy()
  })
})
