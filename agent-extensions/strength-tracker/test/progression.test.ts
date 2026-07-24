import {describe, expect, it} from 'vitest'

import {
  lastEntryFor,
  nextWeight,
  progressionSets,
  roundLoad,
  toppedOut,
  workingWeight,
} from '../src/engine/progression'
import type {ExerciseRecord, SetRecord, WorkoutRecord} from '../src/engine/types'

const bench = (sets: SetRecord[], prescribedSets?: number): ExerciseRecord => ({
  exercise: 'Bench press',
  prescribedSets,
  sets,
})

const CONFIG = {sets: 3, repMax: 10, freeform: false, increment: 5}

const at = (weight: number, ...reps: number[]): SetRecord[] =>
  reps.map(r => ({weight, reps: r}))

describe('workingWeight', () => {
  it('takes the modal weight', () => {
    expect(workingWeight(bench([...at(135, 10, 10), ...at(115, 12)]))).toBe(135)
  })

  it('breaks ties heavy', () => {
    expect(workingWeight(bench([...at(135, 8), ...at(140, 6)]))).toBe(140)
  })

  it('is undefined with no sets', () => {
    expect(workingWeight(bench([]))).toBeUndefined()
  })
})

describe('progressionSets', () => {
  it('passes through when nothing is sided', () => {
    const sets = at(135, 10, 10)
    expect(progressionSets(sets)).toEqual(sets)
  })

  it('judges single-arm work off the left side — left sets the reps', () => {
    const sets: SetRecord[] = [
      {weight: 35, reps: 8, side: 'L'},
      {weight: 35, reps: 10, side: 'R'},
    ]
    expect(progressionSets(sets)).toEqual([{weight: 35, reps: 8, side: 'L'}])
  })
})

describe('toppedOut', () => {
  it('is true when every prescribed set hit the top of the range', () => {
    expect(toppedOut(bench(at(135, 10, 10, 10)), CONFIG)).toBe(true)
  })

  it('is false when one set fell short', () => {
    expect(toppedOut(bench(at(135, 10, 10, 9)), CONFIG)).toBe(false)
  })

  it('is false when fewer than the prescribed sets were done', () => {
    expect(toppedOut(bench(at(135, 10, 10)), CONFIG)).toBe(false)
  })

  it('judges against the sets prescribed at the time, not today config', () => {
    // Two sets were prescribed (first session back from a layoff) and both
    // topped out — that counts, even though config now says three.
    expect(toppedOut(bench(at(135, 10, 10), 2), CONFIG)).toBe(true)
  })

  it('never fires for freeform work', () => {
    expect(toppedOut(bench(at(35, 2, 2)), {...CONFIG, freeform: true})).toBe(false)
  })
})

describe('nextWeight', () => {
  it('adds the increment once the range is cleared', () => {
    expect(nextWeight(bench(at(135, 10, 10, 10)), CONFIG)).toEqual({weight: 140, progressed: true})
  })

  it('repeats the weight otherwise', () => {
    expect(nextWeight(bench(at(135, 8, 9, 10)), CONFIG)).toEqual({weight: 135, progressed: false})
  })

  it('holds when the caller says to', () => {
    expect(nextWeight(bench(at(135, 10, 10, 10)), CONFIG, {hold: true}))
      .toEqual({weight: 135, progressed: false})
  })
})

describe('lastEntryFor', () => {
  it('picks the newest workout containing the exercise', () => {
    const history: WorkoutRecord[] = [
      {id: '1', date: '2026-07-09T23:00:00', session: 'A', exercises: [bench(at(130, 10, 10, 10))]},
      {id: '2', date: '2026-07-16T23:00:00', session: 'A', exercises: [bench(at(135, 8, 8, 8))]},
    ]
    expect(lastEntryFor(history, 'Bench press')?.workout.id).toBe('2')
    expect(lastEntryFor(history, 'Squat')).toBeUndefined()
  })

  it('skips entries with no logged sets', () => {
    const history: WorkoutRecord[] = [
      {id: '1', date: '2026-07-09T23:00:00', session: 'A', exercises: [bench(at(130, 10))]},
      {id: '2', date: '2026-07-16T23:00:00', session: 'A', exercises: [bench([])]},
    ]
    expect(lastEntryFor(history, 'Bench press')?.workout.id).toBe('1')
  })
})

describe('roundLoad', () => {
  it('rounds down onto loadable plates', () => {
    expect(roundLoad(121.5, 5)).toBe(120)
    expect(roundLoad(135, 5)).toBe(135)
  })
})
