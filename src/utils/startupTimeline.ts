/**
 * Cold-start timeline: a tiny, dependency-free recorder for "how long did
 * boot take, and where did the time go". Boot happens once per page load, so
 * each phase is recorded at most once (first write wins) and the marks live in
 * a module singleton that the lifecycle sites stamp as they pass.
 *
 * All marks are `performance.now()` — ms since `performance.timeOrigin` (the
 * navigation/boot start, T0). The startup-metrics plugin reads the assembled
 * timeline once things settle and persists a record (see
 * `src/plugins/startup-metrics`). Kept here in utils (not a plugin) because the
 * earliest marks are stamped from `context/repo` and `App` — code that must not
 * depend on a plugin.
 *
 * `firstContentPaint` (pixels appeared) is deliberately NOT the headline metric:
 * content can paint and then the main thread gets hammered (the idle-job herd,
 * reprojection, the initial-sync materialization) so the UI is visible but
 * frozen. The headline `interactive` mark is "time to interactivity" proper —
 * the end of the last long task in the boot burst, after which the thread stays
 * free and the UI is actually usable. We approximate it with the Long Tasks API
 * (this module just tracks the long tasks; the plugin runs the quiet-window
 * detection).
 */

import { CallbackSet } from './callbackSet'

/** The boot phases we time, in roughly causal order. `firstContentPaint` is
 *  "pixels appeared"; `interactive` is the headline "contention stopped, UI
 *  usable" (time to interactivity). */
export type StartupPhase =
  | 'repoReady'           // Repo constructed + PowerSync ready
  | 'workspaceResolved'   // active workspace + §6 access gate decided
  | 'bootstrapDone'       // bootstrapWorkspace writes complete
  | 'firstContentPaint'   // first paint of the actual workspace layout (pixels)
  | 'synced'              // PowerSync initial download complete (hasSynced)
  | 'drained'             // our blocks_synced→blocks materialization caught up
  | 'interactive'         // last boot long task ended; main thread went quiet (TTI)

export interface StartupTimeline {
  /** `performance.timeOrigin` — boot start as epoch ms, so the relative marks
   *  can be anchored to wall-clock time. */
  readonly timeOriginMs: number
  /** ms-since-`timeOrigin` for each phase reached so far. A phase absent from
   *  the map was never reached this session. */
  readonly marks: Readonly<Partial<Record<StartupPhase, number>>>
}

const marks: Partial<Record<StartupPhase, number>> = {}

const nowMs = (): number =>
  typeof performance !== 'undefined' ? performance.now() : 0

const timeOrigin = (): number =>
  typeof performance !== 'undefined' ? performance.timeOrigin : 0

/** Stamp `phase` with the current time, unless it's already stamped (boot
 *  happens once — the first occurrence is the real one; React StrictMode
 *  re-invokes and later re-renders must not overwrite it). */
export const markStartup = (phase: StartupPhase): void => {
  if (marks[phase] === undefined) marks[phase] = nowMs()
}

/** Stamp `phase` with a specific timestamp (ms since `timeOrigin`). Used for
 *  marks whose value is a past instant rather than "now" — e.g. `interactive`
 *  is the END of the last long task, detected only after a trailing quiet
 *  window has elapsed. First write wins, as with `markStartup`. */
export const markStartupAt = (phase: StartupPhase, ms: number): void => {
  if (marks[phase] === undefined) marks[phase] = ms
}

export const hasStartupMark = (phase: StartupPhase): boolean =>
  marks[phase] !== undefined

/** Frozen snapshot of the timeline so far. */
export const getStartupTimeline = (): StartupTimeline =>
  Object.freeze({ timeOriginMs: timeOrigin(), marks: Object.freeze({ ...marks }) })

// ──── long-task tracking (for the `interactive` quiet-window detection) ────

let longTaskObserver: PerformanceObserver | null = null
let longTasksObserving = false
let lastLongTaskEndMs: number | null = null
const longTaskSubscribers = new CallbackSet('long-task')

/** Subscribe to long-task occurrences. The callback fires AFTER
 *  `lastLongTaskEndMs` is updated, so a debounced quiet-window detector can
 *  reset its timer from the same event that advanced the value — avoiding the
 *  poll-vs-observer ordering race a `setTimeout`-driven reader would hit.
 *  Returns an unsubscribe. */
export const onLongTask = (cb: () => void): (() => void) => longTaskSubscribers.add(cb)

/** Start observing main-thread long tasks (≥50 ms blocks) as early as possible,
 *  so the plugin can later find the first quiet window. Idempotent and a no-op
 *  where the Long Tasks API is unavailable (Safari, jsdom/node) — there the
 *  plugin falls back to a coarser idle proxy. `buffered: true` recovers long
 *  tasks that fired before this call. */
export const startStartupObservers = (): void => {
  if (longTasksObserving || typeof PerformanceObserver === 'undefined') return
  longTasksObserving = true
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      let advanced = false
      for (const entry of list.getEntries()) {
        const end = entry.startTime + entry.duration
        if (lastLongTaskEndMs === null || end > lastLongTaskEndMs) {
          lastLongTaskEndMs = end
          advanced = true
        }
      }
      // CallbackSet.notify snapshots + isolates listener exceptions, so a
      // throwing subscriber can't break the observer or its peers.
      if (advanced) longTaskSubscribers.notify()
    })
    longTaskObserver.observe({ type: 'longtask', buffered: true })
  } catch {
    // 'longtask' entry type unsupported — leave the observer off.
    longTaskObserver = null
  }
}

/** True once a long-task observer is actually running (so callers can pick the
 *  precise quiet-window path vs the idle-proxy fallback). */
export const longTasksSupported = (): boolean => longTaskObserver !== null

/** End time (ms since `timeOrigin`) of the latest long task seen, or null if
 *  none have occurred / the API is unavailable. */
export const getLastLongTaskEndMs = (): number | null => lastLongTaskEndMs

/** Test helper — clear all marks and reset long-task tracking. */
export const resetStartupTimeline = (): void => {
  for (const key of Object.keys(marks)) delete marks[key as StartupPhase]
  longTaskObserver?.disconnect()
  longTaskObserver = null
  longTasksObserving = false
  lastLongTaskEndMs = null
  longTaskSubscribers.clear()
}
