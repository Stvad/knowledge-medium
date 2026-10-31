import { vi } from 'vitest'

export interface FakeObservation {
  type: string
  init: Record<string, unknown>
  /** Hand entries to the observer's callback, as the browser would. */
  deliver: (entries: unknown[]) => void
}

/** Replace the global `PerformanceObserver` with one supporting exactly
 *  `supportedEntryTypes`. Returns the live observations, which `disconnect`
 *  removes. Undo with `vi.unstubAllGlobals()`. */
export const stubPerformanceObserver = (supportedEntryTypes: string[]): FakeObservation[] => {
  const live: FakeObservation[] = []
  class FakeObserver {
    static supportedEntryTypes = supportedEntryTypes
    private observed: FakeObservation | null = null
    constructor(private readonly cb: (list: { getEntries: () => unknown[] }) => void) {}
    observe(init: { type: string } & Record<string, unknown>) {
      this.observed = { type: init.type, init, deliver: (entries) => this.cb({ getEntries: () => entries }) }
      live.push(this.observed)
    }
    disconnect() {
      const i = this.observed ? live.indexOf(this.observed) : -1
      if (i >= 0) live.splice(i, 1)
    }
  }
  vi.stubGlobal('PerformanceObserver', FakeObserver)
  return live
}

export const observation = (live: FakeObservation[], type: string): FakeObservation => {
  const found = live.find((o) => o.type === type)
  if (!found) throw new Error(`nothing observes ${type}`)
  return found
}
