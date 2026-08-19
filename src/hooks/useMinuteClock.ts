import { useSyncExternalStore } from 'react'

const CLOCK_TICK_MS = 60_000

// Minute-grained clock as an external store — keeps renders pure (no
// `Date.now()` in a component body, which `react-hooks/purity` forbids)
// while letting relative "3m ago" labels drift on their own for as long as
// the consumer is mounted. Snapshot is floored to the tick so equal minutes
// compare `===` and don't re-render every frame.
const subscribeClock = (listener: () => void): (() => void) => {
  const id = window.setInterval(listener, CLOCK_TICK_MS)
  return () => window.clearInterval(id)
}
const getClockSnapshot = (): number => Math.floor(Date.now() / CLOCK_TICK_MS) * CLOCK_TICK_MS
// SSR / pre-hydration has no wall clock; 0 makes relative formatters emit ''.
const getServerClockSnapshot = (): number => 0

/** Current wall-clock time (ms), floored to the minute, as a pure
 *  subscription. Pass the result to `formatRelativeTime`. */
export const useMinuteClock = (): number =>
  useSyncExternalStore(subscribeClock, getClockSnapshot, getServerClockSnapshot)
