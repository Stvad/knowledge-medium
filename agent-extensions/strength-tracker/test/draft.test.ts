import {describe, expect, it} from 'vitest'

import {buildDraft, hasAcceptedSets, overlayLive, overlayLiveValues, toMaterializeDraft} from '../src/ui/draft'
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

  it('records the plan block the exercise came from', () => {
    const draft = buildDraft(prescription({defId: 'def-bench'}), 'lb')
    expect(toMaterializeDraft('2026-07-23', 'A', draft).exercises[0].definitionId).toBe('def-bench')
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

  it('re-attaches by plan block when the exercise was renamed mid-session', () => {
    const renamed: LiveWorkout = {
      ...live,
      exercises: [{...live.exercises[0], exercise: 'Bench press (comp grip)', definitionId: 'def-bench'}],
    }
    const merged = overlayLive(buildDraft(prescription({defId: 'def-bench'}), 'lb'), renamed)
    expect(merged[0].blockId).toBe('e1')
    expect(merged[0].sets.map(s => s.blockId)).toEqual(['s1', 's2'])
  })
})

describe('overlayLiveValues', () => {
  const materialized = () => {
    const draft = buildDraft(prescription(), 'lb')
    draft[0].blockId = 'e1'
    draft[0].sets.forEach((s, i) => (s.blockId = `s${i}`))
    return draft
  }

  const liveWith = (sets: LiveWorkout['exercises'][number]['sets']): LiveWorkout => ({
    id: 'w1', day: '2026-07-23', session: 'A',
    exercises: [{id: 'e1', exercise: 'Bench press', unit: 'lb', sets}],
  })

  it('adopts a value this client has not touched — another device, or an adopted workout', () => {
    const next = overlayLiveValues(materialized(), liveWith([
      {id: 's0', weight: 145, reps: 9, done: true, completedAt: 111},
    ]))
    expect(next[0].sets[0]).toMatchObject({weight: 145, reps: 9, done: true, completedAt: 111})
  })

  it('lets the block win over a local value — that is what makes the draft un-stale-able', () => {
    // Unconditional on purpose. The draft holds only settled values (a
    // number being typed lives in the input's own state), so there is
    // nothing half-finished here to protect, and Finish writing the draft
    // back can't clobber a value it has already re-read.
    const draft = materialized()
    draft[0].sets[0] = {...draft[0].sets[0], weight: 150, done: true}
    const next = overlayLiveValues(draft, liveWith([{id: 's0', weight: 135, reps: 10, done: false}]))
    expect(next[0].sets[0]).toMatchObject({weight: 135, done: false})
  })

  it('leaves a set with a write in flight alone — the block is behind, not ahead', () => {
    // The tap already happened and its write is still going. "The block wins"
    // here reverts the user's own checkbox in front of them, and during an
    // "all ✓" loop it ripples through every set the loop hasn't reached yet.
    const draft = materialized()
    draft[0].sets[0] = {...draft[0].sets[0], done: true}
    const next = overlayLiveValues(
      draft,
      liveWith([{id: 's0', weight: 135, reps: 10, done: false}]),
      new Set(['s0']),
    )
    expect(next).toBe(draft)
  })

  it('ignores sets with no block yet, and touches no structure', () => {
    const draft = buildDraft(prescription(), 'lb')
    expect(overlayLiveValues(draft, liveWith([{id: 's0', weight: 999, reps: 1, done: true}]))).toBe(draft)
  })

  it('returns the same array when nothing moved, so it can run on every emission', () => {
    const draft = materialized()
    const live = liveWith(draft[0].sets.map((s, i) => ({
      id: `s${i}`, weight: s.weight, reps: s.reps, done: s.done,
    })))
    expect(overlayLiveValues(draft, live)).toBe(draft)
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
