import {describe, expect, it} from 'vitest'

import {
  buildDraft, hasAcceptedSets, overlayLive, prescriptionShape, rowKey, setKey, toMaterializeDraft,
} from '../src/ui/draft'
import type {LiveWorkout} from '../src/km/history'
import type {Prescription} from '../src/engine/types'

const exerciseOf = (over: Partial<Prescription['exercises'][number]> = {}) => ({
  exercise: 'Bench press', sets: 3, repMin: 6, repMax: 10, weight: 135,
  perSide: false, freeform: false, rationale: 'hold 135', ...over,
})

const prescription = (over: Partial<Prescription['exercises'][number]> = {}): Prescription => ({
  day: '2026-07-23',
  session: 'A',
  offSchedule: false,
  notes: [],
  exercises: [exerciseOf(over)],
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

  it('numbers the rows of a twice-prescribed lift, so they are different rows', () => {
    // The whole point of counting here rather than at each use: the block-id
    // derivation, the live match and the in-flight bookkeeping all read this
    // one number instead of each recounting from a different array.
    const twice: Prescription = {
      ...prescription(),
      exercises: [exerciseOf({defId: 'def-face'}), exerciseOf({defId: 'def-face'}), exerciseOf({exercise: 'Row'})],
    }
    const draft = buildDraft(twice, 'lb')
    expect(draft.map(ex => ex.occurrence)).toEqual([0, 1, 0])
    expect(new Set(draft.map(rowKey)).size).toBe(3)
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
  const base = () => buildDraft(prescription(), 'lb')

  const liveWith = (
    sets: LiveWorkout['exercises'][number]['sets'],
    over: Partial<LiveWorkout['exercises'][number]> = {},
  ): LiveWorkout => ({
    id: 'w1', day: '2026-07-23', session: 'A',
    exercises: [{id: 'e1', exercise: 'Bench press', unit: 'lb', sets, ...over}],
  })

  /** What is on screen after the workout was created: every set carries its
   *  block, values still as prescribed. */
  const materialized = () => {
    const draft = base()
    draft[0].blockId = 'e1'
    draft[0].sets.forEach((s, i) => (s.blockId = `s${i}`))
    return draft
  }

  const live = liveWith([
    {id: 's1', weight: 140, reps: 9, done: true},
    {id: 's2', weight: 140, reps: 8, done: false},
  ], {prescribedSets: 3})

  it('lays the block values + ids over the prescription, keeping its metadata', () => {
    const merged = overlayLive(base(), live)
    expect(merged[0].blockId).toBe('e1')
    expect(merged[0].sets.slice(0, 2).map(s => s.blockId)).toEqual(['s1', 's2'])
    expect(merged[0].sets[0]).toMatchObject({weight: 140, reps: 9, done: true})
    expect(merged[0].rationale).toBe('hold 135') // metadata still from the prescription
  })

  it('keeps pre-filled sets for an exercise the live workout lacks', () => {
    const merged = overlayLive(base(), undefined)
    expect(merged[0].blockId).toBeUndefined()
    expect(merged[0].sets).toHaveLength(3)
  })

  it('re-attaches by plan block when the exercise was renamed mid-session', () => {
    const renamed = liveWith(live.exercises[0].sets, {
      exercise: 'Bench press (comp grip)', definitionId: 'def-bench',
    })
    const merged = overlayLive(buildDraft(prescription({defId: 'def-bench'}), 'lb'), renamed)
    expect(merged[0].blockId).toBe('e1')
    expect(merged[0].sets.slice(0, 2).map(s => s.blockId)).toEqual(['s1', 's2'])
  })

  it('never shows fewer set rows than the plan prescribes', () => {
    // The workout, entry and set queries emit independently, so an entry can
    // arrive with none of its sets. Taking the live count verbatim made every
    // row of that lift vanish for a beat mid-session.
    const merged = overlayLive(base(), liveWith([]))
    expect(merged[0].sets).toHaveLength(3)
    expect(merged[0].blockId).toBe('e1')
  })

  it('shows a logged set the plan no longer prescribes', () => {
    const shorter = buildDraft(prescription({sets: 1}), 'lb')
    const merged = overlayLive(shorter, liveWith([
      {id: 's0', weight: 135, reps: 10, done: true},
      {id: 's1', weight: 135, reps: 9, done: true},
    ]))
    expect(merged[0].sets.map(s => s.blockId)).toEqual(['s0', 's1'])
  })

  it('adopts a value this client has not touched — another device, or an adopted workout', () => {
    const merged = overlayLive(base(), liveWith([
      {id: 's0', weight: 145, reps: 9, done: true, completedAt: 111},
    ]), materialized())
    expect(merged[0].sets[0]).toMatchObject({weight: 145, reps: 9, done: true, completedAt: 111})
  })

  it('lets the block win over what is on screen — that is what makes the draft un-stale-able', () => {
    // Unconditional on purpose. The draft holds only settled values (a number
    // being typed lives in the input's own state), so there is nothing
    // half-finished here to protect, and Finish writing the draft back can't
    // clobber a value it has already re-read.
    const previous = materialized()
    previous[0].sets[0] = {...previous[0].sets[0], weight: 150, done: true}
    const merged = overlayLive(base(), liveWith([{id: 's0', weight: 135, reps: 10, done: false}]), previous)
    expect(merged[0].sets[0]).toMatchObject({weight: 135, done: false})
  })

  it('leaves a set with a write in flight alone — the block is behind, not ahead', () => {
    // The tap already happened and its write is still going. "The block wins"
    // here reverts the user's own checkbox in front of them, and during an
    // "all ✓" loop it ripples through every set the loop hasn't reached yet.
    const previous = materialized()
    previous[0].sets[0] = {...previous[0].sets[0], done: true}
    const merged = overlayLive(
      base(),
      liveWith(previous[0].sets.map((s, i) => ({id: `s${i}`, weight: s.weight, reps: s.reps, done: false}))),
      previous,
      new Set([setKey(previous[0], 0)]),
    )
    expect(merged).toBe(previous)
  })

  it('drops a set the live entry no longer lists — it was deleted, not delayed', () => {
    // An entry that lists sets is authoritative for every index, including the
    // ones it does not list. Holding the id instead left the draft pointing at
    // a block that was undone, deleted from the outline, or pruned by a
    // Finish, with every later tap landing nowhere and the checkbox still
    // ticked.
    const previous = materialized()
    const merged = overlayLive(base(), liveWith([
      {id: 's0', weight: 205, reps: 5, done: true},
      {id: 's1', weight: 205, reps: 5, done: true},
    ]), previous)
    expect(merged[0].sets.map(s => s.blockId)).toEqual(['s0', 's1', undefined])
    expect(merged[0].sets[2]).toMatchObject({weight: 135, done: false})
  })

  /** A lift whose middle set was deleted: the survivors are still sets 0 and
   *  2, but `live.sets` is compacted and reads as a list of two. */
  const withMiddleDeleted = () => liveWith([
    {id: 's0', weight: 205, reps: 5, done: true, index: 0},
    {id: 's2', weight: 215, reps: 3, done: true, index: 2},
  ])

  it('keeps every row on its own block when one is deleted from the middle', () => {
    // Matched by position, row 1 took row 2's block while row 2 came up empty
    // — and the create that fills row 2 in derives from row 2's INDEX, handing
    // back the block row 1 was already showing. Two rows, one block, and row
    // 2's next edit overwrites what row 1 logged.
    const merged = overlayLive(base(), withMiddleDeleted(), materialized())

    expect(merged[0].sets.map(s => s.blockId)).toEqual(['s0', undefined, 's2'])
    expect(merged[0].sets[2]).toMatchObject({weight: 215, reps: 3})
    // The deleted one reads as un-logged rather than borrowing its neighbour.
    expect(merged[0].sets[1]).toMatchObject({weight: 135, done: false})
  })

  it('still does, on a fresh draft with nothing to remember', () => {
    // The reload case. Nothing on screen holds a block id, so any rule that
    // recovers the slot from what the draft was ALREADY showing is unavailable
    // — the block has to say which set it is, and it does.
    const merged = overlayLive(base(), withMiddleDeleted())
    expect(merged[0].sets.map(s => s.blockId)).toEqual(['s0', undefined, 's2'])
  })

  it('keeps a logged set the prescription no longer reaches, and renders the gap', () => {
    // The plan was cut to one set AFTER two were logged and the middle one
    // deleted, so the blocks claim indices 0 and 2 — two sets reaching slot 3.
    // Sizing the draft by the live LIST length dropped set 2 off the end (a
    // logged set, invisible and unreachable) and filled the slot it vacated
    // from a prescription that no longer reaches it, i.e. with `undefined`,
    // which every renderer downstream read straight through.
    const merged = overlayLive(buildDraft(prescription({sets: 1}), 'lb'), withMiddleDeleted())

    expect(merged[0].sets).toHaveLength(3)
    expect(merged[0].sets.every(Boolean)).toBe(true)
    expect(merged[0].sets.map(s => s.blockId)).toEqual(['s0', undefined, 's2'])
    expect(merged[0].sets[1]).toMatchObject({weight: 135, done: false})
  })

  it('alternates the sides of a gap slot on a per-side lift', () => {
    // The L/R rows alternate by index, so a slot the prescription doesn't
    // reach still has a correct side — it is a real, loggable set.
    const perSide = prescription({exercise: 'Waiter carry', sets: 1, perSide: true, repMax: undefined, weight: 40})
    const merged = overlayLive(buildDraft(perSide, 'lb'), {
      id: 'w1', day: '2026-07-23', session: 'A',
      exercises: [{id: 'e1', exercise: 'Waiter carry', unit: 'lb', sets: [
        {id: 'c3', weight: 40, reps: 8, done: true, side: 'R', index: 3},
      ]}],
    })
    expect(merged[0].sets.map(s => s.side)).toEqual(['L', 'R', 'L', 'R'])
  })

  it('will not let a hand-edited index size the draft', () => {
    // The index is an ordinary editable number on an ordinary block. Used
    // unchecked it does not produce a wrong row — it asks for a billion of
    // them and takes the client with it.
    const merged = overlayLive(base(), liveWith([
      {id: 'huge', weight: 205, reps: 5, done: true, index: 1_000_000_000},
    ]))
    expect(merged[0].sets.length).toBeLessThanOrEqual(64)
    // …and the set is still shown, in the fallback slot rather than nowhere.
    expect(merged[0].sets[0].blockId).toBe('huge')
  })

  it('does not hide a set behind a nonsensical or duplicated index', () => {
    const merged = overlayLive(base(), liveWith([
      {id: 'neg', weight: 1, reps: 1, done: true, index: -3},
      {id: 'frac', weight: 2, reps: 2, done: true, index: 1.5},
      {id: 'dupe-a', weight: 3, reps: 3, done: true, index: 2},
      {id: 'dupe-b', weight: 4, reps: 4, done: true, index: 2},
    ]))
    const shown = merged[0].sets.map(s => s.blockId).filter(Boolean)
    expect(new Set(shown)).toEqual(new Set(['neg', 'frac', 'dupe-a', 'dupe-b']))
  })

  it('does not swap two sets when one is hand-edited onto the other\'s index', () => {
    // Letting the first of a colliding pair keep the slot and dropping the
    // second into the gap the first vacated SWAPS them: row 0 then holds set
    // 2's block and row 1 holds set 1's, so every later edit to either row —
    // weight, reps, the checkbox — is recorded against the other set. A
    // duplicated index says the indices cannot be trusted, so neither of them
    // is used and the pair keeps its sibling order.
    const merged = overlayLive(base(), liveWith([
      {id: 'first', weight: 1, reps: 1, done: true, index: 1},
      {id: 'second', weight: 2, reps: 2, done: true, index: 1},
    ]))
    expect(merged[0].sets.map(s => s.blockId)).toEqual(['first', 'second', undefined])
  })

  it('falls back to position for sets written before they carried an index', () => {
    // Pre-property data: a contiguous list is the best guess available, and it
    // is right for every set that has not had a sibling deleted.
    const merged = overlayLive(base(), liveWith([
      {id: 'old0', weight: 205, reps: 5, done: true},
      {id: 'old1', weight: 205, reps: 5, done: true},
    ]))
    expect(merged[0].sets.map(s => s.blockId)).toEqual(['old0', 'old1', undefined])
  })

  it('lets go of a lift whose entry was deleted, rather than writing at a tombstone', () => {
    // The workout is on screen and has no entry for this lift, which says the
    // entry is GONE — not that a create is catching up. Holding its id aimed
    // every later write at a tombstone, and the failure path just re-derived
    // the same draft, so every tap failed until a reload. Its sets go with it:
    // deleting a block takes its subtree.
    const merged = overlayLive(base(), {
      id: 'w1', day: '2026-07-23', session: 'A', exercises: [],
    }, materialized())
    expect(merged[0].blockId).toBeUndefined()
    expect(merged[0].sets.every(s => s.blockId === undefined)).toBe(true)
  })

  it('does not read a not-yet-loaded workout as one that lost the lift', () => {
    // The workout, entry and set queries resolve independently, so a workout
    // really can arrive before its entries. Read as a deletion, the row drops
    // its blocks — and a tap in that window re-derives an entry id, which for
    // a name-keyed session is a SECOND entry tree beside the real one.
    const emptyWorkout = {id: 'w1', day: '2026-07-23', session: 'A' as const, exercises: []}
    const merged = overlayLive(base(), emptyWorkout, materialized(), new Set(), false)
    expect(merged[0].blockId).toBe('e1')
    expect(merged[0].sets.map(s => s.blockId)).toEqual(['s0', 's1', 's2'])
  })

  it('holds its ids while the queries have not answered yet', () => {
    // The workout, entry and set queries resolve independently, so an entry
    // really can arrive with none of its sets. That window must not blank the
    // lift — and it is told apart from a real emptiness by the QUERY, not by
    // the emptiness, because `[]` says nothing about which one it is.
    const merged = overlayLive(base(), liveWith([]), materialized(), new Set(), false)
    expect(merged[0].sets.map(s => s.blockId)).toEqual(['s0', 's1', 's2'])
  })

  it('lets go once they have, even when the answer is nothing', () => {
    // Every set of this lift was deleted. Guessed at from `[]` this read as
    // "still loading", so the draft kept the tombstoned ids, the next write
    // came back `gone`, and the resync rebuilt the very same stale draft —
    // the lift was unwritable until a reload.
    const merged = overlayLive(base(), liveWith([]), materialized(), new Set(), true)
    expect(merged[0].sets.every(set => set.blockId === undefined)).toBe(true)
  })

  it('protects the very first tap, whose write is what creates the block', () => {
    // Nothing has a block id yet, so an exemption keyed on the block cannot
    // name this set at all — and the emission from its own create would
    // re-derive it from the prescription and drop the tick.
    const previous = base()
    previous[0].sets[0] = {...previous[0].sets[0], done: true}
    const merged = overlayLive(base(), undefined, previous, new Set([setKey(previous[0], 0)]))
    expect(merged[0].sets[0].done).toBe(true)
  })

  it('gives an exempt set the id its create just returned', () => {
    const previous = base()
    previous[0].sets[0] = {...previous[0].sets[0], done: true}
    const merged = overlayLive(
      base(),
      liveWith([{id: 's0', weight: 135, reps: 10, done: false}]),
      previous,
      new Set([setKey(previous[0], 0)]),
    )
    expect(merged[0].sets[0]).toMatchObject({done: true, blockId: 's0'})
  })

  it('keeps ids we created while the query is still catching up', () => {
    // The create stamped these ids; `live` has not emitted them yet. Losing
    // them here is what made the next tap start a second workout.
    const merged = overlayLive(base(), undefined, materialized())
    expect(merged[0].blockId).toBe('e1')
    expect(merged[0].sets.map(s => s.blockId)).toEqual(['s0', 's1', 's2'])
  })

  it('gives a plan-backed row its own entry before a name-only row takes it', () => {
    // The name-only row comes FIRST, and falls back by name. Allocating in
    // one pass let it take the very entry the later row matches exactly on
    // its plan block — that row then read as unlogged, and its next write
    // attached both rows to one derived entry.
    const mixed: Prescription = {
      ...prescription(),
      exercises: [exerciseOf(), exerciseOf({defId: 'def-bench'})],
    }
    const merged = overlayLive(buildDraft(mixed, 'lb'), {
      id: 'w1', day: '2026-07-23', session: 'A',
      exercises: [
        {id: 'e-plain', exercise: 'Bench press', unit: 'lb', sets: [{id: 'p0', weight: 95, reps: 12, done: true}]},
        {id: 'e-planned', exercise: 'Bench press', definitionId: 'def-bench', unit: 'lb',
          sets: [{id: 'q0', weight: 205, reps: 5, done: true}]},
      ],
    })
    expect(merged.map(ex => ex.blockId)).toEqual(['e-plain', 'e-planned'])
  })

  it('gives two same-named lifts their own entries when neither entry knows its plan block', () => {
    // Both were logged while the outline was unreadable, so both entries are
    // name-keyed; once it resolves, each row carries a DIFFERENT plan block
    // and so each counts as occurrence 0 of itself. Asking for "occurrence 0
    // by name" made both rows want the same entry — the second was refused and
    // its next edit started a parallel log for a lift already being tracked.
    const twoLifts: Prescription = {
      ...prescription(),
      exercises: [exerciseOf({defId: 'def-a'}), exerciseOf({defId: 'def-b'})],
    }
    const merged = overlayLive(buildDraft(twoLifts, 'lb'), {
      id: 'w1', day: '2026-07-23', session: 'A',
      exercises: [
        {id: 'e-first', exercise: 'Bench press', unit: 'lb', sets: [{id: 'f0', weight: 205, reps: 5, done: true}]},
        {id: 'e-second', exercise: 'Bench press', unit: 'lb', sets: [{id: 's0', weight: 95, reps: 12, done: true}]},
      ],
    })
    expect(merged.map(ex => ex.blockId)).toEqual(['e-first', 'e-second'])
  })

  it('drops the blocks of a row that became a different lift', () => {
    // An `or`-group switched away: the new row is not the old row, and
    // inheriting its blocks would log the new option into the old one.
    const switched = buildDraft(prescription({exercise: 'Landmine press', defId: 'def-lm'}), 'lb')
    const merged = overlayLive(switched, undefined, materialized())
    expect(merged[0].blockId).toBeUndefined()
    expect(merged[0].sets.every(s => s.blockId === undefined)).toBe(true)
  })

  it('returns the same array when nothing moved, so it can run on every emission', () => {
    const previous = materialized()
    const unchanged = liveWith(previous[0].sets.map((s, i) => ({
      id: `s${i}`, weight: s.weight, reps: s.reps, done: s.done,
    })))
    expect(overlayLive(base(), unchanged, previous)).toBe(previous)
  })

  it('reuses the row objects that did not move', () => {
    const previous = [...materialized(), ...buildDraft(prescription({exercise: 'Row'}), 'lb')]
    const twoRows: Prescription = {
      ...prescription(),
      exercises: [exerciseOf(), exerciseOf({exercise: 'Row'})],
    }
    const merged = overlayLive(buildDraft(twoRows, 'lb'), liveWith([
      {id: 's0', weight: 145, reps: 9, done: true},
    ]), previous)
    expect(merged[0]).not.toBe(previous[0])   // its first set moved
    expect(merged[1]).toBe(previous[1])       // this one did not
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

describe('prescriptionShape', () => {
  it('does not let a lift NAME spell another row', () => {
    // Exercise names are user text. Joined with delimiters, one lift called
    // `Bench:100:3:5-5:false,Squat` reads as the two rows it imitates — and
    // two plans with the same shape means the coordinator never bumps its
    // generation or clears the positional ids it cached for the old one.
    const imitator = prescriptionShape([
      exerciseOf({exercise: 'Bench:100:3:5-5:false,Squat', weight: 200, sets: 4, repMin: 8, repMax: 8}),
    ])
    const genuine = prescriptionShape([
      exerciseOf({exercise: 'Bench', weight: 100, sets: 3, repMin: 5, repMax: 5}),
      exerciseOf({exercise: 'Squat', weight: 200, sets: 4, repMin: 8, repMax: 8}),
    ])
    expect(imitator).not.toEqual(genuine)
  })

  it('still reads a real change as a change', () => {
    const before = prescriptionShape([exerciseOf()])
    expect(prescriptionShape([exerciseOf({weight: 145})])).not.toEqual(before)
    expect(prescriptionShape([exerciseOf()])).toEqual(before)
  })
})
