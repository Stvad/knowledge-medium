import {describe, expect, it} from 'vitest'

import {asymmetries, bestWorkingWeight, exerciseSeries, milestoneProgress} from '../src/engine/trends'
import {DEFAULT_CONFIG} from '../src/program/defaults'
import type {ProgramConfig} from '../src/engine/types'
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

describe('asymmetries — two definitions sharing a display name', () => {
  it('keeps them apart by definition, not by occurrence alone', () => {
    // Each is counted under its OWN id, so both are occurrence 0 — a
    // name+occurrence key collides, and React reuses or discards the wrong
    // row, putting one definition's left/right numbers under the other's
    // heading. The definition has to travel with the result.
    const config = {
      unit: 'lb', dayRolloverHour: 0, roundTo: 5, milestones: [], reentryTiers: [],
      exercises: [
        {name: 'Split squat', defId: 'def-front', session: 'A' as const, sets: 2, increment: 5, perSide: true, freeform: false},
        {name: 'Split squat', defId: 'def-rear', session: 'A' as const, sets: 2, increment: 5, perSide: true, freeform: false},
      ],
    } as unknown as ProgramConfig
    const history = [{
      id: 'w1', date: '2026-07-20T12:00:00.000Z', session: 'A' as const,
      exercises: [
        {exercise: 'Split squat', definitionId: 'def-front', occurrence: 0, sets: [
          {weight: 60, reps: 8, side: 'L' as const}, {weight: 60, reps: 8, side: 'R' as const}]},
        {exercise: 'Split squat', definitionId: 'def-rear', occurrence: 0, sets: [
          {weight: 30, reps: 8, side: 'L' as const}, {weight: 40, reps: 8, side: 'R' as const}]},
      ],
    }]

    const out = asymmetries(history, config)

    expect(out.map(a => [a.defId, a.occurrence, a.left, a.right]))
      .toEqual([['def-front', 0, 60, 60], ['def-rear', 0, 30, 40]])
    // What the row key is built from — distinct is the whole point.
    const keys = out.map(a => `${a.defId ?? a.exercise}#${a.occurrence}`)
    expect(new Set(keys).size).toBe(2)
  })
})

describe('asymmetries — one per-side lift prescribed twice', () => {
  const config = {
    unit: 'lb', dayRolloverHour: 0, roundTo: 5, milestones: [], reentryTiers: [],
    exercises: [
      {name: 'Split squat', session: 'A' as const, sets: 2, increment: 5, perSide: true, freeform: false},
      {name: 'Split squat', session: 'A' as const, sets: 2, increment: 5, perSide: true, freeform: false},
    ],
  } as unknown as ProgramConfig

  it('reports both rows instead of the first one twice', () => {
    // The sibling of the `exerciseSeries` fault: deduplicating by NAME showed
    // occurrence 0 and hid occurrence 1 entirely, so half a lift's left/right
    // comparison was simply absent from the view.
    const history = [{
      id: 'w1', date: '2026-07-20T12:00:00.000Z', session: 'A' as const,
      exercises: [
        {exercise: 'Split squat', occurrence: 0, sets: [
          {weight: 60, reps: 8, side: 'L' as const}, {weight: 70, reps: 8, side: 'R' as const}]},
        {exercise: 'Split squat', occurrence: 1, sets: [
          {weight: 30, reps: 8, side: 'L' as const}, {weight: 30, reps: 8, side: 'R' as const}]},
      ],
    }]

    const out = asymmetries(history, config)

    expect(out.map(a => [a.occurrence, a.left, a.right]))
      .toEqual([[0, 60, 70], [1, 30, 30]])
    expect(out[0].rightAhead).toBe(true)
    expect(out[1].rightAhead).toBe(false)
  })

  const waiterAt = (sets: {weight: number; reps: number; side: 'L' | 'R'}[]): WorkoutRecord[] => [{
    id: 'b', date: '2026-07-19T23:00:00', session: 'B',
    exercises: [{exercise: 'Waiter carry', sets}],
  }]

  it('flags the right side ahead on REPS when both sides use the same weight', () => {
    // The commonest disparity there is: single-arm work is loaded with the one
    // dumbbell you have, so both sides sit at the same number and the right
    // pulls ahead in reps. Comparing modal weight alone reported no asymmetry
    // for exactly that session — the plan's rule is left leads and right
    // matches ("start left, right matches"), so 45×8 against 45×10 is the case
    // the flag exists for.
    const waiter = asymmetries(waiterAt([
      {weight: 45, reps: 8, side: 'L'},
      {weight: 45, reps: 10, side: 'R'},
    ]), DEFAULT_CONFIG).find(a => a.exercise === 'Waiter carry')!

    expect(waiter).toMatchObject({left: 45, right: 45, leftReps: 8, rightReps: 10})
    expect(waiter.rightAhead).toBe(true)
  })

  it('does not flag matched sides, so the rule did not just get louder', () => {
    const waiter = asymmetries(waiterAt([
      {weight: 45, reps: 10, side: 'L'},
      {weight: 45, reps: 10, side: 'R'},
    ]), DEFAULT_CONFIG).find(a => a.exercise === 'Waiter carry')!

    expect(waiter.rightAhead).toBe(false)
  })
})
