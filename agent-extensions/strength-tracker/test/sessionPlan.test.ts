import {describe, expect, it} from 'vitest'

import type {PrescribedExercise, Prescription} from '../src/engine/types'
import {planFromPrescription} from '../src/km/sessionPlan'

const exercise = (over: Partial<PrescribedExercise> = {}): PrescribedExercise => ({
  exercise: 'Bench press',
  sets: 3,
  repMin: 6,
  repMax: 10,
  weight: 135,
  perSide: false,
  freeform: false,
  rationale: 'test',
  ...over,
})

const prescription = (exercises: PrescribedExercise[]): Prescription => ({
  day: '2026-07-24',
  session: 'A',
  offSchedule: false,
  exercises,
  notes: [],
})

describe('planFromPrescription', () => {
  it('expands to one row per prescribed set, aiming at the top of the rep range', () => {
    // Double progression: you add load once every set clears the TOP of the
    // range, so the top is what the prescription asks for. Stamping repMin
    // would make every session read as already cleared.
    const {lifts} = planFromPrescription(prescription([exercise()]), 'lb')

    expect(lifts[0].sets).toEqual([
      {weight: 135, reps: 10}, {weight: 135, reps: 10}, {weight: 135, reps: 10},
    ])
    expect(lifts[0].prescribedSets).toBe(3)
  })

  it('gives single-arm work two rows per set, left leading', () => {
    const {lifts} = planFromPrescription(
      prescription([exercise({exercise: 'Single-arm row', sets: 2, perSide: true, weight: 60})]),
      'lb',
    )

    expect(lifts[0].sets.map(s => s.side)).toEqual(['L', 'R', 'L', 'R'])
  })

  it('stamps zero rather than nothing when there is no history to load from', () => {
    // The block is created either way — a set you have to type a number into
    // is the same gesture as correcting a suggestion you disagree with, and
    // it keeps "prescribed" meaning "there is a block".
    const {lifts} = planFromPrescription(prescription([exercise({weight: undefined})]), 'lb')

    expect(lifts[0].sets.every(s => s.weight === 0)).toBe(true)
    expect(lifts[0].prescribedWeight).toBeUndefined()
  })

  it('numbers a repeated lift by plan block, so two rows of it stay separate records', () => {
    // Occurrence is counted ONCE, here, and the entry's block id derives from
    // it. Counted from a second list somewhere else is how a row used to end
    // up writing into its neighbour's blocks.
    const {lifts} = planFromPrescription(prescription([
      exercise({exercise: 'Bench press', defId: 'def-bench'}),
      exercise({exercise: 'Row', defId: 'def-row'}),
      exercise({exercise: 'Bench press', defId: 'def-bench'}),
    ]), 'lb')

    expect(lifts.map(l => [l.exercise, l.occurrence])).toEqual([
      ['Bench press', 0], ['Row', 0], ['Bench press', 1],
    ])
  })

  it('falls back to the name when the plan block is unknown, and keeps two same-named lifts apart', () => {
    const {lifts} = planFromPrescription(prescription([
      exercise({exercise: 'Carry'}),
      exercise({exercise: 'Carry'}),
    ]), 'lb')

    expect(lifts.map(l => l.occurrence)).toEqual([0, 1])
  })

  it('keys occurrence on the plan block, not the name, so a renamed option is still its own line', () => {
    // Same name, different plan blocks: two separate lifts that happen to be
    // spelled alike must NOT collapse into occurrences of one.
    const {lifts} = planFromPrescription(prescription([
      exercise({exercise: 'Press', defId: 'def-ohp'}),
      exercise({exercise: 'Press', defId: 'def-landmine'}),
    ]), 'lb')

    expect(lifts.map(l => l.occurrence)).toEqual([0, 0])
  })
})
