// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppUpdate } from './appUpdate'
import { checkForAppUpdate, watchServiceWorkerUpdates } from './registerServiceWorker'

class FakeWorker extends EventTarget {
  posted: unknown[] = []
  constructor(public state: ServiceWorkerState) { super() }
  postMessage(message: unknown): void { this.posted.push(message) }
  moveTo(state: ServiceWorkerState): void {
    this.state = state
    this.dispatchEvent(new Event('statechange'))
  }
}

class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null
  waiting: FakeWorker | null = null
  startInstall(): FakeWorker {
    this.installing = new FakeWorker('installing')
    this.dispatchEvent(new Event('updatefound'))
    return this.installing
  }
}

class FakeContainer extends EventTarget {
  constructor(public controller: FakeWorker | null) { super() }
  handOver(): void {
    this.controller = new FakeWorker('activated')
    this.dispatchEvent(new Event('controllerchange'))
  }
}

describe('watchServiceWorkerUpdates', () => {
  const setup = (controlled = true) => {
    const reload = vi.fn()
    const update = createAppUpdate({reload, isEditing: () => false})
    const container = new FakeContainer(controlled ? new FakeWorker('activated') : null)
    const registration = new FakeRegistration()
    const watch = () => watchServiceWorkerUpdates(container, Promise.resolve(registration), update)
    return {reload, update, container, registration, watch}
  }

  it('reports a download, hands over, and reloads once the new worker controls the tab', async () => {
    const {reload, update, container, registration, watch} = setup()
    await watch()
    const next = registration.startInstall()
    expect(update.phase()).toBe('downloading')

    next.moveTo('installed')
    expect(next.posted).toEqual(['SKIP_WAITING'])
    expect(reload).not.toHaveBeenCalled()

    container.handOver()
    expect(update.phase()).toBe('ready')
    expect(reload).toHaveBeenCalledOnce()
  })

  it('treats the first install as no update', async () => {
    const {update, registration, watch} = setup(false)
    await watch()
    registration.startInstall().moveTo('installed')
    expect(update.phase()).toBe('current')
  })

  it('activates a worker left waiting by an earlier visit', async () => {
    const {update, registration, watch} = setup()
    registration.waiting = new FakeWorker('installed')
    await watch()
    expect(registration.waiting.posted).toEqual(['SKIP_WAITING'])
    expect(update.phase()).toBe('downloading')
  })

  it('falls back to current when the download fails', async () => {
    const {update, registration, watch} = setup()
    await watch()
    const next = registration.startInstall()
    registration.installing = null
    next.moveTo('redundant')
    expect(update.phase()).toBe('current')
  })

  it('keeps downloading when a newer install supersedes the first', async () => {
    const {update, registration, watch} = setup()
    await watch()
    const first = registration.startInstall()
    registration.startInstall()
    first.moveTo('redundant')
    expect(update.phase()).toBe('downloading')
  })

  it('reloads on a takeover that lands before the registration resolves', async () => {
    const {reload, update, container, registration} = setup()
    let resolve!: (value: FakeRegistration) => void
    const watching = watchServiceWorkerUpdates(container, new Promise(r => { resolve = r }), update)
    container.handOver()
    expect(reload).toHaveBeenCalledOnce()
    resolve(registration)
    await watching
  })
})

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
