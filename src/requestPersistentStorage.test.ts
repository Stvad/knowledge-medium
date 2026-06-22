// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestPersistentStorage } from './requestPersistentStorage'

const originalStorage = navigator.storage

const setStorage = (value: unknown) => {
  Object.defineProperty(navigator, 'storage', {configurable: true, value})
}

beforeEach(() => {
  localStorage.clear()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  setStorage(originalStorage)
  vi.restoreAllMocks()
})

describe('requestPersistentStorage', () => {
  it('does not re-request when the origin is already persistent', async () => {
    const persist = vi.fn(async () => true)
    setStorage({persisted: vi.fn(async () => true), persist})

    await expect(requestPersistentStorage()).resolves.toBe(true)
    expect(persist).not.toHaveBeenCalled()
  })

  it('requests persistence when not yet persistent and reports the grant', async () => {
    const persist = vi.fn(async () => true)
    setStorage({persisted: vi.fn(async () => false), persist})

    await expect(requestPersistentStorage()).resolves.toBe(true)
    expect(persist).toHaveBeenCalledOnce()
  })

  it('reports a denied request without throwing', async () => {
    setStorage({persisted: vi.fn(async () => false), persist: vi.fn(async () => false)})

    await expect(requestPersistentStorage()).resolves.toBe(false)
  })

  it('does not re-request on a later boot after a denied attempt (no nag)', async () => {
    const persist = vi.fn(async () => false)
    setStorage({persisted: vi.fn(async () => false), persist})

    await requestPersistentStorage()
    await requestPersistentStorage()

    // The attempt marker persists across calls, so persist() runs only once
    // even though persisted() stays false — a denied user isn't re-prompted.
    expect(persist).toHaveBeenCalledOnce()
  })

  it('re-requests after a denied attempt when forced (user-initiated retry)', async () => {
    const persist = vi.fn(async () => false)
    setStorage({persisted: vi.fn(async () => false), persist})

    await requestPersistentStorage()
    await requestPersistentStorage({force: true})

    expect(persist).toHaveBeenCalledTimes(2)
  })

  it('no-ops on engines without the StorageManager persist API', async () => {
    setStorage({getDirectory: vi.fn()})

    await expect(requestPersistentStorage()).resolves.toBe(false)
  })

  it('swallows a thrown permission error', async () => {
    setStorage({
      persisted: vi.fn(async () => {
        throw new Error('blocked')
      }),
      persist: vi.fn(),
    })

    await expect(requestPersistentStorage()).resolves.toBe(false)
  })
})
