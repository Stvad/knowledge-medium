import {describe, expect, it} from 'vitest'

import type {PrescribedExercise, Prescription} from '../src/engine/types'
import {choicesToRecord, matchEntries, planFromPrescription, type PlannedLift} from '../src/km/sessionPlan'

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

  it('copies the RPE ceiling onto every set of a lift that has one', () => {
    // The set row decides whether to ask for an RPE from the SET alone, so a
    // ceiling reaching only the first row would leave the rest of the lift
    // silently unloggable — and the catch-up jump needs every set to carry
    // one, so a half-collected lift progresses at the normal increment.
    const {lifts} = planFromPrescription(
      prescription([exercise({exercise: 'Deadlift', sets: 2, catchUpRpe: 7})]),
      'lb',
    )

    expect(lifts[0].sets).toHaveLength(2)
    expect(lifts[0].sets.map(s => s.catchUpRpe)).toEqual([7, 7])
  })

  it('copies it onto both sides of single-arm work', () => {
    const {lifts} = planFromPrescription(
      prescription([exercise({exercise: 'Waiter carry', sets: 2, perSide: true, catchUpRpe: 8})]),
      'lb',
    )

    expect(lifts[0].sets).toHaveLength(4)
    expect(lifts[0].sets.map(s => s.catchUpRpe)).toEqual([8, 8, 8, 8])
  })

  it('leaves it off a lift without one, which is what suppresses the control', () => {
    const {lifts} = planFromPrescription(prescription([exercise()]), 'lb')

    expect(lifts[0].sets).toHaveLength(3)
    expect(lifts[0].sets.map(s => s.catchUpRpe)).toEqual([undefined, undefined, undefined])
  })

  it('carries the rep target as prescribed, not as later performed', () => {
    // Stamped on the entry so the lift line stops reading it back off a set
    // block, which is a number you edit: logging 8 on set one turned a
    // prescribed 3x10 into "target 3x8".
    const {lifts} = planFromPrescription(prescription([exercise({repMax: 10})]), 'lb')
    expect(lifts[0].prescribedReps).toBe(10)
  })

  it('takes the target from the expanded rows, so a carry gets its fallback too', () => {
    // A carry has no rep range at all; `setsFor` resolves that from what you
    // last did. Recomputing the target from the range instead would report
    // '?' for exactly the lifts the fallback exists for.
    const {lifts} = planFromPrescription(prescription([exercise({
      exercise: 'Waiter carry', repMin: undefined, repMax: undefined,
      lastTime: {date: '2026-07-19', weight: 35, reps: [4, 4]},
    })]), 'lb')
    expect(lifts[0].prescribedReps).toBe(4)
  })

  it('stamps zero rather than nothing when there is no history to load from', () => {
    // The block is created either way — a set you have to type a number into
    // is the same gesture as correcting a suggestion you disagree with, and
    // it keeps "prescribed" meaning "there is a block".
    const {lifts} = planFromPrescription(prescription([exercise({weight: undefined})]), 'lb')

    expect(lifts[0].sets).toHaveLength(3)
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

describe('matchEntries — which existing entry each row continues', () => {
  const entry = (id: string, over: {exercise?: string; def?: string; occurrence?: number} = {}) => ({
    id,
    properties: {
      'strength:exercise': over.exercise ?? 'Press',
      ...(over.def !== undefined ? {'strength:definition': over.def} : {}),
      ...(over.occurrence !== undefined ? {'strength:occurrence': over.occurrence} : {}),
    } as Record<string, unknown>,
  })
  const row = (over: Partial<PlannedLift> = {}): PlannedLift => ({
    exercise: 'Press', occurrence: 0, unit: 'lb', prescribedSets: 1, sets: [], ...over,
  })

  it('never hands one entry to two rows', () => {
    // The bare row cannot match exactly (the entry names a plan block), so it
    // reaches the fallback — where, unclaimed, it would take the entry the
    // exact pass already gave away, and both rows would write into one tree.
    const a = entry('a', {def: 'def-ohp'})
    const {matched} = matchEntries([row({definitionId: 'def-ohp'}), row()], [a])

    expect(matched[0]).toBe(a)
    expect(matched[1]).toBeUndefined()
  })

  it('will not continue an entry logged as a different occurrence of the lift', () => {
    // Session A prescribes the lift twice. Ignore the occurrence and the first
    // row claims the SECOND slot's entry, filing its sets under the other one.
    const second = entry('second', {occurrence: 1})
    const {matched} = matchEntries([row({occurrence: 0}), row({occurrence: 1})], [second])

    expect(matched[0]).toBeUndefined()
    expect(matched[1]).toBe(second)
  })

  it('reads a missing occurrence as the first slot, which is what legacy entries are', () => {
    const legacy = entry('legacy')
    expect(matchEntries([row({occurrence: 0})], [legacy]).matched[0]).toBe(legacy)
    expect(matchEntries([row({occurrence: 1})], [legacy]).matched[0]).toBeUndefined()
  })

  it('refuses an entry that names a different plan block outright', () => {
    expect(matchEntries([row({definitionId: 'def-ohp'})], [entry('a', {def: 'def-landmine'})]).matched[0])
      .toBeUndefined()
  })

  it('refuses an entry for a different lift, however the plan blocks line up', () => {
    expect(matchEntries([row({exercise: 'Row'})], [entry('a')]).matched[0]).toBeUndefined()
  })
})

describe('a lift with no rep range', () => {
  it('carries forward the reps you last did, rather than stamping zero', () => {
    // A carry has neither `repMin` nor `repMax` — the range is no help, but
    // what you did last time is. Stamping 0 records a set performed for zero
    // reps, which every volume total and the engine then believe.
    const {lifts} = planFromPrescription(prescription([exercise({
      exercise: 'Waiter carry', repMin: undefined, repMax: undefined, freeform: true,
      weight: 53, sets: 2,
      lastTime: {date: '2026-07-17', weight: 53, reps: [40, 40]},
    })]), 'lb')

    expect(lifts[0].sets.map(s => s.reps)).toEqual([40, 40])
  })

  it('still stamps zero when there is nothing to carry forward', () => {
    const {lifts} = planFromPrescription(prescription([exercise({
      exercise: 'Waiter carry', repMin: undefined, repMax: undefined, freeform: true,
    })]), 'lb')

    expect(lifts[0].sets.every(s => s.reps === 0)).toBe(true)
    expect(lifts[0].sets).toHaveLength(3)
  })
})

describe('matchEntries reports what it claimed', () => {
  it('names the entries it handed out, so a derived fallback cannot reuse one', () => {
    // A row that matched nothing here still derives an id, and that id can be
    // an entry the by-name pass just gave to another row — a definition
    // renamed away from the name a bare row still uses is enough. Without the
    // claim set travelling out, both lifts adopt one entry and one set tree.
    const a = {id: 'a', properties: {'strength:exercise': 'Press'} as Record<string, unknown>}
    const {matched, claimed} = matchEntries([{
      exercise: 'Press', occurrence: 0, unit: 'lb', prescribedSets: 1, sets: [],
    }], [a])

    expect(matched[0]).toBe(a)
    expect([...claimed]).toEqual(['a'])
  })
})

describe('choicesToRecord', () => {
  const exercises = [
    {exercise: 'Face pulls', altGroupKey: 'group-pull'},
    {exercise: 'Bench press'},
  ]

  it('records a pick the confirmed session actually prescribes, under its name', () => {
    expect(choicesToRecord({'group-pull': 'opt-face-pulls'}, exercises))
      .toEqual([{groupKey: 'group-pull', optionKey: 'opt-face-pulls', label: 'Face pulls'}])
  })

  it('drops a pick belonging to a session that was previewed and then switched away from', () => {
    // Flip a variant while Session A is showing, change the picker to B, and
    // press Start: A's group is still in `picks`. Recorded, it retracks a
    // session you never started — and with no exercise here to name it, the
    // writer's label used to fall through to the option's raw block id, so a
    // UUID appeared as the choice's name in the settings outline.
    expect(choicesToRecord({'group-squat': 'opt-front-squat'}, exercises)).toEqual([])
  })

  it('keeps the surviving picks when only some belong to this session', () => {
    const kept = choicesToRecord(
      {'group-pull': 'opt-face-pulls', 'group-squat': 'opt-front-squat'},
      exercises,
    )
    expect(kept.map(c => c.groupKey)).toEqual(['group-pull'])
  })
})
