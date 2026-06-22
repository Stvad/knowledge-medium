// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestPersistentStorage } from './requestPersistentStorage'

const originalStorage = navigator.storage

const setStorage = (value: unknown) => {
  Object.defineProperty(navigator, 'storage', {configurable: true, value})
}

beforeEach(() => {
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
