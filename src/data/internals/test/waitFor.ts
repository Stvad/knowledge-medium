import { vi } from 'vitest'

/** `vi.waitFor` polling every millisecond instead of every 50ms: a
 *  postcondition that settles a few microtask turns after the act would
 *  otherwise cost a whole 50ms interval per wait. The timeout default (1000ms)
 *  is `vi.waitFor`'s own. */
export const waitFor = <T>(
  callback: () => T | Promise<T>,
  options: {readonly timeout?: number} = {},
): Promise<T> => vi.waitFor(callback, {interval: 1, ...options})
