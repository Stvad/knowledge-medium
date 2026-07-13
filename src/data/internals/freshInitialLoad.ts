/** Bounded-retry driver for a definition projector's one-shot "fresh initial"
 *  load.
 *
 *  The definition projectors gate every active-workspace transaction on their
 *  first tick (`ProjectorRuntime.whenPrimed`). A rejected initial `loadFresh`
 *  settles that readiness as failed for the whole pin generation, so — without
 *  a retry — one transient load fault would wedge every write until the next
 *  workspace re-pin. Retrying a bounded number of times with backoff recovers a
 *  transient fault; only a persistent failure reaches `onError` (still
 *  surfaced, never silently retried forever). The live subscription behind the
 *  initial load is unaffected: retries only re-attempt the single fresh
 *  snapshot the projector primes from.
 *
 *  `schedule` is injected so tests can drive the backoff synchronously. */

export const FRESH_INITIAL_LOAD_RETRIES = 3

export const freshInitialRetryDelayMs = (attempt: number): number => 100 * 2 ** attempt

/** Run `run` after `delayMs`; return a canceller for the pending timer. */
export type RetryScheduler = (run: () => void, delayMs: number) => () => void

const defaultScheduler: RetryScheduler = (run, delayMs) => {
  const timer = setTimeout(run, delayMs)
  return () => clearTimeout(timer)
}

export interface FreshInitialLoadOptions {
  readonly retries?: number
  readonly delayMs?: (attempt: number) => number
  readonly schedule?: RetryScheduler
}

/** Drive `loadFresh` with bounded retry. Calls `onLoaded` once with the first
 *  successful value, or `onError` once after exhausting the retry budget.
 *  Returns a cancel function that suppresses any further delivery and clears a
 *  pending retry. */
export const runFreshInitialLoad = <T>(
  loadFresh: () => Promise<T>,
  onLoaded: (value: T) => void,
  onError: (error: unknown) => void,
  options: FreshInitialLoadOptions = {},
): (() => void) => {
  const retries = options.retries ?? FRESH_INITIAL_LOAD_RETRIES
  const delayMs = options.delayMs ?? freshInitialRetryDelayMs
  const schedule = options.schedule ?? defaultScheduler
  let cancelled = false
  let cancelPendingRetry: (() => void) | undefined

  const attempt = (attemptIndex: number): void => {
    void loadFresh().then(
      value => {
        if (!cancelled) onLoaded(value)
      },
      error => {
        if (cancelled) return
        if (attemptIndex < retries) {
          cancelPendingRetry = schedule(() => attempt(attemptIndex + 1), delayMs(attemptIndex))
          return
        }
        onError(error)
      },
    )
  }
  attempt(0)

  return () => {
    cancelled = true
    cancelPendingRetry?.()
  }
}
