import {memoize as lodashMemoize} from 'lodash-es'

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
 */
export const memoizeAsync = <F extends (...args: never[]) => Promise<unknown>>(
  fn: F,
  resolver: (...args: Parameters<F>) => unknown,
): F => {
  const memoized = lodashMemoize(((...args: Parameters<F>) => {
    const key = resolver(...args)
    const result = fn(...args) as Promise<unknown> & {status?: string}
    // An already-fulfilled thenable (`resolvedThenable`) cannot reject, and the
    // guard would replace it with a fresh promise `use()` has to suspend on —
    // the very thing it exists to avoid.
    if (result.status === 'fulfilled') return result
    const guarded = result.catch((err: unknown) => {
      // Unconditional: an entry a retry has already replaced could be evicted
      // here too, and the only cost is running an idempotent `ensure` twice.
      // Checking identity first would be a guard nothing can pin.
      memoized.cache.delete(key)
      throw err
    }) as Promise<unknown> & {status?: string; value?: unknown}
    // Stamp the settled value the way React does after it has tracked a
    // promise, so a `use()` that first meets this entry AFTER it resolved
    // (a component mounted later than the ensure ran) reads it synchronously
    // instead of suspending once and waiting out the fallback throttle.
    void guarded.then(value => { guarded.status = 'fulfilled'; guarded.value = value }, () => {})
    return guarded
  }) as F, resolver)
  return memoized as F
}
