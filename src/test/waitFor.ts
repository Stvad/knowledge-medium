import { vi } from 'vitest'

/** Node's smallest timer interval, so a postcondition that settles a few
 *  microtask turns after the act is seen on the next timer tick rather than
 *  after `vi.waitFor`'s default 50ms, which a test pays once per wait. An
 *  async check is never stacked: `vi.waitFor` skips a tick while the previous
 *  check is still pending. */
const POLL_INTERVAL_MS = 1

/** `vi.waitFor` at {@link POLL_INTERVAL_MS}; the timeout default (1000ms) is
 *  `vi.waitFor`'s own. Under fake timers every poll advances the clock by the
 *  interval, so a fake-timer test keeps calling `vi.waitFor` with its own. */
export const waitFor = <T>(
  callback: () => T | Promise<T>,
  options: {readonly timeout?: number} = {},
): Promise<T> => vi.waitFor(callback, {interval: POLL_INTERVAL_MS, ...options})
