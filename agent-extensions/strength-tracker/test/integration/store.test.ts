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
import {hasBlockType} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {statusProp as todoStatusProp, todoType} from '@/plugins/todo/schema'

import {toLiveSet, buildLiveWorkouts} from '../../src/km/history'
import {EXERCISE_ENTRY_TYPE, SET_TYPE} from '../../src/km/fields'
import {
  STRENGTH_PROPS,
  STRENGTH_TYPES,
  completedAtProp,
  definitionProp,
  repsProp,
  rpeProp,
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

    await expect(finishWorkout(repo, workout.workoutId)).rejects.toThrow(
      new RegExp(`no "${EXERCISE_ENTRY_TYPE}" among them`),
    )

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
