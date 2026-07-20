import {memoize as lodashMemoize} from 'lodash-es'

/**
 * lodash memoize retyped to return plain `F`. The inferred
 * `F & MemoizedFunction` type leaks @types/lodash into exported declaration
 * types, which declaration emit cannot name portably under pnpm's strict
 * node_modules (TS2883: the emitter won't synthesize a specifier for a
 * package the file never imports). Nothing here uses `.cache`, so the
 * narrower type is also the more honest export surface.
 */
export const memoize = <F extends (...args: never[]) => unknown>(
  fn: F,
  resolver?: (...args: Parameters<F>) => unknown,
): F => lodashMemoize(fn, resolver) as F
