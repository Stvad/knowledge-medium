/** Today, as a value that advances when the local calendar date rolls over.
 *
 *  Any surface showing "due today or earlier" and left open past midnight has
 *  to notice — otherwise it stays pinned to yesterday's cutoff. That used to
 *  be a minute-poller copy-pasted into each such component, which meant one
 *  `setInterval` per mounted consumer, all ticking at unrelated offsets.
 *
 *  This is one module-level ticker instead: it starts on the first subscriber
 *  and stops on the last, so an app with no date-sensitive surface open runs
 *  no timer at all. Consumers read it through `useSyncExternalStore`, which
 *  only re-renders them on the minute the date actually changes.
 */
import { useSyncExternalStore } from 'react'
import { CallbackSet } from '@/utils/callbackSet.js'

const ROLLOVER_POLL_MS = 60_000

const startOfLocalDay = (now: Date = new Date()): number =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()

/** Local calendar day as an opaque equality key. Not zero-padded, and
 *  deliberately not changed: persisted review sessions are stamped with it,
 *  and a reformat would invalidate every saved session at once. */
export const localDayKey = (now: Date = new Date()): string =>
  `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`

const subscribers = new CallbackSet('daily-notes.today')
let startOfToday = startOfLocalDay()
let timer: ReturnType<typeof setInterval> | null = null

const tick = (): void => {
  const next = startOfLocalDay()
  if (next === startOfToday) return
  startOfToday = next
  subscribers.notify()
}

const subscribe = (onChange: () => void): (() => void) => {
  const remove = subscribers.add(onChange)
  if (timer === null) {
    // Re-read on (re)start: the module may have been idle across a rollover,
    // so the cached value can be stale by the time someone subscribes again.
    startOfToday = startOfLocalDay()
    timer = setInterval(tick, ROLLOVER_POLL_MS)
  }
  return () => {
    remove()
    if (subscribers.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

const getStartOfToday = (): number => startOfToday

/** Local-midnight timestamp for today, advancing on rollover. Use as the
 *  `now` for `dueBoundary` so an open surface re-cuts itself overnight. */
export const useStartOfToday = (): number =>
  useSyncExternalStore(subscribe, getStartOfToday, getStartOfToday)

/** `localDayKey` for today, advancing on rollover. */
export const useTodayKey = (): string => localDayKey(new Date(useStartOfToday()))
