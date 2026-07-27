import {describe, expect, it} from 'vitest'

import {applyIdPatch, createWriteCoordinator, type WriteEffects} from '../src/ui/writeCoordinator'
import type {DraftExercise} from '../src/ui/draft'
import type {MaterializedWorkout} from '../src/km/store'

type ExerciseEntryIdsForTest = {id: string; setIds: string[]}

/** Every bug this module exists to prevent was a SEQUENCING bug — two taps
 *  in flight, a create resolving after a session switch, a batch holding a
 *  snapshot older than the ids it needs. So the fakes here resolve on
 *  command: each test decides exactly when a create finishes. */
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return {promise, resolve}
}

const exercise = (name: string, sets: number, over: Partial<DraftExercise> = {}): DraftExercise => ({
  exercise: name,
  occurrence: 0,
  unit: 'lb',
  freeform: false,
  perSide: false,
  rationale: '',
  sets: Array.from({length: sets}, () => ({weight: 135, reps: 8, done: false})),
  ...over,
})

const workoutIds = (id: string, shape: number[]): MaterializedWorkout => ({
  workoutId: id,
  exercises: shape.map((count, i) => ({
    id: `${id}-e${i}`,
    setIds: Array.from({length: count}, (_, j) => `${id}-e${i}s${j}`),
  })),
})

/** Effects that record what was asked of them and resolve immediately. */
const instantEffects = () => {
  const calls = {workouts: 0, exercises: [] as string[]}
  const effects: WriteEffects = {
    createWorkout: async draft => {
      calls.workouts += 1
      return workoutIds('w1', draft.map(ex => ex.sets.length))
    },
    createExercise: async (workoutId, ex) => {
      calls.exercises.push(ex.exercise)
      // Mirrors the real derivation closely enough to be worth asserting on:
      // the entry's blocks come from the lift AND which occurrence of it this
      // is, so two rows of one lift land on different blocks.
      const key = ex.occurrence === 0 ? ex.exercise : `${ex.exercise}#${ex.occurrence}`
      return {id: `${workoutId}-${key}`, setIds: ex.sets.map((_, j) => `${workoutId}-${key}-s${j}`)}
    },
  }
  return {calls, effects}
}

describe('resolveSet — nothing created yet', () => {
  it('creates the workout once, however many sets ask at the same time', async () => {
    // "Accept all" hands every set the SAME block-less snapshot. Before this
    // module, later sets concluded their exercise was missing and created a
    // duplicate.
    const draft = [exercise('Bench press', 3)]
    const {calls, effects} = instantEffects()
    const coord = createWriteCoordinator()

    const results = await Promise.all(
      draft[0].sets.map((_, j) => coord.resolveSet(draft, 0, j, effects)),
    )

    expect(calls.workouts).toBe(1)
    expect(calls.exercises).toEqual([])
    expect(results.map(r => r.blockId)).toEqual(['w1-e0s0', 'w1-e0s1', 'w1-e0s2'])
  })

  it('shares one in-flight create between a tap and a Finish that lands mid-flight', async () => {
    const draft = [exercise('Bench press', 2)]
    const gate = deferred<MaterializedWorkout>()
    let starts = 0
    const effects: WriteEffects = {
      createWorkout: () => { starts += 1; return gate.promise },
      createExercise: async () => ({id: 'x', setIds: []}),
    }
    const coord = createWriteCoordinator()

    const first = coord.resolveSet(draft, 0, 0, effects)
    const second = coord.resolveSet(draft, 0, 1, effects)
    gate.resolve(workoutIds('w1', [2]))

    expect(await first).toMatchObject({blockId: 'w1-e0s0'})
    expect(await second).toMatchObject({blockId: 'w1-e0s1'})
    expect(starts).toBe(1)
    expect(coord.workoutId()).toBe('w1')
  })

  it('reports the ids so the caller can stamp them into its draft', async () => {
    const {effects} = instantEffects()
    const coord = createWriteCoordinator()
    const {patch} = await coord.resolveSet([exercise('Bench press', 1)], 0, 0, effects)
    expect(patch).toEqual({kind: 'workout', workout: workoutIds('w1', [1])})
  })
})

describe('resolveSet — workout already exists', () => {
  it('writes straight to a set that has a block', async () => {
    const draft = [exercise('Bench press', 1)]
    draft[0].blockId = 'e1'
    draft[0].sets[0].blockId = 's1'
    const {calls, effects} = instantEffects()
    const coord = createWriteCoordinator('w1')

    // …and says which workout that block belongs to, so the caller validates
    // against the session it resolved against rather than the current one.
    expect(await coord.resolveSet(draft, 0, 0, effects)).toEqual({blockId: 's1', workoutId: 'w1'})
    expect(calls).toEqual({workouts: 0, exercises: []})
  })

  it('creates the exercise for an option switched in mid-session', async () => {
    const draft = [exercise('Landmine press', 2, {defId: 'def-landmine'})]
    const {calls, effects} = instantEffects()
    const coord = createWriteCoordinator('w1')

    const {blockId, patch} = await coord.resolveSet(draft, 0, 0, effects)
    expect(calls.exercises).toEqual(['Landmine press'])
    expect(blockId).toBe('w1-Landmine press-s0')
    expect(patch).toMatchObject({kind: 'exercise', exIdx: 0})
  })

  it('creates it once for the whole batch, not once per set', async () => {
    const draft = [exercise('Landmine press', 3, {defId: 'def-landmine'})]
    const {calls, effects} = instantEffects()
    const coord = createWriteCoordinator('w1')

    for (const [j] of draft[0].sets.entries()) await coord.resolveSet(draft, 0, j, effects)
    expect(calls.exercises).toEqual(['Landmine press'])
  })

  it('creates the SECOND option when the same slot is switched twice', async () => {
    // Keyed by the option, not the row: reusing the row's earlier promise
    // wrote the new option's reps into the old option's sets.
    const {calls, effects} = instantEffects()
    const coord = createWriteCoordinator('w1')

    await coord.resolveSet([exercise('Landmine press', 1, {defId: 'def-landmine'})], 0, 0, effects)
    await coord.resolveSet([exercise('Overhead press', 1, {defId: 'def-ohp'})], 0, 0, effects)

    expect(calls.exercises).toEqual(['Landmine press', 'Overhead press'])
  })

  it('gives each row of a twice-prescribed lift its own entry', async () => {
    // Same name, same plan block — only `occurrence` tells them apart, and it
    // is what the derived entry id is built from. Sharing a create here means
    // both rows write into one entry and overwrite each other set for set.
    const {calls, effects} = instantEffects()
    const coord = createWriteCoordinator('w1')
    const draft = [
      exercise('Face pulls', 1, {defId: 'def-face', occurrence: 0}),
      exercise('Face pulls', 1, {defId: 'def-face', occurrence: 1}),
    ]

    const first = await coord.resolveSet(draft, 0, 0, effects)
    const second = await coord.resolveSet(draft, 1, 0, effects)

    expect(calls.exercises).toEqual(['Face pulls', 'Face pulls'])
    expect(first.blockId).not.toBe(second.blockId)
  })

  it('keeps one create per row when a plan edit reorders the session', async () => {
    // The identity is the lift, not the index. Keyed on the index, the second
    // call looked like a different row and created the entry twice.
    const gate = deferred<ExerciseEntryIdsForTest>()
    let starts = 0
    const effects: WriteEffects = {
      createWorkout: async () => workoutIds('w1', [1]),
      createExercise: () => { starts += 1; return gate.promise },
    }
    const coord = createWriteCoordinator('w1')
    const row = exercise('Landmine press', 2, {defId: 'def-lm'})

    const first = coord.resolveSet([row], 0, 0, effects)
    const second = coord.resolveSet([exercise('Squat', 1), row], 1, 1, effects)
    gate.resolve({id: 'e-lm', setIds: ['e-lm-s0', 'e-lm-s1']})

    expect((await first).blockId).toBe('e-lm-s0')
    expect((await second).blockId).toBe('e-lm-s1')
    expect(starts).toBe(1)
  })
})

const SLOT_A = '2026-07-24|A'
const SLOT_B = '2026-07-24|B'
const SHAPE = 'bench'

describe('reset — the session was switched', () => {
  it('withholds the ids of a create that lands after the switch', async () => {
    // Those ids belong to the workout that is no longer being edited;
    // stamping them into the new draft pointed tonight's edits at last
    // night's blocks.
    const draft = [exercise('Bench press', 1)]
    const gate = deferred<MaterializedWorkout>()
    const effects: WriteEffects = {
      createWorkout: () => gate.promise,
      createExercise: async () => ({id: 'x', setIds: []}),
    }
    const coord = createWriteCoordinator()

    const pending = coord.resolveSet(draft, 0, 0, effects)
    coord.reset(null, SLOT_B, SHAPE)        // user flipped A → B
    gate.resolve(workoutIds('w-old', [1]))

    const result = await pending
    expect(result.patch).toBeUndefined()
    expect(coord.workoutId()).toBeNull()    // NOT the old workout
    expect(coord.materialized()).toBeNull()
  })

  it('adopts the workout the reseed found live, and starts a fresh create after that', async () => {
    const {calls, effects} = instantEffects()
    const coord = createWriteCoordinator()
    await coord.resolveSet([exercise('Bench press', 1)], 0, 0, effects)

    coord.reset(null, SLOT_B, SHAPE)
    await coord.resolveSet([exercise('Squat', 1)], 0, 0, effects)
    expect(calls.workouts).toBe(2)

    coord.reset('w-live', SLOT_A, SHAPE)
    expect(coord.workoutId()).toBe('w-live')
  })

  it('keeps what it created when the reseed is only the live query catching up', async () => {
    // The create's own commit invalidates the queries, so `live` appears and
    // the view reseeds. Forgetting `materialized` there made the rest of an
    // "all ✓" batch — still holding the block-less snapshot — create the
    // exercise a second time.
    const draft = [exercise('Bench press', 3)]
    const {calls, effects} = instantEffects()
    const coord = createWriteCoordinator(null, SLOT_A, SHAPE)

    await coord.resolveSet(draft, 0, 0, effects)
    coord.reset('w1', SLOT_A, SHAPE)              // same slot, same exercises
    await coord.resolveSet(draft, 0, 1, effects)
    await coord.resolveSet(draft, 0, 2, effects)

    expect(calls).toEqual({workouts: 1, exercises: []})
  })

  it('keeps the workout when the exercise list changes under it', async () => {
    // An or-group switch changes the shape but NOT which workout is being
    // logged. Nulling the id here started a second workout for the same night.
    const {calls, effects} = instantEffects()
    const coord = createWriteCoordinator(null, SLOT_A, SHAPE)
    await coord.resolveSet([exercise('Bench press', 1)], 0, 0, effects)

    coord.reset(null, SLOT_A, 'bench,landmine')
    expect(coord.workoutId()).toBe('w1')
    // …and the positional ids from the old shape are dropped, so a set with
    // no block creates its exercise rather than reusing a stale id.
    await coord.resolveSet([exercise('Landmine press', 1, {defId: 'def-lm'})], 0, 0, effects)
    expect(calls).toEqual({workouts: 1, exercises: ['Landmine press']})
  })

  it('remembers the shape it saw when the workout was replaced', async () => {
    // The replacement branch clears the caches, and it has to record the
    // shape it arrived with too — otherwise the NEXT emission reads the same
    // shape as changed again, bumps the generation a second time, and aborts
    // whatever was mid-flight: an accept-all batch between sets, or a Finish
    // that then reports the session changed.
    const coord = createWriteCoordinator('w1', SLOT_A, SHAPE)

    expect(coord.reset('w2', SLOT_A, 'bench,landmine')).toEqual({slotChanged: false, shapeChanged: true})
    const settled = coord.generation()

    expect(coord.reset('w2', SLOT_A, 'bench,landmine')).toEqual({slotChanged: false, shapeChanged: false})
    expect(coord.generation()).toBe(settled)
  })

  it('drops the positional ids when a DIFFERENT workout turns up on the same slot', async () => {
    // A peer finished ours and started the next one, and our query jumped
    // straight from one to the other. Everything cached is positional inside
    // the old workout, and an id taken from it names a block in what is now a
    // finished record.
    const {effects} = instantEffects()
    const coord = createWriteCoordinator(null, SLOT_A, SHAPE)
    await coord.resolveSet([exercise('Bench press', 1)], 0, 0, effects)
    expect(coord.materialized()).not.toBeNull()

    coord.reset('w2', SLOT_A, SHAPE)

    expect(coord.workoutId()).toBe('w2')
    expect(coord.materialized()).toBeNull()
  })

  it('keeps the workout when a reseed arrives with no live workout yet', async () => {
    const {calls, effects} = instantEffects()
    const coord = createWriteCoordinator(null, SLOT_A, SHAPE)
    await coord.resolveSet([exercise('Bench press', 1)], 0, 0, effects)

    coord.reset(null, SLOT_A, SHAPE)       // query hasn't surfaced it
    expect(coord.workoutId()).toBe('w1')
    expect(calls.workouts).toBe(1)
  })

  it('never re-adopts a workout it has released', async () => {
    // Finish and Discard invalidate the workout, entry and set queries
    // independently, so an entry emission can rebuild `live` from a workout
    // row that still reads in-progress before the workout query publishes
    // `done`. Adopting that id again brought a logged session back to life —
    // Discard reappears for it, and later edits route into released blocks.
    const coord = createWriteCoordinator('w1', SLOT_A, SHAPE)
    coord.completed('w1')
    expect(coord.workoutId()).toBeNull()

    coord.reset('w1', SLOT_A, SHAPE)
    expect(coord.workoutId()).toBeNull()
  })

  it('refuses a released id on a slot switched away from and back', async () => {
    // The lag window is not confined to one slot: finish A, flip to B, flip
    // back before the workout query drops A's stale in-progress row, and the
    // slot-change branch was assigning it without consulting `released`.
    const coord = createWriteCoordinator('w1', SLOT_A, SHAPE)
    coord.completed('w1')
    coord.reset(null, SLOT_B, SHAPE)
    coord.reset('w1', SLOT_A, SHAPE)
    expect(coord.workoutId()).toBeNull()
  })

  it('does not let an empty session vouch for a different one', async () => {
    // Retiring every release on ANY authoritative absence let session B speak
    // for session A: finish A, flip to B (which is empty, and says so), flip
    // back before A's workout query publishes the done row, and A came back
    // with its Discard button and its set ids.
    const coord = createWriteCoordinator('w1', SLOT_A, SHAPE)
    coord.completed('w1')
    coord.reset(null, SLOT_B, SHAPE, true)   // B is empty — true of B, not of A
    coord.reset('w1', SLOT_A, SHAPE, true)   // …back to A, still lagging
    expect(coord.workoutId()).toBeNull()
  })

  it('retires a release once the slot shows a different workout', async () => {
    // W1 finished and W2 took its place with no empty result in between, so
    // the absence-triggered retirement never ran and W1 stayed blacklisted
    // forever — undoing its finish put the blocks back on screen with the
    // coordinator refusing to own them.
    const coord = createWriteCoordinator('w1', SLOT_A, SHAPE)
    coord.completed('w1')
    coord.reset('w2', SLOT_A, SHAPE)          // straight to the next workout
    expect(coord.workoutId()).toBe('w2')

    coord.reset('w1', SLOT_A, SHAPE)          // …and then w1 comes back
    expect(coord.workoutId()).toBe('w1')
  })

  it('adopts a released workout that turns up under a different slot', async () => {
    // Its date or session was edited, so it left the slot we were watching
    // and reappeared under another. That is a relocation, not a workout we
    // are done with — refusing it there left the blocks on screen with no
    // workout id behind them.
    const coord = createWriteCoordinator('w1', SLOT_A, SHAPE)
    coord.completed('w1')

    coord.reset('w1', SLOT_B, SHAPE)
    expect(coord.workoutId()).toBe('w1')
  })

  it('lets a released workout come back when the queries say it really did', async () => {
    // Undoing a discard restores the same blocks under the same id. Refusing
    // it for the coordinator's lifetime left Discard a no-op and Finish
    // permanently answering "session changed" until a remount — so a release
    // is retired once an authoritative absence confirms it.
    const coord = createWriteCoordinator('w1', SLOT_A, SHAPE)
    coord.abandon()
    coord.reset(null, SLOT_A, SHAPE, true)   // the queries confirm it is gone
    coord.reset('w1', SLOT_A, SHAPE, true)   // …and then undo brings it back
    expect(coord.workoutId()).toBe('w1')
  })

  it('still adopts a different workout for the same slot', async () => {
    // Releasing one id must not stop the NEXT session of the same type that
    // evening from being adopted — it lives at a different derived slot.
    const coord = createWriteCoordinator('w1', SLOT_A, SHAPE)
    coord.abandon()
    coord.reset('w2', SLOT_A, SHAPE)
    expect(coord.workoutId()).toBe('w2')
  })

  it('reports which of the three kinds of reseed this was', async () => {
    // The view acts on the transition — clearing a "Logged Session A"
    // confirmation belongs to a session switch and nothing else. It used to
    // work this out from its own mirrored copies of `slot` and `shape`.
    const coord = createWriteCoordinator(null, SLOT_A, SHAPE)
    expect(coord.reset(null, SLOT_A, SHAPE)).toEqual({slotChanged: false, shapeChanged: false})
    expect(coord.reset(null, SLOT_A, 'bench,landmine')).toEqual({slotChanged: false, shapeChanged: true})
    expect(coord.reset(null, SLOT_B, 'bench,landmine')).toEqual({slotChanged: true, shapeChanged: true})
  })
})

describe('failure and abandonment', () => {
  it('stops handing back a set block that a write says is gone', async () => {
    // The ids cached from our own create outlive the blocks they name. Left
    // in place, every retry named the same tombstone, the write answered
    // `gone` again, and the row could not be remade until a session or shape
    // change reset the cache.
    const {calls, effects} = instantEffects()
    const coord = createWriteCoordinator(null, SLOT_A, SHAPE)
    const draft = [exercise('Bench press', 2)]

    const first = await coord.resolveSet(draft, 0, 0, effects)
    expect(first.blockId).toBe('w1-e0s0')

    coord.forget('w1-e0s0')
    const retry = await coord.resolveSet(draft, 0, 0, effects)
    expect(retry.blockId).not.toBe('w1-e0s0')
    expect(calls.exercises).toEqual(['Bench press'])   // re-derived, not reused
  })

  it('stops handing it back out of a cached exercise create', async () => {
    // The cache holds a RESOLVED promise carrying the same ids, so a retry was
    // handed the dead one straight back out of it without ever consulting the
    // forgotten list — every write answered `gone` until a shape or session
    // change cleared the cache.
    const {calls, effects} = instantEffects()
    const coord = createWriteCoordinator('w1', SLOT_A, SHAPE)
    const draft = [exercise('Landmine press', 1, {defId: 'def-lm'})]

    const first = await coord.resolveSet(draft, 0, 0, effects)
    expect(first.blockId).toBe('w1-Landmine press-s0')

    coord.forget('w1-Landmine press-s0')
    await coord.resolveSet(draft, 0, 0, effects)
    expect(calls.exercises).toEqual(['Landmine press', 'Landmine press'])   // re-materialized
  })

  it('stops handing it back on the direct path too', async () => {
    // `persist` stamps the create's ids into the draft BEFORE the write runs,
    // so by the time one comes back `gone` the id we were told to forget is
    // sitting on the set itself — and the short path returned it without
    // asking, sending the retry straight back to the tombstone.
    const {calls, effects} = instantEffects()
    const coord = createWriteCoordinator('w1', SLOT_A, SHAPE)
    const draft = [exercise('Bench press', 1, {defId: 'def-bench'})]
    draft[0].blockId = 'e1'
    draft[0].sets[0].blockId = 'dead-set'

    coord.forget('dead-set')
    const retry = await coord.resolveSet(draft, 0, 0, effects)

    expect(retry.blockId).not.toBe('dead-set')
    expect(calls.exercises).toEqual(['Bench press'])
  })

  it('retries after a failed create instead of caching the rejection forever', async () => {
    let attempts = 0
    const effects: WriteEffects = {
      createWorkout: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('tx conflict')
        return workoutIds('w1', [1])
      },
      createExercise: async () => ({id: 'x', setIds: ['xs']}),
    }
    const coord = createWriteCoordinator(null, SLOT_A, SHAPE)
    const draft = [exercise('Bench press', 1)]

    await expect(coord.resolveSet(draft, 0, 0, effects)).rejects.toThrow('tx conflict')
    // Before: every later tap awaited the same rejected promise, so the user
    // logged a whole session that was written nowhere.
    expect(await coord.resolveSet(draft, 0, 0, effects)).toMatchObject({blockId: 'w1-e0s0'})
    expect(attempts).toBe(2)
  })

  it('retries a failed exercise create too', async () => {
    let attempts = 0
    const effects: WriteEffects = {
      createWorkout: async () => workoutIds('w1', [1]),
      createExercise: async (_workoutId, ex) => {
        attempts += 1
        if (attempts === 1) throw new Error('parent deleted')
        return {id: 'e-new', setIds: ex.sets.map((_, j) => `e-new-s${j}`)}
      },
    }
    const coord = createWriteCoordinator('w1', SLOT_A, SHAPE)
    const draft = [exercise('Landmine press', 1, {defId: 'def-lm'})]

    await expect(coord.resolveSet(draft, 0, 0, effects)).rejects.toThrow('parent deleted')
    expect(await coord.resolveSet(draft, 0, 0, effects)).toMatchObject({blockId: 'e-new-s0'})
  })

  it('does not cancel another session\'s pending write when this one finishes', async () => {
    // A tap on A whose create is still in flight, then a switch to B, then
    // Finish on B. A global "everything older is cancelled" cutoff made A's
    // resolver yield no block — and `persist` reads no-block as
    // nothing-to-do, so the tap was lost with no error at all. Only the
    // released session's own work is cancelled.
    const gate = deferred<MaterializedWorkout>()
    const effects: WriteEffects = {
      createWorkout: () => gate.promise,
      createExercise: async () => ({id: 'x', setIds: ['xs']}),
    }
    const coord = createWriteCoordinator(null, SLOT_A, SHAPE)

    const pending = coord.resolveSet([exercise('Bench press', 1)], 0, 0, effects)
    coord.reset('w-b', SLOT_B, SHAPE)   // the user switches to session B…
    coord.completed('w-b')                    // …and finishes THAT one
    gate.resolve(workoutIds('w-a', [1]))

    expect((await pending).blockId).toBe('w-a-e0s0')
  })

  it('still cancels a create that started before a discard on the same session', async () => {
    // The other direction, which the global cutoff did get right: an
    // `or`-group switch bumps the generation WITHIN one workout, so a discard
    // has to cancel a create that started before it — those blocks are about
    // to be tombstoned.
    const gate = deferred<ExerciseEntryIdsForTest>()
    const effects: WriteEffects = {
      createWorkout: async () => workoutIds('w1', [1]),
      createExercise: () => gate.promise,
    }
    const coord = createWriteCoordinator('w1', SLOT_A, SHAPE)

    const pending = coord.resolveSet([exercise('Landmine press', 1, {defId: 'def-lm'})], 0, 0, effects)
    coord.reset('w1', SLOT_A, 'bench,landmine')   // shape change: new generation
    coord.abandon()
    gate.resolve({id: 'e-late', setIds: ['e-late-s0']})

    expect(await pending).toEqual({})
  })

  it('un-cancels the pending write when the discard is taken back', async () => {
    // A discard cancels the work in flight for its slot, which is right while
    // the delete is happening — but the delete can fail, and then the workout
    // is still there. Handing it back without lifting the cancellation left
    // the create resolving to no block at all, which `persist` reads as
    // nothing-to-do: the set edit vanished with no error.
    const gate = deferred<ExerciseEntryIdsForTest>()
    const effects: WriteEffects = {
      createWorkout: async () => workoutIds('w1', [1]),
      createExercise: () => gate.promise,
    }
    const coord = createWriteCoordinator('w1', SLOT_A, SHAPE)

    const pending = coord.resolveSet([exercise('Landmine press', 1, {defId: 'def-lm'})], 0, 0, effects)
    coord.abandon()
    coord.restore('w1')                       // …the delete failed
    gate.resolve({id: 'e-lm', setIds: ['e-lm-s0']})

    expect((await pending).blockId).toBe('e-lm-s0')
  })

  it('yields no block once the workout is discarded, so a late create writes nothing', async () => {
    // Those blocks are children of a workout being tombstoned; writing into
    // them would strand live todo sets under a deleted parent.
    const gate = deferred<ExerciseEntryIdsForTest>()
    const effects: WriteEffects = {
      createWorkout: async () => workoutIds('w1', [1]),
      createExercise: () => gate.promise,
    }
    const coord = createWriteCoordinator('w1', SLOT_A, SHAPE)

    const pending = coord.resolveSet([exercise('Landmine press', 1, {defId: 'def-lm'})], 0, 0, effects)
    coord.abandon()
    gate.resolve({id: 'e-late', setIds: ['e-late-s0']})

    expect(await pending).toEqual({})
  })
})

describe('applyIdPatch', () => {
  it('stamps a whole workout into the draft', () => {
    const draft = [exercise('Bench press', 2), exercise('Row', 1)]
    const patched = applyIdPatch(draft, {kind: 'workout', workout: workoutIds('w1', [2, 1])})
    expect(patched.map(ex => ex.blockId)).toEqual(['w1-e0', 'w1-e1'])
    expect(patched[0].sets.map(s => s.blockId)).toEqual(['w1-e0s0', 'w1-e0s1'])
  })

  it('stamps one exercise without touching its neighbours', () => {
    const draft = [exercise('Bench press', 1), exercise('Landmine press', 1)]
    const patched = applyIdPatch(draft, {
      kind: 'exercise', exIdx: 1, entry: {id: 'e-new', setIds: ['s-new']},
    })
    expect(patched[0].blockId).toBeUndefined()
    expect(patched[1]).toMatchObject({blockId: 'e-new'})
    expect(patched[1].sets[0].blockId).toBe('s-new')
  })

  it('never overwrites an id the draft already has', () => {
    // A live query landing first is authoritative; a late create must not
    // repoint an edited set at a block nobody has been writing to.
    const draft = [exercise('Bench press', 1)]
    draft[0].blockId = 'from-live'
    draft[0].sets[0].blockId = 'set-from-live'
    const patched = applyIdPatch(draft, {kind: 'workout', workout: workoutIds('w1', [1])})
    expect(patched[0].blockId).toBe('from-live')
    expect(patched[0].sets[0].blockId).toBe('set-from-live')
  })
})
