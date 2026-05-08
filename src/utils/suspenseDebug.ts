/** Cold-start Suspense tracer.
 *
 *  Two pieces:
 *    - `traceSuspense(label, promise)` — log when a `use(...)` promise
 *      starts being awaited and when it settles. Cached per promise so
 *      `use(...)` still gets a stable identity across renders.
 *    - `recordFallbackShown(name)` — call from a fallback's mount
 *      effect; the returned `hide` runs on unmount. Lets us see which
 *      Suspense boundary's fallback is on screen when.
 *
 *  Enabled by default in dev (`import.meta.env.DEV`); can be toggled
 *  at runtime with `window.__suspenseDebug = true|false`.
 */

const enabled = (): boolean => {
  if (typeof window === 'undefined') return false
  const w = window as { __suspenseDebug?: boolean }
  if (typeof w.__suspenseDebug === 'boolean') return w.__suspenseDebug
  // Cheap dev default — no-op gate is one boolean read per call site
  // when disabled, and the trace itself is one console.log per
  // suspending-promise transition (a handful per cold start).
  return Boolean(import.meta.env.DEV)
}

const bootT0 = (typeof performance !== 'undefined' ? performance.now() : 0)
const sinceBoot = (): number => Math.round(performance.now() - bootT0)

const wrapped = new WeakMap<Promise<unknown>, Promise<unknown>>()

/** Wrap `promise` so begin/settle transitions are logged. The returned
 *  promise has stable identity per input, so `use(traceSuspense(label,
 *  cachedPromise))` keeps React's promise-cache happy. */
export const traceSuspense = <T>(label: string, promise: Promise<T>): Promise<T> => {
  if (!enabled()) return promise
  const cached = wrapped.get(promise as Promise<unknown>) as Promise<T> | undefined
  if (cached) return cached

  const t0 = performance.now()
  console.log(`[suspense] +${sinceBoot()}ms throw: ${label}`)
  const traced = promise.then(
    (value) => {
      const dt = Math.round(performance.now() - t0)
      console.log(`[suspense] +${sinceBoot()}ms settle: ${label} (${dt}ms)`)
      return value
    },
    (error) => {
      const dt = Math.round(performance.now() - t0)
      console.log(`[suspense] +${sinceBoot()}ms reject: ${label} (${dt}ms)`)
      throw error
    },
  )
  wrapped.set(promise as Promise<unknown>, traced)
  return traced
}

interface FallbackHandle {
  hide: () => void
}

const NOOP_HANDLE: FallbackHandle = {hide: () => {}}

/** Call inside a fallback's mount effect; the returned `hide` runs on
 *  unmount. */
export const recordFallbackShown = (name: string): FallbackHandle => {
  if (!enabled()) return NOOP_HANDLE
  const t0 = performance.now()
  console.log(`[suspense] +${sinceBoot()}ms fallback SHOWN: ${name}`)
  return {
    hide: () => {
      const dt = Math.round(performance.now() - t0)
      console.log(`[suspense] +${sinceBoot()}ms fallback HIDDEN: ${name} (${dt}ms shown)`)
    },
  }
}

/** Manual span. Use for non-promise async phases (e.g. inside
 *  `initializePowerSyncDb`) so the cold-start log shows which slice of
 *  a larger promise was actually slow. */
export const traceSuspensePhase = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  if (!enabled()) return fn()
  const t0 = performance.now()
  console.log(`[suspense] +${sinceBoot()}ms phase start: ${label}`)
  try {
    const result = await fn()
    const dt = Math.round(performance.now() - t0)
    console.log(`[suspense] +${sinceBoot()}ms phase end:   ${label} (${dt}ms)`)
    return result
  } catch (error) {
    const dt = Math.round(performance.now() - t0)
    console.log(`[suspense] +${sinceBoot()}ms phase fail:  ${label} (${dt}ms)`)
    throw error
  }
}
