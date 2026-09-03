/**
 * Which run of the monitor a verdict belongs to.
 *
 * A verdict rests on page-global counters and on the Repo and workspace it was
 * computed in, and it means something only while the monitor that produced it
 * is still running in that same world.
 *
 * ONE identity says all of that. Minted when the effect starts, dropped when it
 * stops, and compared at BOTH ends — nothing publishes under a run that is over,
 * and nothing READS a verdict from one. The read half is what no publish-side
 * check could give: the store is read synchronously during render, while the
 * effect that would have cleared it runs in a passive effect afterwards, so
 * there is a commit in between that shows the old verdict.
 *
 * Object identity, not a counter: `A→B→A` mints a third run, where a counter
 * comparison has to be relied on to have been bumped on every leg.
 */
import { CallbackSet } from '@/utils/callbackSet.js'

export interface MonitorRun {
  readonly repo: object
  readonly workspaceId: string
}

let current: MonitorRun | null = null
const listeners = new CallbackSet('perf-monitor.run')

/** Fires whenever the run starts or ends. A surface that offers to produce a
 *  verdict has to re-render on this: the analysis store cannot stand in for it,
 *  since a store notification only re-renders a reader whose SNAPSHOT changed,
 *  and with nothing published that snapshot is null on both sides of a
 *  teardown. */
export const subscribeMonitorRun = (listener: () => void): (() => void) =>
  listeners.add(listener)

export const startMonitorRun = (repo: object, workspaceId: string): MonitorRun => {
  current = { repo, workspaceId }
  listeners.notify()
  return current
}

/** Ends `run` if it is still the current one. Guarded, so a teardown arriving
 *  after the next run has started cannot retire its successor. */
export const endMonitorRun = (run: MonitorRun): void => {
  if (current !== run) return
  current = null
  listeners.notify()
}

export const currentMonitorRun = (): MonitorRun | null => current

/** Is the monitor running right now, for this Repo and workspace? A surface
 *  that offers to produce a verdict has to ask: with no run in force nothing
 *  can publish, so the work would be done and discarded. */
export const hasMonitorRunFor = (repo: object, workspaceId: string): boolean =>
  current !== null && current.repo === repo && current.workspaceId === workspaceId

export const isCurrentRun = (run: MonitorRun | null | undefined): boolean =>
  run != null && run === current

/** Test helper — no production caller may end a run it did not start. */
export const resetMonitorRun = (): void => { current = null; listeners.notify() }
