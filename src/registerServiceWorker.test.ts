// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkForAppUpdate } from './registerServiceWorker'

// jsdom has no `navigator.serviceWorker`; define a stub per test. checkForAppUpdate
// reads the module-level registration first, which is unset here (register() never
// runs), so it falls through to `navigator.serviceWorker.getRegistration()`.
const stubServiceWorker = (value: unknown) => {
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value })
}

afterEach(() => {
  if ('serviceWorker' in navigator) Reflect.deleteProperty(navigator, 'serviceWorker')
})

describe('checkForAppUpdate', () => {
  it("returns 'no-worker' when service workers are unavailable", async () => {
    stubServiceWorker(undefined)
    expect(await checkForAppUpdate()).toBe('no-worker')
  })

  it("returns 'no-worker' when there is no registration", async () => {
    stubServiceWorker({ getRegistration: async () => null })
    expect(await checkForAppUpdate()).toBe('no-worker')
  })

  it("triggers update() and returns 'up-to-date' when nothing is installing", async () => {
    const update = vi.fn(async () => {})
    stubServiceWorker({ getRegistration: async () => ({ update, installing: null, waiting: null }) })
    expect(await checkForAppUpdate()).toBe('up-to-date')
    expect(update).toHaveBeenCalledOnce()
  })

  it("returns 'update-found' when update() surfaces an installing worker", async () => {
    stubServiceWorker({
      getRegistration: async () => ({ update: async () => {}, installing: {}, waiting: null }),
    })
    expect(await checkForAppUpdate()).toBe('update-found')
  })

  it("returns 'error' when update() rejects", async () => {
    stubServiceWorker({
      getRegistration: async () => ({
        update: async () => {
          throw new Error('offline')
        },
        installing: null,
        waiting: null,
      }),
    })
    expect(await checkForAppUpdate()).toBe('error')
  })
})
