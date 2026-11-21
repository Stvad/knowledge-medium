// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appUpdate } from './appUpdate.js'
import { checkForAppUpdate } from './registerServiceWorker'

// Manual checks use getRegistration when this module has not registered a worker.
const stubServiceWorker = (value: unknown) => {
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value })
}

class TestWorker extends EventTarget {
  postMessage = vi.fn()
  constructor(public state: ServiceWorkerState) { super() }
  transition(next: ServiceWorkerState) {
    this.state = next
    this.dispatchEvent(new Event('statechange'))
  }
}

const fakeWorker = (state: ServiceWorkerState) => {
  const worker = new TestWorker(state)
  vi.spyOn(worker, 'removeEventListener')
  return worker
}

afterEach(() => {
  if ('serviceWorker' in navigator) Reflect.deleteProperty(navigator, 'serviceWorker')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
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

  it('waits through installing, installed, and activating until the worker is activated', async () => {
    const worker = fakeWorker('installing')
    const addListener = vi.spyOn(worker, 'addEventListener')
    stubServiceWorker({
      getRegistration: async () => ({update: async () => {}, installing: worker, waiting: null, active: null}),
    })

    let settled = false
    const result = checkForAppUpdate().then(value => {
      settled = true
      return value
    })
    await vi.waitFor(() => expect(addListener).toHaveBeenCalledWith('statechange', expect.any(Function)))
    expect(settled).toBe(false)

    worker.transition('installed')
    expect(worker.postMessage).toHaveBeenCalledWith('SKIP_WAITING')
    expect(worker.removeEventListener).not.toHaveBeenCalled()
    expect(settled).toBe(false)
    worker.transition('activating')
    expect(worker.removeEventListener).not.toHaveBeenCalled()
    expect(settled).toBe(false)
    worker.transition('activated')
    expect(await result).toBe('update-found')
    expect(worker.removeEventListener).toHaveBeenCalledWith('statechange', expect.any(Function))
  })

  it('asks an installed waiting worker to skip waiting and waits for activation', async () => {
    const worker = fakeWorker('installed')
    const addListener = vi.spyOn(worker, 'addEventListener')
    stubServiceWorker({
      getRegistration: async () => ({update: async () => {}, installing: null, waiting: worker, active: null}),
    })

    let settled = false
    const result = checkForAppUpdate().then(value => {
      settled = true
      return value
    })
    await vi.waitFor(() => expect(addListener).toHaveBeenCalledWith('statechange', expect.any(Function)))
    expect(worker.postMessage).toHaveBeenCalledWith('SKIP_WAITING')
    expect(worker.removeEventListener).not.toHaveBeenCalled()
    expect(settled).toBe(false)
    worker.transition('activating')
    expect(worker.removeEventListener).not.toHaveBeenCalled()
    expect(settled).toBe(false)
    worker.transition('activated')
    expect(await result).toBe('update-found')
    expect(worker.removeEventListener).toHaveBeenCalledWith('statechange', expect.any(Function))
  })

  it("returns 'error' when an update worker becomes redundant", async () => {
    const worker = fakeWorker('installing')
    const addListener = vi.spyOn(worker, 'addEventListener')
    stubServiceWorker({
      getRegistration: async () => ({update: async () => {}, installing: worker, waiting: null, active: null}),
    })

    const result = checkForAppUpdate()
    await vi.waitFor(() => expect(addListener).toHaveBeenCalledWith('statechange', expect.any(Function)))
    worker.transition('redundant')
    expect(await result).toBe('error')
    expect(worker.removeEventListener).toHaveBeenCalledWith('statechange', expect.any(Function))
  })

  it('waits for an active worker that is still activating', async () => {
    const worker = fakeWorker('activating')
    const addListener = vi.spyOn(worker, 'addEventListener')
    stubServiceWorker({
      getRegistration: async () => ({update: async () => {}, installing: null, waiting: null, active: worker}),
    })

    let settled = false
    const result = checkForAppUpdate().then(value => {
      settled = true
      return value
    })
    await vi.waitFor(() => expect(addListener).toHaveBeenCalledWith('statechange', expect.any(Function)))
    expect(settled).toBe(false)
    worker.transition('activated')
    expect(await result).toBe('update-found')
    expect(worker.removeEventListener).toHaveBeenCalledWith('statechange', expect.any(Function))
  })

  it("returns 'update-found' when an update was already marked available", async () => {
    vi.spyOn(appUpdate, 'isAvailable').mockReturnValue(true)
    stubServiceWorker({
      getRegistration: async () => ({update: async () => {}, installing: null, waiting: null, active: null}),
    })
    expect(await checkForAppUpdate()).toBe('update-found')
  })

  it.each([
    [true, 'activated'],
    [false, 'activated'],
    [true, 'redundant'],
  ] as const)('background update with controller=%s and terminal state=%s', async (hasController, terminalState) => {
    vi.resetModules()
    const {registerServiceWorker} = await import('./registerServiceWorker')
    const {appUpdate: backgroundUpdate} = await import('./appUpdate.js')
    vi.stubEnv('PROD', true)
    vi.stubGlobal('setInterval', vi.fn())
    vi.spyOn(document, 'addEventListener').mockImplementation(() => {})
    vi.spyOn(window, 'addEventListener').mockImplementation(() => {})
    const worker = fakeWorker('installing')
    const addListener = vi.spyOn(worker, 'addEventListener')
    const registration = Object.assign(new EventTarget(), {
      update: vi.fn(async () => {}),
      installing: worker,
      waiting: null,
      active: null,
    })
    const addRegistrationListener = vi.spyOn(registration, 'addEventListener')
    stubServiceWorker({
      controller: hasController ? {} : null,
      register: async () => registration,
    })
    const markAvailable = vi.spyOn(backgroundUpdate, 'markAvailable').mockImplementation(() => {})

    registerServiceWorker()
    await vi.waitFor(() => expect(addRegistrationListener).toHaveBeenCalledWith('updatefound', expect.any(Function)))
    if (!hasController) {
      expect(addListener).not.toHaveBeenCalled()
      worker.transition('activated')
      expect(markAvailable).not.toHaveBeenCalled()
      return
    }
    await vi.waitFor(() => expect(addListener).toHaveBeenCalledWith('statechange', expect.any(Function)))
    worker.transition('installed')
    expect(markAvailable).not.toHaveBeenCalled()
    expect(worker.postMessage).toHaveBeenCalledWith('SKIP_WAITING')
    worker.transition('activating')
    expect(markAvailable).not.toHaveBeenCalled()
    worker.transition(terminalState)
    await Promise.resolve()
    expect(markAvailable).toHaveBeenCalledTimes(terminalState === 'activated' ? 1 : 0)
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
