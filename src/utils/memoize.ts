import {memoize as lodashMemoize} from 'lodash-es'
import {stampFulfilled, type FulfilledThenable} from '@/utils/resolvedThenable'

/**
 * lodash memoize retyped to return plain `F`. The inferred
 * `F & MemoizedFunction` type leaks @types/lodash into exported declaration
 * types, which declaration emit cannot name portably under pnpm's strict
 * node_modules (TS2883: the emitter won't synthesize a specifier for a
 * package the file never imports). The narrower type is also the more honest
 * export surface: `.cache` is an implementation detail of `memoizeAsync` below,
 * not something a caller may reach for.
 */
export const memoize = <F extends (...args: never[]) => unknown>(
  fn: F,
  resolver?: (...args: Parameters<F>) => unknown,
): F => lodashMemoize(fn, resolver) as F

/**
 * `memoize` for a function returning a promise, with one difference that
 * matters: a REJECTED result is evicted, so the next caller retries.
 *
 * Plain `memoize` caches whatever the function returned, and a rejected promise
 * is a perfectly good cache entry — so one transient failure inside an `ensure`
 * answers every later call for the life of the page, and the only cure is a
 * reload. Callers of an `ensure` are written to be retried; callers of a cached
 * rejection are not.
 *
 * What is memoized is the GUARDED promise, not the raw one wrapped per call.
 * Wrapping on the way out would hand every caller a fresh thenable for the same
 * key, and these ensures are passed straight to React `use()` — which requires
 * the same promise across renders and re-suspends forever on a new one.
 *
 * The resolver is REQUIRED here, unlike above: evicting needs the key.
 *
 * `maxEntries` bounds the cache, oldest entry out first, for a key space that
 * grows with use (a navigation counter, a hash) rather than with the data.
 */
export const memoizeAsync = <F extends (...args: never[]) => Promise<unknown>>(
  fn: F,
  resolver: (...args: Parameters<F>) => unknown,
  maxEntries?: number,
): F => {
  // NOT async: an async wrapper would re-wrap the return and drop the
  // fulfilled stamp the fast path below preserves.
  const memoized = lodashMemoize(((...args: Parameters<F>) => {
    const key = resolver(...args)
    const result = fn(...args) as FulfilledThenable<unknown>
    // An already-fulfilled thenable (`resolvedThenable`) cannot reject, and the
    // guard would replace it with a fresh promise `use()` has to suspend on —
    // the very thing it exists to avoid.
    if (result.status === 'fulfilled') return result
    const guarded: FulfilledThenable<unknown> = result.catch((err: unknown) => {
      // Only this entry: a bounded cache can have evicted and re-created the
      // key while this promise was pending, and the newer entry stays.
      if (memoized.cache.get(key) === guarded) memoized.cache.delete(key)
      throw err
    })
    // Stamp on settle, as React does for a promise it has tracked, for the
    // entries that settle under an imperative `await` BEFORE any component
    // `use()`s them (workspace bootstrap's root ui-state + layout session, the
    // deep-idle plugin ui-state pre-warm): their first `use()` would otherwise
    // suspend once and wait out the fallback throttle. React's own stamp
    // already covers an entry a component met while pending.
    void guarded.then(value => { stampFulfilled(guarded, value) }, () => {})
    return guarded
  }) as F, resolver)
  if (maxEntries !== undefined) memoized.cache = boundedCache(maxEntries)
  return memoized as F
}

/** The subset of lodash's MapCache that `memoize` calls, over an insertion-ordered
 *  Map that drops its oldest entry past `limit`. */
const boundedCache = (limit: number): typeof lodashMemoize.Cache extends new () => infer C ? C : never => {
  const map = new Map<unknown, unknown>()
  const cache = {
    has: (key: unknown) => map.has(key),
    get: (key: unknown) => map.get(key),
    delete: (key: unknown) => map.delete(key),
    clear: () => { map.clear() },
    set(key: unknown, value: unknown) {
      map.set(key, value)
      if (map.size > limit) map.delete(map.keys().next().value)
      return cache
    },
  }
  return cache as never
}
