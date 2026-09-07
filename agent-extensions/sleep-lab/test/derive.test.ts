import {describe, expect, it} from 'vitest'

import {deriveMeasures, isMainSession, pickMain, wakeDateOf} from '../src/engine/derive'
import type {ImportedSession, Sample, Stage} from '../src/engine/types'

const at = (time: string): Date => new Date(`2026-02-10T${time}`)

const session = (overrides: Partial<ImportedSession> = {}): ImportedSession => ({
  source: 'health-connect',
  start: at('23:00:00'),
  end: at('23:00:00'), // overwritten by most tests
  stages: [],
  heartRate: [],
  hrv: [],
  spo2: [],
  skinTemp: [],
  respRate: [],
  ...overrides,
})

describe('deriveMeasures', () => {
  it('always derives inBedMinutes from start/end', () => {
    const s = session({start: at('23:00:00'), end: new Date('2026-02-11T07:00:00')})
    expect(deriveMeasures(s).inBedMinutes).toBe(480)
  })

  it('omits stage-derived measures when there are no stages', () => {
    const s = session({start: at('23:00:00'), end: new Date('2026-02-11T07:00:00')})
    const measures = deriveMeasures(s)
    expect(measures.onsetMinutes).toBeUndefined()
    expect(measures.sleepMinutes).toBeUndefined()
    expect(measures.efficiency).toBeUndefined()
  })

  it('computes onset as the leading run before the first sleep stage', () => {
    const start = at('23:00:00')
    const end = new Date('2026-02-11T07:00:00')
    const stages: Stage[] = [
      {kind: 'awake', start, end: at('23:20:00')}, // 20 min leading awake
      {kind: 'light', start: at('23:20:00'), end: new Date('2026-02-11T00:00:00')},
      {kind: 'deep', start: new Date('2026-02-11T00:00:00'), end: new Date('2026-02-11T01:00:00')},
      {kind: 'light', start: new Date('2026-02-11T01:00:00'), end},
    ]
    const measures = deriveMeasures(session({start, end, stages}))
    expect(measures.onsetMinutes).toBe(20)
  })

  it('is 0 onset when the first stage is already sleep', () => {
    const start = at('23:00:00')
    const end = new Date('2026-02-11T07:00:00')
    const stages: Stage[] = [{kind: 'light', start, end}]
    expect(deriveMeasures(session({start, end, stages})).onsetMinutes).toBe(0)
  })

  it('lets a stated onsetMinutes win over a derived zero (first stage already sleep)', () => {
    const start = at('23:00:00')
    const end = new Date('2026-02-11T07:00:00')
    const stages: Stage[] = [{kind: 'light', start, end}]
    const s = session({start, end, stages, stated: {onsetMinutes: 12}})
    expect(deriveMeasures(s).onsetMinutes).toBe(12)
  })

  it('keeps a derived non-zero onset over a stated one', () => {
    const start = at('23:00:00')
    const end = new Date('2026-02-11T07:00:00')
    const stages: Stage[] = [
      {kind: 'awake', start, end: at('23:15:00')}, // 15 min leading awake
      {kind: 'light', start: at('23:15:00'), end},
    ]
    const s = session({start, end, stages, stated: {onsetMinutes: 999}})
    expect(deriveMeasures(s).onsetMinutes).toBe(15)
  })

  it('sums a stage kind across multiple non-contiguous bouts', () => {
    const start = at('23:00:00')
    const end = new Date('2026-02-11T07:00:00')
    const stages: Stage[] = [
      {kind: 'light', start, end: at('23:30:00')},
      {kind: 'deep', start: at('23:30:00'), end: new Date('2026-02-11T00:00:00')}, // 30 min
      {kind: 'light', start: new Date('2026-02-11T00:00:00'), end: new Date('2026-02-11T01:00:00')},
      {kind: 'deep', start: new Date('2026-02-11T01:00:00'), end: new Date('2026-02-11T01:15:00')}, // 15 min
      {kind: 'light', start: new Date('2026-02-11T01:15:00'), end},
    ]
    const measures = deriveMeasures(session({start, end, stages}))
    expect(measures.deepMinutes).toBe(45)
  })

  it('counts consecutive post-onset awake stages as one awakening, and separate bouts as more', () => {
    const start = at('23:00:00')
    const end = new Date('2026-02-11T07:00:00')
    const stages: Stage[] = [
      {kind: 'light', start, end: at('23:30:00')}, // sleep begins immediately: onset 0
      {kind: 'awake', start: at('23:30:00'), end: at('23:35:00')},
      {kind: 'awake', start: at('23:35:00'), end: at('23:40:00')}, // still bout 1 (consecutive)
      {kind: 'deep', start: at('23:40:00'), end: new Date('2026-02-11T01:00:00')},
      {kind: 'awake', start: new Date('2026-02-11T01:00:00'), end: new Date('2026-02-11T01:02:00')}, // bout 2
      {kind: 'light', start: new Date('2026-02-11T01:02:00'), end},
    ]
    const measures = deriveMeasures(session({start, end, stages}))
    expect(measures.awakenings).toBe(2)
    expect(measures.awakeMinutes).toBe(12) // 5 + 5 + 2
  })

  it('excludes the leading awake run from awakeMinutes/awakenings', () => {
    const start = at('22:00:00')
    const end = at('23:00:00')
    const stages: Stage[] = [
      {kind: 'awake', start, end: at('22:40:00')}, // leading run, 40 min — not an "awakening"
      {kind: 'light', start: at('22:40:00'), end},
    ]
    const measures = deriveMeasures(session({start, end, stages}))
    expect(measures.onsetMinutes).toBe(40)
    expect(measures.awakenings).toBe(0)
    expect(measures.awakeMinutes).toBe(0)
  })

  it('computes efficiency as sleepMinutes / inBedMinutes to 3 decimals', () => {
    const start = at('23:00:00')
    const end = new Date('2026-02-11T07:00:00') // 480 min in bed
    const stages: Stage[] = [
      {kind: 'awake', start, end: at('23:30:00')}, // 30 min onset
      {kind: 'light', start: at('23:30:00'), end}, // 450 min sleep
    ]
    const measures = deriveMeasures(session({start, end, stages}))
    expect(measures.sleepMinutes).toBe(450)
    expect(measures.efficiency).toBe(0.938) // 450/480 = 0.9375, rounded to 3 decimals
  })

  it('clips a stage that overruns the session bounds on either side', () => {
    const start = at('23:00:00')
    const end = at('23:30:00')
    const stages: Stage[] = [
      // Starts 10 min before the session and ends 10 min after it — clipped
      // to exactly the 30-minute session window.
      {kind: 'light', start: at('22:50:00'), end: at('23:40:00')},
    ]
    const measures = deriveMeasures(session({start, end, stages}))
    expect(measures.sleepMinutes).toBe(30)
    expect(measures.inBedMinutes).toBe(30)
  })

  it('sorts unsorted stages before deriving', () => {
    const start = at('23:00:00')
    const end = new Date('2026-02-11T01:00:00')
    // Deliberately out of chronological order.
    const stages: Stage[] = [
      {kind: 'deep', start: new Date('2026-02-11T00:00:00'), end: new Date('2026-02-11T01:00:00')},
      {kind: 'awake', start, end: at('23:20:00')},
      {kind: 'light', start: at('23:20:00'), end: new Date('2026-02-11T00:00:00')},
    ]
    const measures = deriveMeasures(session({start, end, stages}))
    expect(measures.onsetMinutes).toBe(20) // only the true leading awake run
    expect(measures.deepMinutes).toBe(60)
  })

  it('takes hrMean/hrMin only from samples inside the session window', () => {
    const start = at('23:00:00')
    const end = new Date('2026-02-11T07:00:00')
    const s = session({
      start,
      end,
      heartRate: [
        {at: at('22:00:00'), value: 100}, // before window — excluded
        {at: at('23:30:00'), value: 60},
        {at: new Date('2026-02-11T02:00:00'), value: 50},
        {at: new Date('2026-02-11T08:00:00'), value: 40}, // after window — excluded
      ],
    })
    const measures = deriveMeasures(s)
    expect(measures.hrMean).toBe(55)
    expect(measures.hrMin).toBe(50)
  })

  it('finds the same in-window samples via binary search (sorted) or a linear scan (unsorted)', () => {
    const start = at('23:00:00')
    const end = new Date('2026-02-11T07:00:00') // an 8h = 480 min window
    // One sample every 15 minutes, from 75 min before `start` to 600 min
    // after it — well past both edges of the window on either side.
    const many: Sample[] = []
    for (let i = -5; i <= 40; i++) {
      many.push({at: new Date(start.getTime() + i * 15 * 60_000), value: i})
    }
    // i=0 (`start`) through i=32 (exactly `end`, 480 min later) are the only
    // ones inside the window: 33 samples, mean 16, min 0.
    const sorted = session({start, end, heartRate: many})
    const unsorted = session({start, end, heartRate: [...many].reverse()})
    const sortedMeasures = deriveMeasures(sorted)
    expect(sortedMeasures.hrMean).toBe(16)
    expect(sortedMeasures.hrMin).toBe(0)
    expect(deriveMeasures(unsorted)).toEqual(sortedMeasures)
  })

  it('omits a vitals measure entirely when no sample falls in the window', () => {
    const start = at('23:00:00')
    const end = new Date('2026-02-11T07:00:00')
    const s = session({start, end, hrv: [{at: at('12:00:00'), value: 42}]})
    expect(deriveMeasures(s).hrv).toBeUndefined()
  })

  it('falls back to stated.sleepMinutes when there are no stages', () => {
    const s = session({
      start: at('23:00:00'),
      end: new Date('2026-02-11T07:00:00'),
      stated: {sleepMinutes: 400},
    })
    expect(deriveMeasures(s).sleepMinutes).toBe(400)
  })

  it('never lets a stated value override a derived one', () => {
    const start = at('23:00:00')
    const end = new Date('2026-02-11T07:00:00')
    const stages: Stage[] = [{kind: 'light', start, end}]
    const s = session({start, end, stages, stated: {sleepMinutes: 1}})
    expect(deriveMeasures(s).sleepMinutes).toBe(480)
  })

  it('takes stated.score as-is — score is never derived', () => {
    const s = session({start: at('23:00:00'), end: new Date('2026-02-11T07:00:00'), stated: {score: 87}})
    expect(deriveMeasures(s).score).toBe(87)
  })

  it('normalizes a stated efficiency given as a 0-100 percent', () => {
    const s = session({start: at('23:00:00'), end: new Date('2026-02-11T07:00:00'), stated: {efficiency: 92}})
    expect(deriveMeasures(s).efficiency).toBe(0.92)
  })

  it('leaves a stated efficiency given as a 0-1 ratio alone', () => {
    const s = session({start: at('23:00:00'), end: new Date('2026-02-11T07:00:00'), stated: {efficiency: 0.92}})
    expect(deriveMeasures(s).efficiency).toBe(0.92)
  })
})

describe('wakeDateOf', () => {
  it('is the local calendar date of the end instant', () => {
    expect(wakeDateOf(new Date('2026-02-11T07:12:00'))).toBe('2026-02-11')
  })
})

describe('isMainSession', () => {
  it('accepts a session ending in the morning wake window and lasting ≥3h', () => {
    expect(isMainSession({start: at('23:00:00'), end: new Date('2026-02-11T07:00:00')})).toBe(true)
  })

  it('rejects a short doze even inside the wake window', () => {
    expect(isMainSession({start: at('06:00:00'), end: at('06:30:00')})).toBe(false)
  })

  it('rejects a long session ending outside the wake window (an evening nap)', () => {
    expect(isMainSession({start: at('12:00:00'), end: at('16:00:00')})).toBe(false)
  })

  it('accepts the boundary at exactly 03:00 and 15:00', () => {
    expect(isMainSession({start: at('00:00:00'), end: at('03:00:00')})).toBe(true)
    expect(isMainSession({start: at('12:00:00'), end: at('15:00:00')})).toBe(true)
  })
})

describe('pickMain', () => {
  it('picks the longest qualifying session, ignoring naps', () => {
    const nap = {start: at('13:00:00'), end: at('13:45:00')} // too short + outside window anyway
    const shortMain = {start: at('01:00:00'), end: at('04:00:00')} // 3h, qualifies
    const longMain = {start: at('23:00:00'), end: new Date('2026-02-11T07:00:00')} // 8h, qualifies
    expect(pickMain([nap, shortMain, longMain])).toBe(2)
  })

  it('is undefined when nothing qualifies', () => {
    const nap = {start: at('13:00:00'), end: at('13:45:00')}
    expect(pickMain([nap])).toBeUndefined()
  })

  it('is undefined for an empty list', () => {
    expect(pickMain([])).toBeUndefined()
  })
})
