/** `finishPlan` decides what a finished workout keeps and what it prunes.
 *
 *  Its input is the COMMITTED tree, read inside the finishing transaction —
 *  never the draft, never a query snapshot. Every one of these cases used to
 *  be a separate special case against stale inputs; reading the blocks makes
 *  them all the same rule.
 */

import {describe, expect, it} from 'vitest'

import {finishPlan} from '../src/km/finish'
import type {LiveWorkout} from '../src/km/history'

const set = (id: string, done: boolean, weight = 135, reps = 10) => ({id, weight, reps, done})

const workout = (exercises: LiveWorkout['exercises']): LiveWorkout =>
  ({id: 'w1', day: '2026-07-25', session: 'A', exercises})

const entry = (id: string, exercise: string, sets: LiveWorkout['exercises'][number]['sets']) =>
  ({id, exercise, unit: 'lb', sets})

describe('finishPlan', () => {
  it('keeps the done sets with a working weight and prunes the rest', () => {
    const plan = finishPlan('w1', workout([
      entry('e1', 'Bench press', [set('s0', true), set('s1', true), set('s2', false)]),
    ]))
    expect(plan.keep).toEqual([
      {exerciseId: 'e1', workingWeight: 135, removeSetIds: ['s2']},
    ])
    expect(plan.removeExerciseIds).toEqual([])
  })

  it('removes an exercise nothing was logged into, and takes its sets with it', () => {
    // The whole entry goes, so its pre-filled sets must NOT also be listed for
    // deletion — they are already inside the subtree being removed.
    const plan = finishPlan('w1', workout([
      entry('e1', 'Curl', [set('s0', false), set('s1', false)]),
    ]))
    expect(plan.removeExerciseIds).toEqual(['e1'])
    expect(plan.keep).toEqual([])
  })

  it('keeps an exercise the draft never knew about — a switched-away or-group option', () => {
    // Nothing here is draft-derived, so an entry this client never rendered is
    // not a special case: it is just another entry with a done set.
    const plan = finishPlan('w1', workout([
      entry('e1', 'Landmine press', [set('lm0', true)]),
      entry('e2', 'Overhead press', [set('ohp0', true), set('ohp1', false)]),
    ]))
    expect(plan.keep.map(k => k.exerciseId)).toEqual(['e1', 'e2'])
    expect(plan.keep[1].removeSetIds).toEqual(['ohp1'])
  })

  it('keeps a set ticked from outside this view, because the block is the only input', () => {
    // The draft can be minutes behind — done-ness is the built-in todo
    // checkbox, tickable from the outline or another device. This is the case
    // that used to delete a set the user had actually performed.
    const plan = finishPlan('w1', workout([
      entry('e1', 'Bench press', [set('s0', false), set('s1', true)]),
    ]))
    expect(plan.keep[0].removeSetIds).toEqual(['s0'])
    expect(plan.removeExerciseIds).toEqual([])
  })

  it('spares an exercise whose only acceptance arrived after the draft was built', () => {
    // Previously this entry was planned for wholesale deletion and the in-tx
    // re-check skipped it — leaving its OTHER sets live as open todos under a
    // finished workout, unreachable forever.
    const plan = finishPlan('w1', workout([
      entry('e1', 'Curl', [set('s0', true), set('s1', false), set('s2', false)]),
    ]))
    expect(plan.removeExerciseIds).toEqual([])
    expect(plan.keep[0].removeSetIds).toEqual(['s1', 's2'])
  })

  it('derives the working weight from only what was accepted', () => {
    const plan = finishPlan('w1', workout([
      entry('e1', 'Bench press', [set('s0', true, 155, 5), set('s1', false, 999, 1)]),
    ]))
    expect(plan.keep[0].workingWeight).toBe(155)
  })

  it('handles an empty workout without inventing work', () => {
    expect(finishPlan('w1', workout([]))).toEqual({
      workoutId: 'w1', keep: [], removeExerciseIds: [],
    })
  })
})
