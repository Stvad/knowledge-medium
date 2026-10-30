// @vitest-environment node
/**
 * Folding long animation frames and slow input events into the stored
 * responsiveness summary, and the observer wiring that feeds it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  observeResponsiveness,
  ResponsivenessTotals,
  type InputEventEntry,
  type LongFrameEntry,
} from '../responsiveness'
import { observation, stubPerformanceObserver } from './fakePerformanceObserver'

const both = (startedAt = 0) => new ResponsivenessTotals({ frames: true, inputs: true, startedAt })

const frame = (duration: number, blockingDuration: number, forced: number[] = []): LongFrameEntry =>
  ({ duration, blockingDuration, scripts: forced.map((f) => ({ forcedStyleAndLayoutDuration: f })) })

const input = (startTime: number, duration: number, over: Partial<InputEventEntry> = {}): InputEventEntry =>
  ({ startTime, duration, processingStart: startTime + 4, interactionId: 0, ...over })

/** Far enough past every entry that nothing is still waiting to be merged. */
const LATER = 1_000_000

describe('long frames', () => {
  it('totals count, duration, blocking and forced layout, and keeps the longest', () => {
    const totals = both()
    totals.addFrames([frame(80, 30, [10, 5]), frame(200, 150, [40])])
    totals.addFrames([frame(60, 10)])
    expect(totals.sample(LATER).longFrames).toEqual({
      count: 3, totalMs: 340, blockingMs: 190, forcedLayoutMs: 55, maxMs: 200,
    })
  })

  // Observed and quiet is a measurement; a browser with no LoAF never measured.
  // The two must not store the same way.
  it('stores zeros when observed and absent when the browser cannot observe', () => {
    expect(both().sample(LATER).longFrames).toEqual({
      count: 0, totalMs: 0, blockingMs: 0, forcedLayoutMs: 0, maxMs: 0,
    })
    const noLoaf = new ResponsivenessTotals({ frames: false, inputs: true, startedAt: 0 })
    expect(noLoaf.sample(LATER).longFrames).toBeUndefined()
    expect(noLoaf.sample(LATER).slowInputs).toEqual({ count: 0 })
  })
})

describe('slow inputs', () => {
  const countOf = (totals: ResponsivenessTotals): number | undefined => totals.sample(LATER).slowInputs?.count

  // One pointer crossing an element boundary dispatches pointerover,
  // pointerenter, mouseover, mouseenter and the matching out/leave events, all
  // stamped with the one native event's time and none carrying an interactionId.
  it('counts a hover once, however many events it dispatched', () => {
    const totals = both()
    totals.addInputs([1, 2, 3, 4, 5, 6].map((i) => input(100, 112, { processingStart: 100 + i })))
    expect(countOf(totals)).toBe(1)
  })

  it('counts two hovers at different times as two', () => {
    const totals = both()
    totals.addInputs([input(100, 112), input(100, 112), input(400, 104), input(400, 104)])
    expect(countOf(totals)).toBe(2)
  })

  // A tap: pointerdown and mousedown share the native press's time but only
  // pointerdown carries the id; pointerup, mouseup and click share the release.
  // Whichever entry arrives first must not split the input in two.
  it('counts a tap once across both identities and both batches', () => {
    const totals = both()
    totals.addInputs([input(100, 64), input(100, 64, { interactionId: 7 })])
    totals.addInputs([
      input(180, 56, { interactionId: 7 }), input(180, 56), input(180, 56, { interactionId: 7 }),
    ])
    expect(countOf(totals)).toBe(1)
  })

  // keydown and keyup are separate frames, so separate observer callbacks.
  it('counts a key press once when keyup arrives in a later batch', () => {
    const totals = both()
    totals.addInputs([input(100, 72, { interactionId: 9 })])
    totals.addInputs([input(1_100, 56, { interactionId: 9 })])
    expect(countOf(totals)).toBe(1)
  })

  it('takes the slowest entry as the input\'s duration', () => {
    const totals = both()
    totals.addInputs([input(100, 64, { interactionId: 3 }), input(160, 240, { interactionId: 3 })])
    expect(totals.sample(LATER).slowInputs?.duration?.maxMs).toBe(240)
  })

  // Events at one start are dispatched in sequence, so a later one's
  // processingStart includes the earlier handlers' run time. The input waited
  // only as long as its first handler did.
  it('takes the input delay from the first event dispatched', () => {
    const totals = both()
    totals.addInputs([
      input(100, 112, { processingStart: 160 }),
      input(100, 112, { processingStart: 130 }),
      input(100, 112, { processingStart: 190 }),
    ])
    expect(totals.sample(LATER).slowInputs?.inputDelay?.maxMs).toBe(30)
  })

  // A held-back pointerdown can be delivered after the pointerup that shares its
  // id. The press is the input, so its delay wins even though it arrived second.
  it('takes the delay of the earliest event even when it arrives last', () => {
    const totals = both()
    totals.addInputs([input(500, 64, { interactionId: 4, processingStart: 502 })])
    totals.addInputs([input(300, 64, { interactionId: 4, processingStart: 340 })])
    expect(totals.sample(LATER).slowInputs?.inputDelay?.maxMs).toBe(40)
  })

  // A browser ignoring `durationThreshold` reports from its own floor; what is
  // stored must still be the population the field names.
  it('ignores entries faster than the slow threshold', () => {
    const totals = both()
    totals.addInputs([input(100, 16), input(200, 40), input(300, 56)])
    expect(countOf(totals)).toBe(1)
  })

  // A reservoir with no samples reports zero percentiles, which would read as a
  // measured distribution of instant inputs.
  it('stores no distributions while no input has been slow', () => {
    const totals = both()
    totals.addInputs([input(100, 16)])
    expect(totals.sample(LATER).slowInputs).toEqual({ count: 0 })
  })

  it('reports p50 and p95 over the inputs counted', () => {
    const totals = both()
    totals.addInputs(Array.from({ length: 20 }, (_, i) => input(i * 10, 50 + i * 10)))
    expect(totals.sample(LATER).slowInputs).toMatchObject({
      count: 20, duration: { p50Ms: 150, p95Ms: 240, maxMs: 240 },
    })
  })

  // The percentiles are a window over recent inputs, like every other timing in
  // the record; the max is the session's, so one bad stall early in a long
  // session is still on record after the window has moved past it.
  it('keeps the lifetime max after the percentile window has moved on', () => {
    const totals = both()
    totals.addInputs([input(0, 1_400)])
    totals.addInputs(Array.from({ length: 300 }, (_, i) => input(10_000 + i * 100, 56)))
    const slow = totals.sample(LATER).slowInputs
    expect(slow?.count).toBe(301)
    expect(slow?.duration?.p95Ms).toBe(56)
    expect(slow?.duration?.maxMs).toBe(1_400)
  })

  // The horizon runs from an input's LATEST entry: a long press is still one
  // input when its release lands more than a horizon after the press, as long
  // as nothing in between went quiet for one.
  it('keeps an input open while its entries keep coming', () => {
    const totals = both()
    totals.addInputs([input(0, 64, { interactionId: 7 })])
    totals.addInputs([input(4_000, 64, { interactionId: 7 })])
    // A fast event moves the clock on without being counted itself.
    totals.addInputs([input(6_000, 16)])
    totals.addInputs([input(8_500, 64, { interactionId: 7 })])
    expect(countOf(totals)).toBe(1)
  })

  // Between samples nothing else settles inputs, so without this a long busy
  // stretch would hold every slow input since the last sample.
  it('holds no more than one merge horizon of inputs between samples', () => {
    const totals = both()
    for (let i = 0; i < 100; i++) totals.addInputs([input(i * 1_000, 64)])
    expect(totals.pendingInputs).toBeLessThanOrEqual(6)
  })

  // An input whose keyup may still be coming is not counted yet: counted now, a
  // late keyup would open a second input under the same id.
  it('leaves an input that can still grow out of the sample until it settles', () => {
    const totals = both()
    totals.addInputs([input(1_000, 64, { interactionId: 2 })])
    expect(totals.sample(2_000).slowInputs).toEqual({ count: 0 })
    totals.addInputs([input(2_500, 56, { interactionId: 2 })])
    expect(totals.sample(LATER).slowInputs?.count).toBe(1)
  })
})

describe('coverage', () => {
  it('reports the wall-clock observed, not the session\'s', () => {
    expect(both(1_000).sample(61_000).observedMs).toBe(60_000)
  })

  // `resetMetrics()` starts a new counter span; the summary must describe the
  // same span as every other field in the record.
  it('starts over on restart', () => {
    const totals = both(0)
    totals.addFrames([frame(80, 30)])
    totals.addInputs([input(100, 64)])
    totals.restart(50_000)
    const sample = totals.sample(LATER)
    expect(sample.observedMs).toBe(LATER - 50_000)
    expect(sample.longFrames?.count).toBe(0)
    expect(sample.slowInputs).toEqual({ count: 0 })
  })

  // An input still pending at the restart belongs to the old span.
  it('drops an input still pending at the restart', () => {
    const totals = both(0)
    totals.addInputs([input(1_000, 64, { interactionId: 5 })])
    totals.restart(1_500)
    totals.addInputs([input(1_600, 56, { interactionId: 5 })])
    expect(totals.sample(LATER).slowInputs?.count).toBe(1)
    expect(totals.sample(LATER).slowInputs?.duration?.maxMs).toBe(56)
  })
})

describe('observeResponsiveness', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('feeds both entry types into the sample', () => {
    const live = stubPerformanceObserver(['long-animation-frame', 'event', 'mark'])
    const observer = observeResponsiveness()!
    expect(live.map((o) => o.type).sort()).toEqual(['event', 'long-animation-frame'])
    observation(live, 'long-animation-frame').deliver([frame(90, 40, [12])])
    // Past the merge horizon, so the sample counts it rather than waiting on it.
    observation(live, 'event').deliver([input(performance.now() - 10_000, 80)])
    const sample = observer.sample()
    expect(sample.longFrames?.count).toBe(1)
    expect(sample.slowInputs?.count).toBe(1)
  })

  // Without the threshold the browser reports only from its default 104ms floor,
  // so every input between 50ms and 104ms would go uncounted.
  it('asks for events from the slow threshold, and no buffered history', () => {
    const live = stubPerformanceObserver(['long-animation-frame', 'event'])
    observeResponsiveness()
    expect(observation(live, 'event').init).toMatchObject({ durationThreshold: 50 })
    // The buffer keeps a page's FIRST entries; replayed into a later start, it
    // would report boot as the present.
    for (const o of live) expect(o.init.buffered).toBeUndefined()
  })

  it('observes only what the browser supports', () => {
    const live = stubPerformanceObserver(['event'])
    const observer = observeResponsiveness()!
    expect(live.map((o) => o.type)).toEqual(['event'])
    expect(observer.sample().longFrames).toBeUndefined()
  })

  it('returns nothing where the browser observes neither', () => {
    stubPerformanceObserver(['mark', 'measure', 'longtask'])
    expect(observeResponsiveness()).toBeNull()
  })

  it('disconnects on stop', () => {
    const live = stubPerformanceObserver(['long-animation-frame', 'event'])
    observeResponsiveness()!.stop()
    expect(live).toEqual([])
  })
})
