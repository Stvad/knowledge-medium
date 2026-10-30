/**
 * Main-thread responsiveness for the interaction record: long animation frames
 * and slow input events, folded into totals for one counter span. OBSERVE ONLY
 * — nothing here wraps or schedules app work; the cost is the observer
 * callbacks for entries the browser produces anyway.
 *
 * The record's other timings are taken request-to-resolution ON the main
 * thread, so a slow one cannot say whether the pool queued it or the thread
 * was too busy to run its continuation. These entries can.
 */
import { TimingReservoir } from '@/data/internals/timingMetrics.js'

/** What "slow" means for both entry types: LoAF's own definition of a long
 *  frame, and the floor Event Timing is asked to report inputs from. */
export const SLOW_MS = 50

/** How long after an input's latest entry a later one may still join it (a
 *  keyup, a pointerup). Inputs are matched by identity, never by proximity, so
 *  a longer horizon cannot merge two of them — it only delays counting one. */
const MERGE_HORIZON_MS = 5_000

/** A span's main-thread responsiveness, as stored.
 *
 *  Covers `observedMs`, NOT the record's `sessionMs`: observation starts when
 *  the recorder does — after boot, which `startup-metrics` records — or at the
 *  last `resetMetrics()`. Normalise by this. It is wall-clock, so idle and
 *  hidden time are inside it.
 *
 *  Frame and input DURATIONS run to the next paint, so a page that cannot paint
 *  (an occluded window, a hidden pane) stretches `totalMs`, `maxMs` and
 *  `slowInputs.duration` with nothing blocking. `blockingMs` and `inputDelay`
 *  count only time the thread was busy. */
export interface ResponsivenessSample {
  observedMs: number
  /** Frames of at least `SLOW_MS`, LIFETIME totals over the observed span.
   *  ABSENT where the browser has no long-animation-frame entries (Safari,
   *  Firefox): not measured. Zeros mean observed, and no frame was long. */
  longFrames?: {
    count: number
    totalMs: number
    blockingMs: number
    /** Style and layout script forced synchronously
     *  (`scripts[].forcedStyleAndLayoutDuration`) — layout thrash, as distinct
     *  from the frame's own rendering. */
    forcedLayoutMs: number
    maxMs: number
  }
  /** Inputs whose next paint came at least `SLOW_MS` later, ONE per user input:
   *  a hover's half-dozen events count once, as do a tap's pointer, mouse and
   *  click events. Hovers count, unlike in INP. ABSENT where the browser has no
   *  Event Timing. A browser that ignores the requested threshold reports from
   *  its own, higher floor, so its counts are not comparable to another's. */
  slowInputs?: {
    /** Lifetime. Slow inputs ONLY — nothing here counts the fast ones, so the
     *  distributions below are conditional on an input being slow and are
     *  never "typical input latency". */
    count: number
    /** ABSENT while `count` is 0: an empty reservoir reports zeros, which
     *  would read as a measured distribution of instant inputs. */
    duration?: InputTimings
    /** Input to its first handler — how long it waited for the thread. */
    inputDelay?: InputTimings
  }
}

/** p50/p95 over the most recent 256 slow inputs, a window like `TimingSample`'s;
 *  `maxMs` is LIFETIME, so a stall early in a long session stays on record. */
export interface InputTimings {
  p50Ms: number
  p95Ms: number
  maxMs: number
}

/** The fields of a long-animation-frame entry this reads. */
export interface LongFrameEntry {
  duration: number
  blockingDuration: number
  scripts: ReadonlyArray<{ forcedStyleAndLayoutDuration: number }>
}

/** The fields of an Event Timing entry this reads. `interactionId` is absent
 *  in browsers that predate it, and 0 for events no discrete input owns. */
export interface InputEventEntry {
  startTime: number
  duration: number
  processingStart: number
  interactionId?: number
}

/** One user input's entries so far. */
interface PendingInput {
  /** The earliest entry's start: the input itself, where later entries (keyup,
   *  pointerup) continue it. Its delay is the input's. */
  firstStart: number
  delay: number
  /** The latest entry's start, which the merge horizon is measured from. */
  lastStart: number
  duration: number
}

const round2 = (ms: number): number => Math.round(ms * 100) / 100

const timings = (window: TimingReservoir, maxMs: number): InputTimings => {
  const s = window.snapshot()
  return { p50Ms: round2(s.p50Ms), p95Ms: round2(s.p95Ms), maxMs: round2(maxMs) }
}

/** The fold, with no observer in it, so a test drives it with plain entries.
 *  Times are on the performance timeline, the one entries are stamped on. */
export class ResponsivenessTotals {
  private readonly frames: boolean
  private readonly inputs: boolean
  private startedAt = 0
  private frameCount = 0
  private frameMs = 0
  private blockingMs = 0
  private forcedLayoutMs = 0
  private maxFrameMs = 0
  /** Each input under every key that names it — its start time, and its
   *  interactionId once one of its entries carries one. */
  private readonly pending = new Map<string, PendingInput>()
  private readonly durations = new TimingReservoir()
  private readonly delays = new TimingReservoir()
  private maxDurationMs = 0
  private maxDelayMs = 0

  constructor(opts: { frames: boolean; inputs: boolean; startedAt: number }) {
    this.frames = opts.frames
    this.inputs = opts.inputs
    this.restart(opts.startedAt)
  }

  addFrames(entries: readonly LongFrameEntry[]): void {
    for (const e of entries) {
      this.frameCount++
      this.frameMs += e.duration
      this.blockingMs += e.blockingDuration
      for (const script of e.scripts) this.forcedLayoutMs += script.forcedStyleAndLayoutDuration
      this.maxFrameMs = Math.max(this.maxFrameMs, e.duration)
    }
  }

  addInputs(entries: readonly InputEventEntry[]): void {
    let newest = -Infinity
    for (const e of entries) {
      newest = Math.max(newest, e.startTime)
      if (e.duration < SLOW_MS) continue
      // Two identities, either of which can name an input first: a tap's
      // mousedown carries no interactionId but shares pointerdown's start, and
      // its pointerup shares the id but not the start.
      const keys = [`t:${e.startTime}`]
      if ((e.interactionId ?? 0) > 0) keys.push(`i:${e.interactionId}`)
      const delay = e.processingStart - e.startTime
      let input = keys.map((k) => this.pending.get(k)).find((p) => p !== undefined)
      if (input === undefined) {
        input = { firstStart: e.startTime, delay, lastStart: e.startTime, duration: e.duration }
      } else {
        input.duration = Math.max(input.duration, e.duration)
        input.lastStart = Math.max(input.lastStart, e.startTime)
        // Events sharing a start are dispatched one after another, so a later
        // one's wait includes the earlier handlers: the least one is the input's.
        if (e.startTime < input.firstStart || (e.startTime === input.firstStart && delay < input.delay)) {
          input.firstStart = e.startTime
          input.delay = delay
        }
      }
      for (const k of keys) this.pending.set(k, input)
    }
    // The memory bound: `sample` settles everything regardless, so this only
    // keeps `pending` to one horizon's inputs between samples.
    this.settleBefore(newest - MERGE_HORIZON_MS)
  }

  /** Inputs not yet counted — what the merge horizon bounds. */
  get pendingInputs(): number {
    return new Set(this.pending.values()).size
  }

  /** Count the inputs no later entry can still join. */
  private settleBefore(cutoff: number): void {
    const settled = new Set<PendingInput>()
    for (const [k, input] of this.pending) {
      if (input.lastStart >= cutoff) continue
      this.pending.delete(k)
      if (settled.has(input)) continue
      settled.add(input)
      this.durations.record(input.duration)
      this.delays.record(input.delay)
      this.maxDurationMs = Math.max(this.maxDurationMs, input.duration)
      this.maxDelayMs = Math.max(this.maxDelayMs, input.delay)
    }
  }

  /** Everything since `startedAt`. An input still inside the merge horizon is
   *  left for a later sample rather than counted twice. */
  sample(now: number): ResponsivenessSample {
    this.settleBefore(now - MERGE_HORIZON_MS)
    const count = this.durations.snapshot().calls
    return {
      observedMs: round2(now - this.startedAt),
      ...(this.frames
        ? {
          longFrames: {
            count: this.frameCount,
            totalMs: round2(this.frameMs),
            blockingMs: round2(this.blockingMs),
            forcedLayoutMs: round2(this.forcedLayoutMs),
            maxMs: round2(this.maxFrameMs),
          },
        }
        : {}),
      ...(this.inputs
        ? {
          slowInputs: count === 0
            ? { count }
            : {
              count,
              duration: timings(this.durations, this.maxDurationMs),
              inputDelay: timings(this.delays, this.maxDelayMs),
            },
        }
        : {}),
    }
  }

  /** Forget everything, an input still pending included: it began in the span
   *  being retired. */
  restart(now: number): void {
    this.startedAt = now
    this.frameCount = 0
    this.frameMs = 0
    this.blockingMs = 0
    this.forcedLayoutMs = 0
    this.maxFrameMs = 0
    this.pending.clear()
    this.durations.reset()
    this.delays.reset()
    this.maxDurationMs = 0
    this.maxDelayMs = 0
  }
}

/** What the recorder samples. */
export interface ResponsivenessSource {
  sample: () => ResponsivenessSample
}

export interface ResponsivenessObserver extends ResponsivenessSource {
  restart: () => void
  stop: () => void
}

/** Start observing, or null where the browser offers neither entry type.
 *
 *  Not `buffered`: the browser's buffer keeps a page's FIRST entries and drops
 *  later ones, so replaying it into a start after boot — or after a toggle —
 *  would report a stale prefix as the present. */
export const observeResponsiveness = (): ResponsivenessObserver | null => {
  const supported = typeof PerformanceObserver === 'undefined'
    ? []
    : PerformanceObserver.supportedEntryTypes ?? []
  const frames = supported.includes('long-animation-frame')
  const inputs = supported.includes('event')
  if (!frames && !inputs) return null
  const totals = new ResponsivenessTotals({ frames, inputs, startedAt: performance.now() })
  const observers: PerformanceObserver[] = []
  if (frames) {
    const observer = new PerformanceObserver((list) => {
      totals.addFrames(list.getEntries() as unknown as LongFrameEntry[])
    })
    observer.observe({ type: 'long-animation-frame' })
    observers.push(observer)
  }
  if (inputs) {
    const observer = new PerformanceObserver((list) => {
      totals.addInputs(list.getEntries() as unknown as InputEventEntry[])
    })
    // `durationThreshold` is missing from the DOM typings.
    observer.observe({ type: 'event', durationThreshold: SLOW_MS } as PerformanceObserverInit)
    observers.push(observer)
  }
  return {
    sample: () => totals.sample(performance.now()),
    restart: () => totals.restart(performance.now()),
    stop: () => { for (const observer of observers) observer.disconnect() },
  }
}
