import {describe, expect, it} from 'vitest'

import {reconcilePlan} from '../src/km/reconcile'
import type {LiveWorkout} from '../src/km/history'
import type {WorkoutDraft} from '../src/km/store'

const set = (weight = 135, reps = 10) => ({weight, reps, done: false})

const draft = (
  exercises: Array<{exercise: string; definitionId?: string; sets?: number}>,
): WorkoutDraft => ({
  day: '2026-07-23',
  session: 'A',
  exercises: exercises.map(ex => ({
    exercise: ex.exercise,
    ...(ex.definitionId !== undefined ? {definitionId: ex.definitionId} : {}),
    unit: 'lb',
    sets: Array.from({length: ex.sets ?? 3}, () => set()),
  })),
})

const existing = (
  exercises: Array<{id: string; exercise: string; definitionId?: string; setIds: string[]}>,
): LiveWorkout => ({
  id: 'w1',
  day: '2026-07-23',
  session: 'A',
  exercises: exercises.map(ex => ({
    id: ex.id,
    exercise: ex.exercise,
    ...(ex.definitionId !== undefined ? {definitionId: ex.definitionId} : {}),
    unit: 'lb',
    sets: ex.setIds.map(id => ({id, weight: 135, reps: 10, done: false})),
  })),
})

describe('reconcilePlan', () => {
  it('reuses a matched entry and its set blocks rather than creating a parallel one', () => {
    const plan = reconcilePlan(
      existing([{id: 'e1', exercise: 'Bench press', setIds: ['s0', 's1', 's2']}]),
      draft([{exercise: 'Bench press'}]),
    )
    expect(plan).toEqual([{existingId: 'e1', setIds: ['s0', 's1', 's2']}])
  })

  it('matches by plan block, so a lift renamed since it was logged still adopts', () => {
    const plan = reconcilePlan(
      existing([{id: 'e1', exercise: 'Bench press', definitionId: 'def-bench', setIds: ['s0']}]),
      draft([{exercise: 'Bench press (comp grip)', definitionId: 'def-bench', sets: 1}]),
    )
    expect(plan[0].existingId).toBe('e1')
  })

  it('leaves a gap for a prescribed set the entry does not have yet', () => {
    // The other device logged two sets; tonight's plan prescribes three. The
    // third has no block, so the adopt has to write one — leaving it
    // undefined would hand the coordinator a set with nowhere to write, and
    // that tick would vanish silently.
    const plan = reconcilePlan(
      existing([{id: 'e1', exercise: 'Bench press', setIds: ['s0', 's1']}]),
      draft([{exercise: 'Bench press', sets: 3}]),
    )
    expect(plan[0].setIds).toEqual(['s0', 's1', undefined])
  })

  it('creates the whole entry for a row the existing workout has no match for', () => {
    const plan = reconcilePlan(
      existing([{id: 'e1', exercise: 'Bench press', setIds: ['s0']}]),
      draft([{exercise: 'Bench press', sets: 1}, {exercise: 'Bent-over row', sets: 2}]),
    )
    expect(plan[1]).toEqual({setIds: [undefined, undefined]})
  })

  it('never hands the same entry to two rows', () => {
    // Two rows of the same lift (a hand-written plan, or a default-config
    // session). Both adopting `e1` would point two rows at one set of
    // blocks, and each would write over the other.
    const plan = reconcilePlan(
      existing([{id: 'e1', exercise: 'Bench press', setIds: ['s0']}]),
      draft([{exercise: 'Bench press', sets: 1}, {exercise: 'Bench press', sets: 1}]),
    )
    expect(plan[0].existingId).toBe('e1')
    expect(plan[1].existingId).toBeUndefined()
  })

  it('says nothing about entries the draft has no row for — they are logged work', () => {
    // The or-group option the other device chose. Adopting must not touch it;
    // finishPlan decides its fate under the same keep-if-done rule.
    const plan = reconcilePlan(
      existing([
        {id: 'e1', exercise: 'Bench press', setIds: ['s0']},
        {id: 'e-ohp', exercise: 'Overhead press', setIds: ['o0']},
      ]),
      draft([{exercise: 'Bench press', sets: 1}]),
    )
    expect(plan).toHaveLength(1)
    expect(plan[0].existingId).toBe('e1')
  })
})
