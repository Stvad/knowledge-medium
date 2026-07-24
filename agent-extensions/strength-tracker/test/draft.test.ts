import {describe, expect, it} from 'vitest'

import {buildDraft, finishPlan, hasAcceptedSets, overlayLive, toMaterializeDraft} from '../src/ui/draft'
import type {LiveWorkout} from '../src/km/history'
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

describe('toMaterializeDraft', () => {
  it('materializes every prescribed set (done or not) — the block is the live state', () => {
    const draft = buildDraft(prescription(), 'lb')
    draft[0].sets[0].done = true
    const workout = toMaterializeDraft('2026-07-23', 'A', draft)
    expect(workout.exercises).toHaveLength(1)
    expect(workout.exercises[0].sets).toHaveLength(3)
    expect(workout.exercises[0].sets[0].done).toBe(true)
    expect(workout.exercises[0].prescribedSets).toBe(3)
  })

  it('carries rpe and side through', () => {
    const draft = buildDraft(prescription({exercise: 'Waiter carry', sets: 1, perSide: true, freeform: true, repMax: undefined, weight: 40}), 'lb')
    draft[0].sets[0].rpe = 8
    // reps pre-fill falls back to repMin (6) when there's no rep ceiling.
    expect(toMaterializeDraft('2026-07-23', 'A', draft).exercises[0].sets[0])
      .toEqual({weight: 40, reps: 6, done: false, rpe: 8, side: 'L'})
  })
})

describe('overlayLive', () => {
  const live: LiveWorkout = {
    id: 'w1', day: '2026-07-23', session: 'A',
    exercises: [{
      id: 'e1', exercise: 'Bench press', unit: 'lb', prescribedSets: 3,
      sets: [
        {id: 's1', weight: 140, reps: 9, done: true},
        {id: 's2', weight: 140, reps: 8, done: false},
      ],
    }],
  }

  it('overlays the live block set values + ids by exercise name, keeping prescription metadata', () => {
    const merged = overlayLive(buildDraft(prescription(), 'lb'), live)
    expect(merged[0].blockId).toBe('e1')
    expect(merged[0].sets.map(s => s.blockId)).toEqual(['s1', 's2'])
    expect(merged[0].sets[0]).toMatchObject({weight: 140, reps: 9, done: true})
    expect(merged[0].rationale).toBe('hold 135') // metadata still from the prescription
  })

  it('keeps pre-filled sets for an exercise the live workout lacks', () => {
    const merged = overlayLive(buildDraft(prescription(), 'lb'), undefined)
    expect(merged[0].blockId).toBeUndefined()
    expect(merged[0].sets).toHaveLength(3)
  })
})

describe('finishPlan', () => {
  const materialized = () => {
    const draft = buildDraft(prescription(), 'lb')
    draft[0].blockId = 'e1'
    draft[0].sets.forEach((s, i) => (s.blockId = `s${i}`))
    return draft
  }

  it('keeps done sets with the working weight and prunes the un-accepted ones', () => {
    const draft = materialized()
    draft[0].sets[0].done = true
    draft[0].sets[1].done = true
    const plan = finishPlan('w1', draft)
    expect(plan.workoutId).toBe('w1')
    expect(plan.keep).toHaveLength(1)
    expect(plan.keep[0]).toMatchObject({exerciseId: 'e1', workingWeight: 135, removeSetIds: ['s2']})
    expect(plan.removeExerciseIds).toEqual([])
  })

  it('removes an exercise with no done set', () => {
    const plan = finishPlan('w1', materialized())
    expect(plan.removeExerciseIds).toEqual(['e1'])
    expect(plan.keep).toEqual([])
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
