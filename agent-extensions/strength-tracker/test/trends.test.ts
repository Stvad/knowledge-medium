import {describe, expect, it} from 'vitest'

import {asymmetries, bestWorkingWeight, exerciseSeries, milestoneProgress} from '../src/engine/trends'
import {DEFAULT_CONFIG} from '../src/program/defaults'
import type {SetRecord, WorkoutRecord} from '../src/engine/types'

const A = (day: string, ...sets: SetRecord[]): WorkoutRecord => ({
  id: day, date: `${day}T23:00:00`, session: 'A',
  exercises: [{exercise: 'Bench press', sets}],
})

const at = (weight: number, ...reps: number[]): SetRecord[] => reps.map(r => ({weight, reps: r}))

describe('exerciseSeries', () => {
  it('is one point per session, oldest first', () => {
    const history = [A('2026-07-16', ...at(135, 10, 10, 10)), A('2026-07-09', ...at(130, 10, 10, 10))]
    expect(exerciseSeries(history, {exercise: 'Bench press'}, 4)).toEqual([
      {day: '2026-07-09', weight: 130},
      {day: '2026-07-16', weight: 135},
    ])
  })
})

describe('exerciseSeries — one lift prescribed twice', () => {
  const workout = (day: string, ...entries: {exercise: string; defId?: string; occurrence?: number; weight: number}[]) => ({
    id: `w-${day}`,
    date: `${day}T12:00:00.000Z`,
    session: 'A' as const,
    exercises: entries.map(e => ({
      exercise: e.exercise,
      ...(e.defId !== undefined ? {definitionId: e.defId} : {}),
      ...(e.occurrence !== undefined ? {occurrence: e.occurrence} : {}),
      sets: [{weight: e.weight, reps: 5}, {weight: e.weight, reps: 5}],
    })),
  })

  it('draws a separate line for each occurrence, not the first one twice', () => {
    // A plan can prescribe one lift twice at different loads — which is what
    // `occurrence` exists for everywhere else. Keyed by NAME alone, both cards
    // found the first same-named entry and drew the identical series, so the
    // second row's history was nowhere on screen.
    const history = [
      workout('2026-07-20', {exercise: 'Squat', occurrence: 0, weight: 225},
        {exercise: 'Squat', occurrence: 1, weight: 135}),
    ]

    expect(exerciseSeries(history, {exercise: 'Squat', occurrence: 0}, 0))
      .toEqual([{day: '2026-07-20', weight: 225}])
    expect(exerciseSeries(history, {exercise: 'Squat', occurrence: 1}, 0))
      .toEqual([{day: '2026-07-20', weight: 135}])
  })
})

describe('milestoneProgress', () => {
  it('tracks best working weight toward each target', () => {
    const history: WorkoutRecord[] = [{
      id: 'b', date: '2026-07-19T23:00:00', session: 'B',
      exercises: [{exercise: 'Overhead press', sets: at(100, 4, 4, 4)}],
    }]
    const ohp = milestoneProgress(history, DEFAULT_CONFIG).find(m => m.milestone.id === 'ohp-strict')!
    expect(ohp.best).toBe(100)
    expect(ohp.fraction).toBeCloseTo(100 / 115)
    expect(ohp.hit).toBe(false)
  })

  it('marks a milestone hit once the target is reached', () => {
    const history: WorkoutRecord[] = [{
      id: 'b', date: '2026-07-19T23:00:00', session: 'B',
      exercises: [{exercise: 'Overhead press', sets: at(120, 3, 3, 3)}],
    }]
    const ohp = milestoneProgress(history, DEFAULT_CONFIG).find(m => m.milestone.id === 'ohp-strict')!
    expect(ohp.hit).toBe(true)
    expect(ohp.fraction).toBe(1)
  })
})

describe('bestWorkingWeight', () => {
  it('takes the heaviest working weight across sessions', () => {
    const history = [A('2026-07-09', ...at(140, 10, 10, 10)), A('2026-07-16', ...at(135, 10, 10, 10))]
    expect(bestWorkingWeight(history, 'Bench press')).toBe(140)
  })
})

describe('asymmetries', () => {
  it('reports the latest L/R for single-arm lifts and flags right-ahead', () => {
    const history: WorkoutRecord[] = [{
      id: 'b', date: '2026-07-19T23:00:00', session: 'B',
      exercises: [{exercise: 'Waiter carry', sets: [
        {weight: 35, reps: 4, side: 'L'},
        {weight: 45, reps: 4, side: 'R'},
      ]}],
    }]
    const waiter = asymmetries(history, DEFAULT_CONFIG).find(a => a.exercise === 'Waiter carry')!
    expect(waiter).toMatchObject({left: 35, right: 45, rightAhead: true})
  })

  it('omits lifts with no sided history', () => {
    expect(asymmetries([], DEFAULT_CONFIG)).toEqual([])
  })
})
