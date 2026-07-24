import {describe, expect, it} from 'vitest'

import {buildDraft, hasAcceptedSets, toWorkoutDraft} from '../src/ui/draft'
import type {Prescription} from '../src/engine/types'

const prescription = (over: Partial<Prescription['exercises'][number]> = {}): Prescription => ({
  day: '2026-07-23',
  session: 'A',
  offSchedule: false,
  notes: [],
  exercises: [{
    exercise: 'Bench press', sets: 3, repMin: 6, repMax: 10, weight: 135,
    perSide: false, freeform: false, rationale: 'hold 135', ...over,
  }],
})

describe('buildDraft', () => {
  it('pre-fills every set at the prescribed weight and top of the range', () => {
    const draft = buildDraft(prescription(), 'lb')
    expect(draft[0].sets).toHaveLength(3)
    expect(draft[0].sets.every(s => s.weight === 135 && s.reps === 10 && !s.done)).toBe(true)
  })

  it('doubles the sets for per-side work, alternating L then R', () => {
    const draft = buildDraft(prescription({exercise: 'Waiter carry', sets: 2, perSide: true, freeform: true, repMax: undefined, weight: 40}), 'lb')
    expect(draft[0].sets.map(s => s.side)).toEqual(['L', 'R', 'L', 'R'])
  })

  it('leaves weight at 0 when there is no prescription yet', () => {
    const draft = buildDraft(prescription({weight: undefined}), 'lb')
    expect(draft[0].sets.every(s => s.weight === 0)).toBe(true)
  })
})

describe('toWorkoutDraft', () => {
  it('writes only accepted sets, dropping untouched exercises', () => {
    const draft = buildDraft(prescription(), 'lb')
    draft[0].sets[0].done = true
    draft[0].sets[1].done = true
    const workout = toWorkoutDraft('2026-07-23', 'A', draft)
    expect(workout.exercises).toHaveLength(1)
    expect(workout.exercises[0].sets).toHaveLength(2)
    expect(workout.exercises[0].prescribedSets).toBe(3)
  })

  it('drops an exercise with no accepted sets', () => {
    const draft = buildDraft(prescription(), 'lb')
    expect(toWorkoutDraft('2026-07-23', 'A', draft).exercises).toHaveLength(0)
  })

  it('carries rpe and side onto stored sets', () => {
    const draft = buildDraft(prescription({exercise: 'Waiter carry', sets: 1, perSide: true, freeform: true, repMax: undefined, weight: 40}), 'lb')
    draft[0].sets[0].done = true
    draft[0].sets[0].rpe = 8
    const stored = toWorkoutDraft('2026-07-23', 'A', draft).exercises[0].sets[0]
    // reps pre-fill falls back to repMin (6) when there's no rep ceiling.
    expect(stored).toEqual({weight: 40, reps: 6, rpe: 8, side: 'L'})
  })
})

describe('hasAcceptedSets', () => {
  it('is false until a set is accepted', () => {
    const draft = buildDraft(prescription(), 'lb')
    expect(hasAcceptedSets(draft)).toBe(false)
    draft[0].sets[0].done = true
    expect(hasAcceptedSets(draft)).toBe(true)
  })
})
