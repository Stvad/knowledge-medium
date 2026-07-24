import {describe, expect, it} from 'vitest'

import {prescribe} from '../src/engine/prescribe'
import {DEFAULT_CONFIG} from '../src/program/defaults'
import type {LayoffRecord, SessionType, SetRecord, WorkoutRecord} from '../src/engine/types'

const at = (weight: number, ...reps: number[]): SetRecord[] =>
  reps.map(r => ({weight, reps: r}))

const sessionA = (day: string, benchSets: SetRecord[], prescribedSets = 3): WorkoutRecord => ({
  id: day,
  date: `${day}T23:20:00`,
  session: 'A',
  exercises: [{exercise: 'Bench press', prescribedSets, sets: benchSets}],
})

const forExercise = (
  result: ReturnType<typeof prescribe>,
  name: string,
) => result.exercises.find(e => e.exercise === name)!

const run = (opts: {
  history: WorkoutRecord[]
  layoffs?: LayoffRecord[]
  now: string
  session?: SessionType
}) => prescribe({
  history: opts.history,
  layoffs: opts.layoffs ?? [],
  config: DEFAULT_CONFIG,
  now: opts.now,
  session: opts.session,
})

describe('prescribe — session selection', () => {
  it('reads the weekly template', () => {
    expect(run({history: [], now: '2026-07-23T23:00:00'}).session).toBe('A')
    expect(run({history: [], now: '2026-07-19T23:00:00'}).session).toBe('B')
  })

  it('assigns a 1am session to the night it started', () => {
    // 00:40 Monday is Sunday's Session B, not an off-schedule Monday.
    const result = run({history: [], now: '2026-07-20T00:40:00'})
    expect(result.day).toBe('2026-07-19')
    expect(result.session).toBe('B')
    expect(result.offSchedule).toBe(false)
  })

  it('lists only the exercises for that session', () => {
    const names = run({history: [], now: '2026-07-23T23:00:00'}).exercises.map(e => e.exercise)
    expect(names).toContain('Bench press')
    expect(names).not.toContain('Squat')
  })
})

describe('prescribe — double progression', () => {
  it('holds the weight until the top of the range is cleared on every set', () => {
    const history = [sessionA('2026-07-16', at(135, 10, 10, 9))]
    const bench = forExercise(run({history, now: '2026-07-23T23:00:00'}), 'Bench press')
    expect(bench.weight).toBe(135)
    expect(bench.sets).toBe(3)
    expect(bench.rationale).toContain('hold 135')
  })

  it('adds 5 lb after three sets of ten', () => {
    const history = [
      sessionA('2026-07-02', at(135, 10, 10, 10)),
      sessionA('2026-07-09', at(135, 10, 10, 10)),
      sessionA('2026-07-16', at(135, 10, 10, 10)),
    ]
    const bench = forExercise(run({history, now: '2026-07-23T23:00:00'}), 'Bench press')
    expect(bench.weight).toBe(140)
    expect(bench.rationale).toContain('+5')
  })

  it('adds 10 lb on a lower-body lift', () => {
    const history: WorkoutRecord[] = [{
      id: 'b', date: '2026-07-19T23:00:00', session: 'B',
      exercises: [{exercise: 'Squat', prescribedSets: 3, sets: at(185, 10, 10, 10)}],
    }]
    const squat = forExercise(run({history, now: '2026-07-26T23:00:00'}), 'Squat')
    expect(squat.weight).toBe(195)
  })

  it('asks for a starting weight when there is no history', () => {
    const bench = forExercise(run({history: [], now: '2026-07-23T23:00:00'}), 'Bench press')
    expect(bench.weight).toBeUndefined()
    expect(bench.rationale).toContain('RPE 8')
  })

  it('ignores a partially logged session tonight when deriving the target', () => {
    const history = [
      sessionA('2026-07-16', at(135, 10, 10, 10)),
      sessionA('2026-07-23', at(140, 6)),
    ]
    const bench = forExercise(run({history, now: '2026-07-23T23:50:00'}), 'Bench press')
    expect(bench.weight).toBe(140)
  })
})

describe('prescribe — re-entry', () => {
  it('applies 90% after a 20-day gap and says so', () => {
    const history = [sessionA('2026-07-03', at(135, 10, 10, 10))]
    const result = run({history, now: '2026-07-23T23:00:00'})
    expect(result.reentry?.tier.id).toBe('2-4w')
    expect(result.reentry?.banner).toContain('20-day gap')
    const bench = forExercise(result, 'Bench press')
    // 90% of 135 = 121.5, rounded down onto 5 lb plates.
    expect(bench.weight).toBe(120)
    expect(bench.sets).toBe(3)
    expect(bench.rationale).toContain('90% of 135')
  })

  it('returns to normal progression after two comeback sessions (acceptance #2)', () => {
    // Pre-break Session A, then a 21-day gap, then two comeback sessions.
    const layoff: LayoffRecord = {
      id: 'l', from: '2026-06-25', to: '2026-07-16', days: 21, tierId: '2-4w', pct: 0.9,
    }
    // First night back: 90% of 135 = 120 (rounded down).
    const first = run({history: [sessionA('2026-06-25', at(135, 10, 10, 10))], now: '2026-07-16T23:00:00'})
    expect(first.reentry?.tier.id).toBe('2-4w')
    expect(forExercise(first, 'Bench press').weight).toBe(120)

    // Second night back: still under the tier, still 90%.
    const historyTwo = [sessionA('2026-06-25', at(135, 10, 10, 10)), sessionA('2026-07-16', at(120, 10, 10, 10))]
    const second = run({history: historyTwo, layoffs: [layoff], now: '2026-07-23T23:00:00'})
    expect(second.reentry?.sessionsBack).toBe(1)
    expect(forExercise(second, 'Bench press').weight).toBe(120)

    // Third night: ramp done, double progression resumes off the lifted 120.
    const historyThree = [...historyTwo, sessionA('2026-07-23', at(120, 10, 10, 10))]
    const third = run({history: historyThree, layoffs: [layoff], now: '2026-07-30T23:00:00'})
    expect(third.reentry).toBeUndefined()
    expect(forExercise(third, 'Bench press').weight).toBe(125)
  })

  it('drops one set on the first session back from 1–2 weeks', () => {
    const history = [sessionA('2026-07-09', at(135, 8, 8, 8))]
    const result = run({history, now: '2026-07-23T23:00:00'})
    expect(result.reentry?.tier.id).toBe('1-2w')
    const bench = forExercise(result, 'Bench press')
    expect(bench.sets).toBe(2)
    expect(bench.weight).toBe(135)
  })

  it('holds a skipped lift while the on-cadence lifts around it progress', () => {
    // Bench (Session A) last done 13 days ago; a Session B in between keeps
    // training globally on schedule, so no layoff is recorded — but bench
    // itself is overdue, so it repeats rather than jumping.
    const history: WorkoutRecord[] = [
      sessionA('2026-07-10', at(135, 10, 10, 10)),
      {id: 'b', date: '2026-07-17T23:00:00', session: 'B', exercises: [{exercise: 'Squat', prescribedSets: 3, sets: at(185, 10, 10, 10)}]},
    ]
    const result = run({history, now: '2026-07-23T23:00:00'})
    expect(result.reentry).toBeUndefined()
    const bench = forExercise(result, 'Bench press')
    expect(bench.weight).toBe(135)
    expect(bench.sets).toBe(3)
    expect(bench.rationale).toContain('repeat, no jump')
  })

  it('overrides sets and reps on the post-injury row', () => {
    const history = [sessionA('2026-01-05', at(135, 10, 10, 10))]
    const result = run({history, now: '2026-07-23T23:00:00'})
    expect(result.reentry?.tier.id).toBe('2mo+')
    const bench = forExercise(result, 'Bench press')
    expect(bench.sets).toBe(2)
    expect(bench.repMin).toBe(8)
    expect(bench.repMax).toBe(12)
    expect(bench.weight).toBe(80) // 60% of 135 = 81 → 80
  })

  it('measures percentages against pre-break weights, never against the ramp', () => {
    const layoff: LayoffRecord = {
      id: 'l', from: '2026-04-01', to: '2026-06-01', days: 61, tierId: '1-2mo', pct: 0.8,
    }
    const history = [
      sessionA('2026-04-01', at(200, 10, 10, 10)),
      sessionA('2026-06-01', at(160, 10, 10)),
    ]
    // Second session back: 85% of the *pre-break* 200, not of the 160 logged
    // on the ramp.
    const bench = forExercise(run({history, layoffs: [layoff], now: '2026-06-04T23:00:00'}), 'Bench press')
    expect(bench.weight).toBe(170)
    expect(bench.sets).toBe(2)
  })

  it('does not count a mini day as training', () => {
    const history: WorkoutRecord[] = [
      sessionA('2026-07-03', at(135, 10, 10, 10)),
      {id: 'm', date: '2026-07-21T22:00:00', session: 'mini', exercises: []},
    ]
    expect(run({history, now: '2026-07-23T23:00:00'}).reentry?.tier.id).toBe('2-4w')
  })
})

describe('prescribe — notes', () => {
  it('carries the plan reminders into the session', () => {
    const notes = run({history: [], now: '2026-07-23T23:00:00'}).notes
    expect(notes.some(n => /shoulder prep/i.test(n))).toBe(true)
    expect(notes.some(n => /RPE 8/i.test(n))).toBe(true)
  })

  it('appends the tier guidance when a layoff is live', () => {
    const history = [sessionA('2026-07-03', at(135, 10, 10, 10))]
    const notes = run({history, now: '2026-07-23T23:00:00'}).notes
    expect(notes.some(n => /90% of last weights/i.test(n))).toBe(true)
  })
})
