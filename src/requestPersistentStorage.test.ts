// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestPersistentStorage, subscribePersistenceChange } from './requestPersistentStorage'

const originalStorage = navigator.storage
const originalPermissions = navigator.permissions

const setStorage = (value: unknown) => {
  Object.defineProperty(navigator, 'storage', {configurable: true, value})
}

const setPermissionState = (state: PermissionState | undefined) => {
  const value = state === undefined
    ? undefined
    : {query: vi.fn(async () => ({state}))}
  Object.defineProperty(navigator, 'permissions', {configurable: true, value})
}

beforeEach(() => {
  sessionStorage.clear()
  setPermissionState(undefined)
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  setStorage(originalStorage)
  Object.defineProperty(navigator, 'permissions', {configurable: true, value: originalPermissions})
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

  it('asks only once per session, not on every reload within the session', async () => {
    const persist = vi.fn(async () => false)
    setStorage({persisted: vi.fn(async () => false), persist})

    await requestPersistentStorage()
    await requestPersistentStorage()

    expect(persist).toHaveBeenCalledOnce()
  })

  it('retries in a new session so a silent Chromium denial can be re-evaluated', async () => {
    const persist = vi.fn(async () => false)
    setStorage({persisted: vi.fn(async () => false), persist})

    await requestPersistentStorage()
    sessionStorage.clear() // simulate a fresh browsing session
    await requestPersistentStorage()

    expect(persist).toHaveBeenCalledTimes(2)
  })

  it('never re-requests after a durable permission denial (Firefox Block)', async () => {
    const persist = vi.fn(async () => false)
    setStorage({persisted: vi.fn(async () => false), persist})
    setPermissionState('denied')

    await requestPersistentStorage()
    sessionStorage.clear() // even a new session must not re-prompt a blocked user

    await expect(requestPersistentStorage()).resolves.toBe(false)
    expect(persist).not.toHaveBeenCalled()
  })

  it('re-requests when forced, bypassing both the session and permission gates', async () => {
    const persist = vi.fn(async () => false)
    setStorage({persisted: vi.fn(async () => false), persist})
    setPermissionState('denied')

    await expect(requestPersistentStorage({force: true})).resolves.toBe(false)
    expect(persist).toHaveBeenCalledOnce()
  })

  it('no-ops on engines without the StorageManager persist API', async () => {
    setStorage({getDirectory: vi.fn()})

    await expect(requestPersistentStorage()).resolves.toBe(false)
  })

  it('notifies persistence-change subscribers when a request settles', async () => {
    setStorage({persisted: vi.fn(async () => false), persist: vi.fn(async () => true)})
    const listener = vi.fn()
    const unsub = subscribePersistenceChange(listener)

    await requestPersistentStorage()

    // The late-grant case (Firefox prompt) relies on this to refresh the chip.
    expect(listener).toHaveBeenCalledTimes(1)
    unsub()
  })

  it('does not notify when no request is made (already persistent)', async () => {
    setStorage({persisted: vi.fn(async () => true), persist: vi.fn()})
    const listener = vi.fn()
    const unsub = subscribePersistenceChange(listener)

    await requestPersistentStorage()

    expect(listener).not.toHaveBeenCalled()
    unsub()
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
