/** `store.ts` against a REAL `Repo` over a real `@powersync/node` database.
 *
 *  Everything in `store.ts` is written and re-checked against the COMMITTED
 *  tree on purpose — `finishWorkout` re-reads inside its own transaction,
 *  `startWorkout`/`materializeExercise` adopt existing blocks by derived id,
 *  `writeSet` patches over whatever the block holds right now. None of that
 *  is exercisable against fakes: the whole point is real mutators, a real
 *  type registry, and read-your-own-writes semantics inside a real
 *  transaction. `test/store.test.ts` covers the pure decision/read functions
 *  (`finishPlan`, `buildHistory`, …) against hand-built rows; this file
 *  covers the WRITE wiring that decides which rows exist in the first place.
 *
 *  Runs under `vitest.integration.config.ts`, which points `@/` at the real
 *  app sources instead of the kernel-type stubs — see that file's docblock.
 */

import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'

import {ChangeScope} from '@/data/api'
import type {BlockData} from '@/data/api'
import type {BlockCache} from '@/data/blockCache'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo, isBlockDeleted} from '@/data/test/createTestRepo'
import {definitionSeedsFacet, typeSeedsFacet} from '@/data/facets'
import {hasBlockType, typesProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {statusProp as todoStatusProp, todoType} from '@/plugins/todo/schema'

import {toLiveSet, buildLiveWorkouts} from '../../src/km/history'
import {dayToDate} from '../../src/km/day'
import {EXERCISE_ENTRY_TYPE, SET_TYPE} from '../../src/km/fields'
import {
  STRENGTH_PROPS,
  STRENGTH_TYPES,
  completedAtProp,
  dateProp,
  definitionProp,
  repsProp,
  rpeProp,
  sessionProp,
  setIndexProp,
  statusProp,
  weightProp,
  workingWeightProp,
} from '../../src/km/schema'
import {
  finishWorkout,
  materializeExercise,
  startWorkout,
  writeSet,
  type ExerciseDraft,
  type SetDraft,
  type WorkoutDraft,
} from '../../src/km/store'

const WORKSPACE_ID = 'ws-1'
const PAGE_ID = 'strength-log-page'

let sharedDb: TestDb
let repo: Repo
let cache: BlockCache

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  // Same registration `src/index.ts` does for the real app — every strength
  // prop/type, plus the todo plugin's `status`, since a logged set composes
  // with the built-in todo (see store.ts's own comment on `writeSetBlock`).
  const created = createTestRepo({
    db: sharedDb.db,
    user: {id: 'lifter'},
    extensions: [
      ...STRENGTH_PROPS.map(prop => definitionSeedsFacet.of(prop, {source: 'test'})),
      ...STRENGTH_TYPES.map(type => typeSeedsFacet.of(type, {source: 'test'})),
      definitionSeedsFacet.of(todoStatusProp, {source: 'test'}),
      typeSeedsFacet.of(todoType, {source: 'test'}),
    ],
  })
  repo = created.repo
  cache = created.cache
  repo.setActiveWorkspaceId(WORKSPACE_ID)
  await repo.tx(async tx => {
    await tx.create({id: PAGE_ID, workspaceId: WORKSPACE_ID, parentId: null, orderKey: 'a0', content: 'Strength Log'})
  }, {scope: ChangeScope.BlockDefault, description: 'seed page'})
})

// ──── draft builders ────

const draftSet = (weight: number, reps: number, over: Partial<SetDraft> = {}): SetDraft =>
  ({weight, reps, done: false, ...over})

const exerciseDraft = (exercise: string, sets: SetDraft[], over: Partial<ExerciseDraft> = {}): ExerciseDraft =>
  ({exercise, occurrence: 0, unit: 'lb', sets, ...over})

const workoutDraft = (exercises: ExerciseDraft[], over: Partial<WorkoutDraft> = {}): WorkoutDraft =>
  ({day: '2026-07-24', session: 'A', exercises, ...over})

// ──── tree readers (the display-visible view — same as `readAltChoices`) ────

const liveChildren = async (parentId: string, typeId: string): Promise<BlockData[]> =>
  ((await repo.block(parentId).children.load()) ?? []).filter(row => hasBlockType(row, typeId))

describe('finishWorkout — assembling and pruning the committed tree', () => {
  it('keeps accepted sets with a stamped working weight, prunes un-accepted sets and empty entries, and flips the workout done', async () => {
    // One exercise with a real accepted set (kept, pruned down to just that
    // set, working weight stamped) and one exercise nobody logged into at all
    // (removed wholesale) — in the SAME finish, so a bug that reads the wrong
    // list for either deletion loop (un-accepted sets vs. empty entries) or
    // the wrong done-ness field shows up as a wrong answer on ONE side while
    // the other looks right, rather than being invisible.
    const workout = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, workoutDraft([
      exerciseDraft('Bench press', [draftSet(135, 8), draftSet(135, 8)]),
      exerciseDraft('Curl', [draftSet(30, 10), draftSet(30, 10)], {occurrence: 1}),
    ]))
    const bench = workout.exercises[0]
    const curl = workout.exercises[1]

    // Only the first bench set gets accepted, at a different weight than
    // prescribed — so "working weight" has to come from what was actually
    // logged, not from the prescription still sitting on the other sets.
    expect(await writeSet(repo, bench.setIds[0], {weight: 140, reps: 8, done: true}, 'lb')).toBe('written')

    await finishWorkout(repo, workout.workoutId)

    expect(repo.block(workout.workoutId).peekProperty(statusProp)).toBe('done')

    // Bench: kept, working weight stamped from the one accepted set, the
    // un-accepted sibling set actually gone.
    expect(await isBlockDeleted(repo, bench.id)).toBe(false)
    expect(repo.block(bench.id).peekProperty(workingWeightProp)).toBe(140)
    expect(await isBlockDeleted(repo, bench.setIds[0])).toBe(false)
    expect(await isBlockDeleted(repo, bench.setIds[1])).toBe(true)

    // Curl: nothing was accepted, so the whole entry is gone — not just left
    // behind as an empty shell, and not treated as "kept" by whichever list
    // drives the entry-deletion loop.
    expect(await isBlockDeleted(repo, curl.id)).toBe(true)
  })

  it('does not sweep up a non-set child of an exercise entry', async () => {
    // A note typed under a lift ("left shoulder felt tight") is a normal
    // block, not a `strength-set`. Without the SET_TYPE filter on
    // `tx.childrenOf(entry.id)`, `toLiveSet` reads it as a set with no
    // properties — weight 0, reps 0, un-accepted — and Finish's own pruning
    // then deletes the user's note as an "un-accepted set".
    const workout = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, workoutDraft([
      exerciseDraft('Bench press', [draftSet(135, 8)]),
    ]))
    const bench = workout.exercises[0]
    expect(await writeSet(repo, bench.setIds[0], {weight: 145, reps: 5, done: true}, 'lb')).toBe('written')

    await repo.tx(async tx => {
      await tx.create({
        id: 'shoulder-note', workspaceId: WORKSPACE_ID, parentId: bench.id, orderKey: 'z0',
        content: 'left shoulder felt tight',
      })
    }, {scope: ChangeScope.BlockDefault, description: 'user note under the lift'})

    await finishWorkout(repo, workout.workoutId)

    expect(await isBlockDeleted(repo, 'shoulder-note')).toBe(false)
    // And the real accepted set + its working weight are unaffected by the
    // note sharing its parent.
    expect(await isBlockDeleted(repo, bench.setIds[0])).toBe(false)
    expect(repo.block(bench.id).peekProperty(workingWeightProp)).toBe(145)
  })

  it('empties rather than deletes an entry that holds something other than sets', async () => {
    // "Nothing was accepted here" is read off the SET type tag, and a tag can
    // go missing — the same misread the workout-level guard refuses one level
    // up. Down here the entry is subtree-deleted, which takes the user's own
    // note (and any set whose tag went with it) permanently. Leaving the entry
    // costs an empty row in the record; removing it is unrecoverable.
    const workout = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, workoutDraft([
      exerciseDraft('Bench press', [draftSet(135, 8)]),                     // nothing accepted
      exerciseDraft('Row', [draftSet(95, 10)], {occurrence: 1}),            // the session's real work
    ]))
    const [bench, row] = workout.exercises
    expect(await writeSet(repo, row.setIds[0], {weight: 95, reps: 10, done: true}, 'lb')).toBe('written')
    await repo.tx(async tx => {
      await tx.create({
        id: 'why-i-skipped', workspaceId: WORKSPACE_ID, parentId: bench.id, orderKey: 'z0',
        content: 'shoulder was not having it',
      })
    }, {scope: ChangeScope.BlockDefault, description: 'a note under the lift I skipped'})

    await finishWorkout(repo, workout.workoutId)

    expect(await isBlockDeleted(repo, 'why-i-skipped')).toBe(false)
    expect(await isBlockDeleted(repo, bench.id)).toBe(false)
    // Its un-accepted set still goes — that part was never in doubt.
    expect(await isBlockDeleted(repo, bench.setIds[0])).toBe(true)
    // …and the rest of the finish is unaffected.
    expect(repo.block(row.id).peekProperty(workingWeightProp)).toBe(95)
    expect(repo.block(workout.workoutId).peekProperty(statusProp)).toBe('done')
  })

  it('refuses to finish when only SOME entries lost their type tag', async () => {
    // The dangerous misread is the partial one: `entries` is still non-empty,
    // so the all-missing guard never fires, and Finish marks the workout done
    // having processed only the still-typed lifts. The untyped one and its
    // open todo sets stay behind — absent from the record, stranded in the
    // agenda. Only the whole session is worth deciding about.
    const workout = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, workoutDraft([
      exerciseDraft('Bench press', [draftSet(135, 8)]),
      exerciseDraft('Row', [draftSet(95, 10)], {occurrence: 1}),
    ]))
    const [bench, row] = workout.exercises
    expect(await writeSet(repo, bench.setIds[0], {weight: 185, reps: 5, done: true}, 'lb')).toBe('written')
    await repo.tx(tx => tx.setProperty(row.id, typesProp, []),
      {scope: ChangeScope.BlockDefault, description: 'lose the entry type tag'})

    await expect(finishWorkout(repo, workout.workoutId)).rejects.toThrow(/refusing to finish/)

    // Refusing has to mean refusing.
    expect(repo.block(workout.workoutId).peekProperty(statusProp)).toBe('in-progress')
    expect(await isBlockDeleted(repo, row.setIds[0])).toBe(false)
    expect(await isBlockDeleted(repo, bench.setIds[0])).toBe(false)
  })

  it('refuses to finish when a workout has children but none of them are exercise entries', async () => {
    // Children-but-no-entries reads as a type misread, not an empty session
    // — see the guard's own comment in store.ts. A block directly under the
    // workout (never materialized into an exercise entry) is the real shape
    // that trips it.
    const workout = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, workoutDraft([]))
    await repo.tx(async tx => {
      await tx.create({
        id: 'stray-note', workspaceId: WORKSPACE_ID, parentId: workout.workoutId, orderKey: 'z0',
        content: 'forgot to log via the picker, will backfill',
      })
    }, {scope: ChangeScope.BlockDefault, description: 'stray note directly under the workout'})

    await expect(finishWorkout(repo, workout.workoutId)).rejects.toThrow(/refusing to finish/)

    // Refusing has to mean refusing — nothing pruned, workout still live.
    expect(repo.block(workout.workoutId).peekProperty(statusProp)).toBe('in-progress')
    expect(await isBlockDeleted(repo, 'stray-note')).toBe(false)
  })
})

describe('writeSet — gone vs. written', () => {
  it('answers "gone" for a set id that never existed, without creating anything', async () => {
    expect(await writeSet(repo, 'never-existed', {weight: 100}, 'lb')).toBe('gone')
  })

  it('answers "gone" for a set that was deleted out from under the draft, and does not resurrect it', async () => {
    const workout = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, workoutDraft([
      exerciseDraft('Bench press', [draftSet(135, 8)]),
    ]))
    const setId = workout.exercises[0].setIds[0]
    await repo.tx(tx => tx.delete(setId), {scope: ChangeScope.BlockDefault, description: 'simulate a Finish pruning the set'})

    expect(await writeSet(repo, setId, {weight: 999}, 'lb')).toBe('gone')
    expect(await isBlockDeleted(repo, setId)).toBe(true)
  })

  it('answers "gone" for a set that lost its type tag, rather than reporting a phantom write', async () => {
    // `finishWorkout` only scans TYPED set children, so an untyped block is
    // one the finished record will not contain. Writing into it and saying
    // "written" puts a tick on screen for a set that will not survive the
    // session. Saying `gone` sends the caller back through the create path,
    // where the derived id finds this very block and re-tags it.
    const workout = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, workoutDraft([
      exerciseDraft('Bench press', [draftSet(135, 8)]),
    ]))
    const setId = workout.exercises[0].setIds[0]
    await repo.tx(tx => tx.setProperty(setId, typesProp, []),
      {scope: ChangeScope.BlockDefault, description: 'lose the set type tag'})

    expect(await writeSet(repo, setId, {weight: 999}, 'lb')).toBe('gone')
    expect(repo.block(setId).peekProperty(weightProp)).toBe(135)  // untouched
  })

  it('answers "gone" for a set dragged out from under its lift', async () => {
    const workout = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, workoutDraft([
      exerciseDraft('Bench press', [draftSet(135, 8)]),
    ]))
    const entryId = workout.exercises[0].id
    const setId = workout.exercises[0].setIds[0]
    await repo.tx(tx => tx.move(setId, {parentId: PAGE_ID, orderKey: 'z0'}),
      {scope: ChangeScope.BlockDefault, description: 'drag the set out of its lift'})

    expect(await writeSet(repo, setId, {weight: 999}, 'lb', entryId)).toBe('gone')
    expect(repo.block(setId).peekProperty(weightProp)).toBe(135)
  })

  it('answers "written" for a live set and actually applies the patch', async () => {
    const workout = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, workoutDraft([
      exerciseDraft('Bench press', [draftSet(135, 8)]),
    ]))
    const setId = workout.exercises[0].setIds[0]

    expect(await writeSet(repo, setId, {weight: 140}, 'lb')).toBe('written')
    expect(repo.block(setId).peekProperty(weightProp)).toBe(140)
  })
})

describe('writeSet — patch semantics', () => {
  it('writes only the fields present in the patch, leaves the rest alone, and keeps content in sync with the merge', async () => {
    // A whole-set replace (rather than a merge over `before`) was the exact
    // bug this guards against: a tap that only meant to bump the weight blew
    // away rpe/completedAt the caller's draft didn't happen to be holding.
    const workout = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, workoutDraft([
      exerciseDraft('Bench press', [draftSet(135, 8, {rpe: 7, completedAt: 1_000})]),
    ]))
    const setId = workout.exercises[0].setIds[0]

    expect(await writeSet(repo, setId, {weight: 145}, 'lb')).toBe('written')

    expect(repo.block(setId).peekProperty(weightProp)).toBe(145)
    expect(repo.block(setId).peekProperty(repsProp)).toBe(8) // untouched
    expect(repo.block(setId).peekProperty(rpeProp)).toBe(7) // untouched
    expect(repo.block(setId).peekProperty(completedAtProp)).toBe(1_000) // untouched — omitted, not cleared
    expect(repo.block(setId).peekProperty(todoStatusProp)).toBe('open') // done-ness untouched
    // Content reads the MERGED result (145 × 8), not the draft's stale 135.
    expect(cache.getSnapshot(setId)?.content).toBe('145lb × 8')
  })

  it('clears completedAt when the patch carries the key with an undefined value', async () => {
    // `completedAt: undefined` inside the patch means "explicitly un-done,
    // clear it" — distinguishable from "the caller didn't mention it" (the
    // previous test) only by the key's presence, which is exactly what a
    // whole-object `{...current, ...patch}` spread preserves and what an
    // `unset` step keyed on plain `!== undefined` would get wrong.
    const workout = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, workoutDraft([
      exerciseDraft('Bench press', [draftSet(135, 8, {completedAt: 1_000})]),
    ]))
    const setId = workout.exercises[0].setIds[0]

    expect(await writeSet(repo, setId, {completedAt: undefined}, 'lb')).toBe('written')

    expect(repo.block(setId).peekProperty(completedAtProp)).toBeUndefined()
    expect(repo.block(setId).peekProperty(weightProp)).toBe(135) // untouched
  })
})

describe('side round-trips and feeds finishPlan\'s working weight', () => {
  it('a single-arm set\'s side survives the write → buildLiveWorkouts/toLiveSet read, and finishWorkout stamps the LEFT side\'s weight', async () => {
    // The plan's asymmetry rule is "left sets the reps, right matches", so
    // `progressionSets` (engine/progression.ts) keeps only the left side's
    // sets for progression. If `side` is dropped anywhere between the block
    // and `finishPlan`'s input, every set reads as side-agnostic and the
    // modal-weight tiebreak picks the HEAVIER (right) side instead — a
    // waiter carry logged L=35/R=45 would stamp 45, silently progressing the
    // strong arm and leaving the weak one behind.
    const workout = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, workoutDraft([
      exerciseDraft('Waiter carry', [draftSet(0, 0, {side: 'L'}), draftSet(0, 0, {side: 'R'})]),
    ]))
    const carry = workout.exercises[0]
    const [leftId, rightId] = carry.setIds

    expect(await writeSet(repo, leftId, {weight: 35, reps: 8, side: 'L', done: true, completedAt: 111}, 'lb'))
      .toBe('written')
    expect(await writeSet(repo, rightId, {weight: 45, reps: 8, side: 'R', done: true, completedAt: 222}, 'lb'))
      .toBe('written')

    // Read back through the exact path the live logging UI uses.
    const workoutRow = cache.getSnapshot(workout.workoutId)!
    const entryRows = await liveChildren(workout.workoutId, EXERCISE_ENTRY_TYPE)
    const setRows = await liveChildren(carry.id, SET_TYPE)
    const live = buildLiveWorkouts([workoutRow], entryRows, setRows)

    const liveLeft = live[0].exercises[0].sets.find(s => s.id === leftId)
    const liveRight = live[0].exercises[0].sets.find(s => s.id === rightId)
    expect(liveLeft).toMatchObject({side: 'L', completedAt: 111, weight: 35})
    expect(liveRight).toMatchObject({side: 'R', completedAt: 222, weight: 45})
    // `toLiveSet` directly, on the raw row — the one decoder both the write
    // side (writeSet's merge) and the read side share.
    expect(toLiveSet(setRows.find(r => r.id === leftId)!)).toMatchObject({side: 'L', completedAt: 111})

    await finishWorkout(repo, workout.workoutId)

    expect(repo.block(carry.id).peekProperty(workingWeightProp)).toBe(35)
  })
})

describe('startWorkout — idempotent and adopting', () => {
  it('called twice for the same workspace/day/session returns the same ids and does not overwrite logged values', async () => {
    const draft = workoutDraft([exerciseDraft('Bench press', [draftSet(135, 8), draftSet(135, 8)])])

    const first = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, draft)
    // Simulate real logging happening between the two calls (e.g. a second
    // tab re-materializing the same session mid-workout).
    expect(await writeSet(repo, first.exercises[0].setIds[0], {weight: 185, reps: 5, done: true}, 'lb'))
      .toBe('written')

    const second = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, draft)

    expect(second.workoutId).toBe(first.workoutId)
    expect(second.exercises[0].id).toBe(first.exercises[0].id)
    expect(second.exercises[0].setIds).toEqual(first.exercises[0].setIds)
    // The re-run's prescribed 135/8 must NOT have clobbered the logged 185/5.
    expect(repo.block(first.exercises[0].setIds[0]).peekProperty(weightProp)).toBe(185)
  })

  it('writes into the entries an adopted workout already has, not a parallel set', async () => {
    // Adopting happens before the live query resolves, so the caller cannot
    // have matched anything yet. The session was logged while the outline was
    // unreadable — name-keyed entries — and now the draft carries plan blocks,
    // which derive DIFFERENT entry ids. Deriving regardless split the lift
    // across two entries and scattered the sets.
    const unplanned = workoutDraft([exerciseDraft('Bench press', [draftSet(135, 8)])])
    const first = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, unplanned)
    expect(await writeSet(repo, first.exercises[0].setIds[0], {weight: 185, reps: 5, done: true}, 'lb'))
      .toBe('written')

    const planned = workoutDraft([
      exerciseDraft('Bench press', [draftSet(135, 8)], {definitionId: 'def-bench'}),
    ])
    const second = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, planned)

    expect(second.workoutId).toBe(first.workoutId)
    expect(second.exercises[0].id).toBe(first.exercises[0].id)
    expect(await liveChildren(first.workoutId, EXERCISE_ENTRY_TYPE)).toHaveLength(1)
    // …and the set logged into it is untouched by the re-run's prescription.
    expect(repo.block(first.exercises[0].setIds[0]).peekProperty(weightProp)).toBe(185)
  })

  it('repairs a set index that disagrees with the slot its block id came from', async () => {
    // `strength:setIndex` is an ordinary hand-editable property, and the read
    // path now trusts it to place the set. One that disagrees with the
    // derivation would show the set in another row's slot, or nowhere, while
    // every write still resolved to this block. The derivation is the
    // authority; the property is its readable copy, so adopting repairs it.
    const draft = workoutDraft([exerciseDraft('Bench press', [draftSet(135, 8), draftSet(135, 8)])])
    const started = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, draft)
    const secondSet = started.exercises[0].setIds[1]
    await repo.tx(tx => tx.setProperty(secondSet, setIndexProp, 7),
      {scope: ChangeScope.BlockDefault, description: 'hand-edit the index'})

    await startWorkout(repo, WORKSPACE_ID, PAGE_ID, draft)

    expect(repo.block(secondSet).peekProperty(setIndexProp)).toBe(1)
  })

  it('does not adopt a workout whose date was edited to another day', async () => {
    // The id derives from workspace|day|session, but the stored date is an
    // ordinary property and can be hand-edited in the outline. Once it names a
    // different day, `buildLiveWorkouts` files the workout under THAT day —
    // so adopting it would log tonight's sets into a block this view can never
    // render, and Finish would wait forever for a live id that never matches.
    const draft = workoutDraft([exerciseDraft('Bench press', [draftSet(135, 8)])])
    const first = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, draft)
    await repo.tx(tx => tx.setProperty(first.workoutId, dateProp, dayToDate('2026-07-01')),
      {scope: ChangeScope.BlockDefault, description: 'hand-edit the date'})

    const second = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, draft)

    expect(second.workoutId).not.toBe(first.workoutId)
    expect(repo.block(second.workoutId).peekProperty(dateProp)).toEqual(dayToDate('2026-07-24'))
  })

  it('does not adopt a workout whose session no longer matches', async () => {
    const draft = workoutDraft([exerciseDraft('Bench press', [draftSet(135, 8)])])
    const first = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, draft)
    await repo.tx(tx => tx.setProperty(first.workoutId, sessionProp, 'B'),
      {scope: ChangeScope.BlockDefault, description: 'hand-edit the session'})

    const second = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, draft)

    expect(second.workoutId).not.toBe(first.workoutId)
    expect(repo.block(second.workoutId).peekProperty(sessionProp)).toBe('A')
  })

  it('does not adopt a workout already marked done — a second "start" that day takes the next slot', async () => {
    const draft = workoutDraft([exerciseDraft('Bench press', [draftSet(135, 8)])])

    const first = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, draft)
    await finishWorkout(repo, first.workoutId)

    const second = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, draft)

    expect(second.workoutId).not.toBe(first.workoutId)
    expect(repo.block(first.workoutId).peekProperty(statusProp)).toBe('done')
    expect(repo.block(second.workoutId).peekProperty(statusProp)).toBe('in-progress')
  })
})

describe('materializeExercise — explicit entryId', () => {
  it('writes new sets under the GIVEN entry instead of deriving (and creating) a second one', async () => {
    // The scenario the `entryId` param exists for: an entry logged while the
    // plan outline was unreadable is keyed on the lift's NAME (no
    // `definitionId`); once the plan resolves, the row now carries a
    // `definitionId` that would derive a DIFFERENT block id if re-derived —
    // splitting one lift into two entries. The caller passes the entry it's
    // already attached to instead.
    const started = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, workoutDraft([
      exerciseDraft('Bench press', [draftSet(135, 8)]), // no definitionId yet — one set logged
    ]))
    const entryId = started.exercises[0].id
    const originalSetId = started.exercises[0].setIds[0]

    // The plan resolves: the draft now carries a definitionId (which would
    // derive a DIFFERENT entry if re-derived) and a second, not-yet-existing
    // set. Position 0 is the block already logged into — adopting it must
    // leave it alone; position 1 is genuinely new.
    const resolved = exerciseDraft('Bench press', [draftSet(135, 8), draftSet(145, 5)], {definitionId: 'def-bench-123'})
    const result = await materializeExercise(repo, started.workoutId, resolved, entryId)

    expect(result.id).toBe(entryId)
    expect(result.setIds[0]).toBe(originalSetId) // adopted, not re-derived
    expect(result.setIds[1]).not.toBe(originalSetId)

    const entries = await liveChildren(started.workoutId, EXERCISE_ENTRY_TYPE)
    expect(entries.map(e => e.id)).toEqual([entryId]) // still exactly one entry — no split

    expect(cache.getSnapshot(result.setIds[1])?.parentId).toBe(entryId)
    expect(repo.block(result.setIds[1]).peekProperty(weightProp)).toBe(145)
  })

  it('gives a deleted middle set a fresh block instead of handing back its neighbour', async () => {
    // Set blocks are derived from their INDEX inside the lift, so deleting one
    // from the middle leaves a hole, not a shift. Filling that row in again
    // must not resolve to the block at the neighbouring index — two draft rows
    // pointing at one block means the second one's edit overwrites the set the
    // first one logged. (The overlay's half of this is `overlayLive` matching
    // sets by id rather than by position in the compacted live list.)
    const started = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, workoutDraft([
      exerciseDraft('Bench press', [draftSet(135, 8), draftSet(135, 8), draftSet(135, 8)]),
    ]))
    const entryId = started.exercises[0].id
    const [first, middle, last] = started.exercises[0].setIds
    expect(await writeSet(repo, first, {weight: 185, reps: 5, done: true}, 'lb')).toBe('written')
    expect(await writeSet(repo, last, {weight: 195, reps: 3, done: true}, 'lb')).toBe('written')
    await repo.tx(tx => tx.delete(middle), {scope: ChangeScope.BlockDefault, description: 'delete the middle set'})

    const refilled = await materializeExercise(
      repo,
      started.workoutId,
      exerciseDraft('Bench press', [draftSet(135, 8), draftSet(135, 8), draftSet(135, 8)]),
      entryId,
    )

    expect(new Set(refilled.setIds).size).toBe(3)
    expect(refilled.setIds[0]).toBe(first)
    expect(refilled.setIds[2]).toBe(last)
    expect(refilled.setIds[1]).not.toBe(middle)   // the tombstone is not reused
    // …and the two real sets keep what was logged in them.
    expect(repo.block(first).peekProperty(weightProp)).toBe(185)
    expect(repo.block(last).peekProperty(weightProp)).toBe(195)
    // Each block SAYS which set it is, which is the only thing that survives
    // a reload — after one, nothing on screen remembers where these sat, and
    // the compacted child list reads as two sets rather than sets 0 and 2.
    expect(refilled.setIds.map(id => repo.block(id).peekProperty(setIndexProp))).toEqual([0, 1, 2])

    // …and the reader gets that number off the block rather than counting.
    // It has to: the replacement block is appended, so the children come back
    // in order 0, 2, 1 — a reader taking position for index would hand set 2's
    // block to the row that means set 1, which is the whole bug. Asserted as a
    // MAP for that reason; the sequence is deliberately not [0, 1, 2].
    const live = buildLiveWorkouts(
      [cache.getSnapshot(started.workoutId)!],
      await liveChildren(started.workoutId, EXERCISE_ENTRY_TYPE),
      await liveChildren(entryId, SET_TYPE),
    )
    expect(new Map(live[0].exercises[0].sets.map(s => [s.id, s.index]))).toEqual(new Map([
      [first, 0], [refilled.setIds[1], 1], [last, 2],
    ]))
  })

  it('ignores an attached entry that is no longer in this workout', async () => {
    // The entry can be dragged out of the session (or deleted) after the
    // snapshot the caller is holding. Writing sets under it anyway puts them
    // where `finishWorkout` — which scans the workout's children — never looks,
    // so the tap silently leaves the session. Deriving instead puts them back
    // where the workout can see them.
    const started = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, workoutDraft([
      exerciseDraft('Bench press', [draftSet(135, 8)]),
    ]))
    const strayEntryId = started.exercises[0].id
    await repo.tx(tx => tx.move(strayEntryId, {parentId: PAGE_ID, orderKey: 'z0'}),
      {scope: ChangeScope.BlockDefault, description: 'drag the lift out of the workout'})

    const refilled = await materializeExercise(
      repo,
      started.workoutId,
      exerciseDraft('Bench press', [draftSet(135, 8)]),
      strayEntryId,
    )

    expect(refilled.id).not.toBe(strayEntryId)
    expect(cache.getSnapshot(refilled.id)?.parentId).toBe(started.workoutId)
    expect(cache.getSnapshot(refilled.setIds[0])?.parentId).toBe(refilled.id)
  })

  it('re-tags an attached entry whose type tag went missing', async () => {
    // The shortcut accepts an entry on liveness and parentage alone, skipping
    // the re-tag `getOrCreateTypedChild` does for what it adopts. Left
    // untagged, the typed query drops it, Finish then refuses the session
    // because an untyped workout child owns sets, and a later materialization
    // derives a parallel entry beside it.
    const started = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, workoutDraft([
      exerciseDraft('Bench press', [draftSet(135, 8)]),
    ]))
    const entryId = started.exercises[0].id
    await repo.tx(tx => tx.setProperty(entryId, typesProp, []),
      {scope: ChangeScope.BlockDefault, description: 'lose the type tag'})

    await materializeExercise(
      repo,
      started.workoutId,
      exerciseDraft('Bench press', [draftSet(135, 8), draftSet(145, 5)]),
      entryId,
    )

    expect(hasBlockType(cache.getSnapshot(entryId)!, EXERCISE_ENTRY_TYPE)).toBe(true)
    // …and the session it belongs to is finishable again.
    expect(await liveChildren(started.workoutId, EXERCISE_ENTRY_TYPE)).toHaveLength(1)
  })

  it('backfills the plan-block ref onto an entry that was logged without one', async () => {
    // `strength:definition` is an optional-ref, so it projects a real
    // reference: a definition block's backlinks are that lift's whole logged
    // history. An entry written before the outline resolved has none, and
    // adopting it without filling that in drops the session out of those
    // backlinks permanently.
    const started = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, workoutDraft([
      exerciseDraft('Bench press', [draftSet(135, 8)]),
    ]))
    const entryId = started.exercises[0].id
    expect(repo.block(entryId).peekProperty(definitionProp)).toBeUndefined()

    await materializeExercise(
      repo,
      started.workoutId,
      exerciseDraft('Bench press', [draftSet(135, 8), draftSet(145, 5)], {definitionId: 'def-bench-123'}),
      entryId,
    )

    expect(repo.block(entryId).peekProperty(definitionProp)).toBe('def-bench-123')
  })

  it('never repoints an entry that already names a definition', async () => {
    // Only ever new information. A row is matched to an entry whose definition
    // agrees or is absent, so an entry that names one is already the right
    // one — rewriting it would move a logged session onto a different lift.
    const started = await startWorkout(repo, WORKSPACE_ID, PAGE_ID, workoutDraft([
      exerciseDraft('Bench press', [draftSet(135, 8)], {definitionId: 'def-original'}),
    ]))
    const entryId = started.exercises[0].id

    await materializeExercise(
      repo,
      started.workoutId,
      exerciseDraft('Bench press', [draftSet(135, 8)], {definitionId: 'def-different'}),
      entryId,
    )

    expect(repo.block(entryId).peekProperty(definitionProp)).toBe('def-original')
  })
})
