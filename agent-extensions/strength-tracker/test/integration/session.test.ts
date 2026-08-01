/** `session.ts` against a REAL `Repo` over a real `@powersync/node` database.
 *
 *  The whole point of the module is which blocks exist after a tap, and what
 *  a SECOND tap does to blocks the first one made — neither is exercisable
 *  against fakes. Runs under `vitest.integration.config.ts`, which points
 *  `@/` at the real app sources.
 */

import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'

import {ChangeScope, propertyValue} from '@/data/api'
import type {BlockData} from '@/data/api'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo, isBlockDeleted} from '@/data/test/createTestRepo'
import {deleteBlock} from '@/data/mutators'
import {definitionSeedsFacet, typeSeedsFacet} from '@/data/facets'
import {hasBlockType} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {statusProp as todoStatusProp, TODO_TYPE, todoType} from '@/plugins/todo/schema'

import {EXERCISE_ENTRY_TYPE, SET_TYPE, WORKOUT_TYPE} from '../../src/km/fields'
import {dayToDate} from '../../src/km/day'
import {buildHistory} from '../../src/km/history'
import {adjustSet, finishSession, startSession} from '../../src/km/session'
import {closeSession} from '../../src/km/tonight'
import type {PlannedLift, SessionPlan} from '../../src/km/sessionPlan'
import {
  STRENGTH_PROPS,
  STRENGTH_TYPES,
  completedAtProp,
  dateProp,
  definitionProp,
  exerciseProp,
  occurrenceProp,
  sessionProp,
  prescribedSetsProp,
  repsProp,
  sideProp,
  statusProp,
  unitProp,
  weightProp,
  workingWeightProp,
} from '../../src/km/schema'

const WORKSPACE_ID = 'ws-1'
const PAGE_ID = 'strength-log-page'
const DAY = '2026-07-24'

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
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
  repo.setActiveWorkspaceId(WORKSPACE_ID)
  await repo.tx(async tx => {
    await tx.create({
      id: PAGE_ID, workspaceId: WORKSPACE_ID, parentId: null, orderKey: 'a0', content: 'Strength Log',
    })
  }, {scope: ChangeScope.BlockDefault, description: 'seed page'})
})

// ──── plan builders ────

const lift = (exercise: string, sets: number, over: Partial<PlannedLift> = {}): PlannedLift => ({
  exercise,
  occurrence: 0,
  unit: 'lb',
  prescribedSets: sets,
  sets: Array.from({length: sets}, () => ({weight: 135, reps: 8})),
  ...over,
})

const plan = (lifts: PlannedLift[], over: Partial<SessionPlan> = {}): SessionPlan =>
  ({day: DAY, session: 'A', lifts, ...over})

// ──── tree readers ────

const childrenOf = async (parentId: string, typeId?: string): Promise<BlockData[]> => {
  const rows = (await repo.block(parentId).children.load()) ?? []
  const live = rows.filter(row => !row.deleted)
  return typeId === undefined ? live : live.filter(row => hasBlockType(row, typeId))
}

const tick = async (setId: string): Promise<void> => {
  await repo.tx(async tx => {
    await tx.setProperties(setId, {set: [propertyValue(todoStatusProp, 'done')]})
  }, {scope: ChangeScope.BlockDefault, description: 'tick a set'})
}

describe('startSession — one tap stamps the whole session', () => {
  it('creates the workout, an entry per lift and a block per prescribed set, every set an open todo', async () => {
    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([
      lift('Bench press', 3, {definitionId: 'def-bench'}),
      lift('Barbell row', 2),
    ]))

    expect(repo.block(workoutId).peekProperty(statusProp)).toBe('in-progress')
    expect(hasBlockType(repo.block(workoutId).peek()!, WORKOUT_TYPE)).toBe(true)

    const entries = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    expect(entries.map(e => e.content)).toEqual(['Bench press', 'Barbell row'])
    expect(repo.block(entries[0].id).peekProperty(definitionProp)).toBe('def-bench')
    expect(repo.block(entries[0].id).peekProperty(prescribedSetsProp)).toBe(3)

    const benchSets = await childrenOf(entries[0].id, SET_TYPE)
    expect(benchSets).toHaveLength(3)
    // Prescribed, not performed: the block exists and the checkbox is clear.
    // A stamp that pre-ticked would make "did I do this?" unanswerable.
    for (const set of benchSets) {
      expect(hasBlockType(set, TODO_TYPE)).toBe(true)
      expect(repo.block(set.id).peekProperty(todoStatusProp)).toBe('open')
      expect(repo.block(set.id).peekProperty(weightProp)).toBe(135)
      expect(repo.block(set.id).peekProperty(repsProp)).toBe(8)
    }
    expect(await childrenOf(entries[1].id, SET_TYPE)).toHaveLength(2)
  })

  it('gives a single-arm lift two rows per set, left leading', async () => {
    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([
      lift('Single-arm row', 2, {
        sets: [
          {weight: 60, reps: 10, side: 'L'}, {weight: 60, reps: 10, side: 'R'},
          {weight: 60, reps: 10, side: 'L'}, {weight: 60, reps: 10, side: 'R'},
        ],
      }),
    ]))
    const [entry] = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    const sets = await childrenOf(entry.id, SET_TYPE)

    // Outline order IS set order now — nothing records an index, so a stamp
    // that appended out of order would be unrecoverable.
    expect(sets.map(s => repo.block(s.id).peekProperty(sideProp))).toEqual(['L', 'R', 'L', 'R'])
  })

  it('adopts on a second tap rather than stamping a second session, and leaves ticked sets alone', async () => {
    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([lift('Bench press', 2)]))
    const [entry] = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    const [first] = await childrenOf(entry.id, SET_TYPE)
    await tick(first.id)

    const again = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([lift('Bench press', 2)]))

    expect(again).toBe(workoutId)
    expect(await childrenOf(PAGE_ID, WORKOUT_TYPE)).toHaveLength(1)
    expect(await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)).toHaveLength(1)
    expect(await childrenOf(entry.id, SET_TYPE)).toHaveLength(2)
    // The adopt must not hand back its own prescription over what was logged.
    expect(repo.block(first.id).peekProperty(todoStatusProp)).toBe('done')
  })

  it('stamps a second session beside a finished one rather than reopening it', async () => {
    const first = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([lift('Bench press', 1)]))
    const [entry] = await childrenOf(first, EXERCISE_ENTRY_TYPE)
    const [set] = await childrenOf(entry.id, SET_TYPE)
    await tick(set.id)
    expect(await finishSession(repo, first)).toBe('done')

    const second = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([lift('Bench press', 1)]))

    expect(second).not.toBe(first)
    expect(repo.block(first).peekProperty(statusProp)).toBe('done')
    expect(repo.block(second).peekProperty(statusProp)).toBe('in-progress')
  })

  it('mints beside an entry seat whose block now answers for a different lift', async () => {
    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([
      lift('Bench press', 1, {definitionId: 'def-bench'}),
    ]))
    const [entry] = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    // A hand-edit repoints the entry at another lift's plan block. Its derived
    // id still resolves, so adopting on the id alone would file tonight's
    // bench sets under the other lift.
    await repo.tx(async tx => {
      await tx.setProperties(entry.id, {set: [propertyValue(definitionProp, 'def-overhead')]})
    }, {scope: ChangeScope.BlockDefault, description: 'repoint by hand'})

    await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([
      lift('Bench press', 1, {definitionId: 'def-bench'}),
    ]))

    const entries = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    expect(entries).toHaveLength(2)
    expect(entries.filter(e => repo.block(e.id).peekProperty(definitionProp) === 'def-bench')).toHaveLength(1)
  })

  it('mints beside a set seat whose block was dragged out of the lift', async () => {
    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([lift('Bench press', 1)]))
    const [entry] = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    const [set] = await childrenOf(entry.id, SET_TYPE)
    await repo.tx(async tx => { await tx.move(set.id, {parentId: PAGE_ID, orderKey: 'z0'}) },
      {scope: ChangeScope.BlockDefault, description: 'drag the set out'})

    await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([lift('Bench press', 1)]))

    // The dragged block is left where the user put it; the lift gets its set
    // back rather than silently having none.
    expect(await childrenOf(entry.id, SET_TYPE)).toHaveLength(1)
    expect(await isBlockDeleted(repo, set.id)).toBe(false)
  })
})

describe('finishSession — closing without deleting anything', () => {
  it('flips the workout done, keeps every set block, and stamps the performed working weight', async () => {
    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([lift('Bench press', 3)]))
    const [entry] = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    const sets = await childrenOf(entry.id, SET_TYPE)
    // ONE performed at a heavier weight than prescribed, TWO left open at the
    // prescribed 135. The counts matter: with two done at 145 the modal
    // weight is 145 whether or not the un-performed sets are filtered out, so
    // the filter this asserts would have been unfalsifiable. Here the honest
    // answer is 145 and the unfiltered one is 135.
    await repo.tx(async tx => {
      await tx.setProperties(sets[0].id, {set: [
        propertyValue(weightProp, 145), propertyValue(todoStatusProp, 'done'),
      ]})
    }, {scope: ChangeScope.BlockDefault, description: 'log a set'})

    expect(await finishSession(repo, workoutId)).toBe('done')

    expect(repo.block(workoutId).peekProperty(statusProp)).toBe('done')
    expect(repo.block(entry.id).peekProperty(workingWeightProp)).toBe(145)

    // Nothing was pruned — the un-performed set is still a block recording
    // what was asked for and not done…
    expect(await isBlockDeleted(repo, sets[2].id)).toBe(false)
    expect(hasBlockType(repo.block(sets[2].id).peek()!, SET_TYPE)).toBe(true)
    // …it just stops claiming to be an outstanding task, so it leaves every
    // open-todo query instead of sitting in them forever. So does the
    // performed one — see 'a closed session is a record, not a form'.
    expect(hasBlockType(repo.block(sets[2].id).peek()!, TODO_TYPE)).toBe(false)
    // The performed one keeps its tick, which is what history reads.
    expect(repo.block(sets[0].id).peekProperty(todoStatusProp)).toBe('done')
    // …and Finish stamps when it happened. Nothing else writes this — the
    // native checkbox sets only `status` — and it is the only thing that
    // orders two sessions of one training day.
    expect(typeof repo.block(sets[0].id).peekProperty(completedAtProp)).toBe('number')
  })

  it('refuses a session with nothing ticked, writing nothing', async () => {
    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([lift('Bench press', 2)]))
    const [entry] = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    const sets = await childrenOf(entry.id, SET_TYPE)

    expect(await finishSession(repo, workoutId)).toBe('nothing-logged')

    // Counted before anything is written, so the refusal leaves the session
    // exactly as it was rather than half-closed with its todos stripped.
    expect(repo.block(workoutId).peekProperty(statusProp)).toBe('in-progress')
    for (const set of sets) {
      expect(hasBlockType(repo.block(set.id).peek()!, TODO_TYPE)).toBe(true)
    }
  })

  it('reports gone when the session is no longer in progress', async () => {
    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([lift('Bench press', 1)]))
    const [entry] = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    const [set] = await childrenOf(entry.id, SET_TYPE)
    await tick(set.id)
    expect(await finishSession(repo, workoutId)).toBe('done')

    expect(await finishSession(repo, workoutId)).toBe('gone')
  })

  it('does not count a ticked note under a lift as a performed set', async () => {
    // A note you typed under a lift is an ordinary block, and you may well
    // tick it. Without the `strength-set` filter it reads as a performed set
    // with no numbers: the session commits as a training day holding nothing,
    // and stamps a working weight of 0 that every later prescription follows.
    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([lift('Bench press', 1)]))
    const [entry] = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    await repo.tx(async tx => {
      await tx.create({
        id: 'shoulder-note', workspaceId: WORKSPACE_ID, parentId: entry.id, orderKey: 'a1',
        content: 'left shoulder felt tight',
      })
      await tx.setProperties('shoulder-note', {set: [propertyValue(todoStatusProp, 'done')]})
      await repo.addTypeInTx(tx, 'shoulder-note', TODO_TYPE, {}, repo.snapshotTypeRegistries())
    }, {scope: ChangeScope.BlockDefault, description: 'a ticked note under the lift'})

    // The real set is untouched, so nothing was actually performed.
    expect(await finishSession(repo, workoutId)).toBe('nothing-logged')
    expect(await isBlockDeleted(repo, 'shoulder-note')).toBe(false)
    expect(repo.block(entry.id).peekProperty(workingWeightProp)).toBeUndefined()
  })
})

describe('a rejected seat is permanent, so the mint must be re-findable', () => {
  it('does not add another entry on every later tap', async () => {
    // `taken` never becomes untaken — a tombstone stays one, and a repointed
    // block keeps failing `adoptable`. A blind mint therefore adds an entry
    // (and its whole set tree) on EVERY Start tap, forever. Three taps is the
    // smallest number that tells "mint once" apart from "mint each time":
    // two taps look identical either way.
    const start = () => startSession(repo, WORKSPACE_ID, PAGE_ID, plan([
      lift('Bench press', 1, {definitionId: 'def-bench'}),
    ]))
    const workoutId = await start()
    const [entry] = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    await repo.tx(async tx => {
      await tx.setProperties(entry.id, {set: [propertyValue(definitionProp, 'def-overhead')]})
    }, {scope: ChangeScope.BlockDefault, description: 'repoint by hand'})

    await start()
    const afterSecond = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    await start()
    const afterThird = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)

    expect(afterSecond).toHaveLength(2)
    expect(afterThird.map(e => e.id).sort()).toEqual(afterSecond.map(e => e.id).sort())
  })

  it('does not resurrect a set you deleted, and does not keep minting for it either', async () => {
    const start = () => startSession(repo, WORKSPACE_ID, PAGE_ID, plan([lift('Bench press', 3)]))
    const workoutId = await start()
    const [entry] = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    const sets = await childrenOf(entry.id, SET_TYPE)
    // Delete the MIDDLE one: its derived seat becomes a tombstone while the
    // seats either side stay live, which is the case a positional re-find has
    // to get right.
    await repo.tx(tx => tx.run(deleteBlock, {id: sets[1].id}),
      {scope: ChangeScope.BlockDefault, description: 'drop a set'})

    await start()
    const afterSecond = await childrenOf(entry.id, SET_TYPE)
    await start()
    const afterThird = await childrenOf(entry.id, SET_TYPE)

    // A set you deleted was a decision; Start does not undo it…
    expect(afterSecond).toHaveLength(2)
    // …and it does not grow a new one on every tap either.
    expect(afterThird.map(s => s.id)).toEqual(afterSecond.map(s => s.id))
  })
})

describe('which standing session a tap continues', () => {
  const standingWorkout = async (id: string, over: {day?: string; session?: string} = {}) => {
    await repo.tx(async tx => {
      await tx.create({id, workspaceId: WORKSPACE_ID, parentId: PAGE_ID, orderKey: 'a1', content: 'other'})
      await tx.setProperties(id, {set: [
        propertyValue(statusProp, 'in-progress'),
        propertyValue(sessionProp, (over.session ?? 'A') as 'A' | 'B' | 'mini'),
        propertyValue(dateProp, dayToDate(over.day ?? DAY)),
      ]})
      await repo.addTypeInTx(tx, id, WORKOUT_TYPE, {}, repo.snapshotTypeRegistries())
    }, {scope: ChangeScope.BlockDefault, description: 'a peer session'})
  }

  it('continues the one at the derived seat when two look live', async () => {
    // A device that has the SECOND session's create row but not yet the
    // first's status update sees both as in-progress. Picking arbitrarily
    // stamps tonight into a session the other device already closed.
    const derived = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([lift('Bench press', 1)]))
    await standingWorkout('11111111-1111-4111-8111-111111111111')

    expect(await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([lift('Bench press', 1)]))).toBe(derived)
  })

  it('does not continue a session logged for another day', async () => {
    await standingWorkout('22222222-2222-4222-8222-222222222222', {day: '2026-07-20'})

    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([lift('Bench press', 1)]))

    // Adopting it would file tonight's lifts into another day's record.
    expect(workoutId).not.toBe('22222222-2222-4222-8222-222222222222')
  })

  it('does not continue the other session type on the same day', async () => {
    await standingWorkout('33333333-3333-4333-8333-333333333333', {session: 'B'})

    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([lift('Bench press', 1)]))

    expect(workoutId).not.toBe('33333333-3333-4333-8333-333333333333')
  })
})

describe('adjustSet', () => {
  const oneSet = async (): Promise<{setId: string; entryId: string; workoutId: string}> => {
    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([lift('Bench press', 1)]))
    const [entry] = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    const [set] = await childrenOf(entry.id, SET_TYPE)
    return {setId: set.id, entryId: entry.id, workoutId}
  }

  it('applies the delta to what the block holds now, not to what the caller last saw', async () => {
    // The property that makes a burst of ± taps safe. An absolute value
    // computed in the click handler is read off a render, so two taps before
    // the first commit both send the same number and one increment vanishes.
    const {setId} = await oneSet()
    await repo.tx(tx => tx.setProperty(setId, weightProp, 200),
      {scope: ChangeScope.BlockDefault, description: 'someone else set the weight'})

    expect(await adjustSet(repo, setId, {weight: 5})).toBe('written')

    expect(repo.block(setId).peekProperty(weightProp)).toBe(205)
  })

  it('never drives a value below zero', async () => {
    const {setId} = await oneSet()
    expect(await adjustSet(repo, setId, {weight: -1000})).toBe('written')
    expect(repo.block(setId).peekProperty(weightProp)).toBe(0)
  })

  it('keeps the content in step with the properties', async () => {
    const {setId} = await oneSet()
    await adjustSet(repo, setId, {weight: 5, reps: -1})
    expect(repo.block(setId).peek()?.content).toBe('140lb × 7')
  })

  it('takes the unit from the lift when the set does not carry one', async () => {
    // Sets logged before this redesign have no `strength:unit` — it lived on
    // the entry. Reading the set alone rewrites "185lb × 5" as "185 × 5",
    // stripping the unit from a record meant to stay readable without the
    // extension.
    const {entryId} = await oneSet()
    const legacyId = 'legacy-set-block'
    await repo.tx(async tx => {
      await tx.create({
        id: legacyId, workspaceId: WORKSPACE_ID, parentId: entryId, orderKey: 'a1',
        content: '185lb × 5',
      })
      await tx.setProperty(legacyId, weightProp, 185)
      await tx.setProperty(legacyId, repsProp, 5)
      await tx.setProperty(entryId, unitProp, 'lb')
      await repo.addTypeInTx(tx, legacyId, SET_TYPE, {}, repo.snapshotTypeRegistries())
    }, {scope: ChangeScope.BlockDefault, description: 'a set from before the redesign'})

    await adjustSet(repo, legacyId, {weight: 5})

    // Without the fallback the unit reads as empty, `185 × 5` no longer
    // matches the text on the block, and the content is left behind entirely.
    expect(repo.block(legacyId).peek()?.content).toBe('190lb × 5')
  })

  it('refuses a set whose session is already closed', async () => {
    // A closed session is a record, not a form — and the steppers now render
    // on every set block in the outline, not just tonight's, so one stray tap
    // would rewrite the baseline the next prescription derives from.
    const {setId, workoutId} = await oneSet()
    await tick(setId)
    expect(await finishSession(repo, workoutId)).toBe('done')
    const before = repo.block(setId).peekProperty(weightProp)

    expect(await adjustSet(repo, setId, {weight: 5})).toBe('closed')

    expect(repo.block(setId).peekProperty(weightProp)).toBe(before)
  })

  it('reports gone for a set deleted out from under it, without resurrecting it', async () => {
    const {setId} = await oneSet()
    await repo.tx(tx => tx.run(deleteBlock, {id: setId}),
      {scope: ChangeScope.BlockDefault, description: 'delete the set'})

    expect(await adjustSet(repo, setId, {weight: 5})).toBe('gone')
    expect(await isBlockDeleted(repo, setId)).toBe(true)
  })
})

describe('the invariants the deleted suite used to hold', () => {
  it('continues a session filed away from where this tap would stamp it', async () => {
    // Sessions logged before this redesign live under the Strength Log page,
    // while a tap now stamps into the daily note — so the workspace-wide scan
    // is the ONLY thing that finds them. Without it, Start builds a second
    // workout beside the standing one and logs into a session the screen
    // isn't showing.
    const AWAY = 'some-other-page'
    // A RANDOM id, which is what every session logged before derived ids has.
    // Given a derived one, the id lookup finds it wherever it sits and the
    // scan is never consulted — so this has to be the legacy shape or it
    // pins nothing.
    const filedAway = '44444444-4444-4444-8444-444444444444'
    await repo.tx(async tx => {
      await tx.create({
        id: AWAY, workspaceId: WORKSPACE_ID, parentId: null, orderKey: 'a1', content: '2026',
      })
      await tx.create({
        id: filedAway, workspaceId: WORKSPACE_ID, parentId: AWAY, orderKey: 'a0',
        content: 'Session A · 2026-07-24',
      })
      await tx.setProperties(filedAway, {set: [
        propertyValue(statusProp, 'in-progress'),
        propertyValue(sessionProp, 'A'),
        propertyValue(dateProp, dayToDate(DAY)),
      ]})
      await repo.addTypeInTx(tx, filedAway, WORKOUT_TYPE, {}, repo.snapshotTypeRegistries())
    }, {scope: ChangeScope.BlockDefault, description: 'a legacy session under a year heading'})

    // A different parent — the daily note, in the real flow.
    const again = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([lift('Bench press', 1)]))

    expect(again).toBe(filedAway)
    expect(await childrenOf(PAGE_ID, WORKOUT_TYPE)).toHaveLength(0)
  })

  it('takes the working weight from the left side of a single-arm lift', async () => {
    // The plan's rule is "left sets the reps, right matches", so the left is
    // the honest progression signal. Drop the side from what Finish reads and
    // the modal tiebreak goes heavy — stamping the STRONG arm's load and
    // progressing off it forever.
    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([
      lift('Single-arm row', 2, {
        sets: [
          {weight: 35, reps: 10, side: 'L'}, {weight: 45, reps: 10, side: 'R'},
          {weight: 35, reps: 10, side: 'L'}, {weight: 45, reps: 10, side: 'R'},
        ],
      }),
    ]))
    const [entry] = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    for (const set of await childrenOf(entry.id, SET_TYPE)) await tick(set.id)

    expect(await finishSession(repo, workoutId)).toBe('done')

    expect(repo.block(entry.id).peekProperty(workingWeightProp)).toBe(35)
  })

  it('leaves a lift you skipped with no working weight, rather than zero', async () => {
    // `undefined` reads as "no data" to every consumer; 0 reads as "you
    // lifted nothing", which is a real number the next prescription follows.
    // Needs a session that DOES finish, so a second lift carries it.
    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([
      lift('Bench press', 1), lift('Barbell row', 1),
    ]))
    const [bench, row] = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    const [benchSet] = await childrenOf(bench.id, SET_TYPE)
    await tick(benchSet.id)

    expect(await finishSession(repo, workoutId)).toBe('done')

    expect(repo.block(bench.id).peekProperty(workingWeightProp)).toBe(135)
    expect(repo.block(row.id).peekProperty(workingWeightProp)).toBeUndefined()
  })

  it('orders two sessions of one training day by when they were finished', async () => {
    // `date` is that day's local noon on both, so the day alone cannot say
    // which came second. `recordedAt` — derived from the sets' completedAt —
    // is the only thing that can, and it decides which session tomorrow's
    // prescription progresses from.
    const morning = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([lift('Bench press', 1)]))
    const [mEntry] = await childrenOf(morning, EXERCISE_ENTRY_TYPE)
    const [mSet] = await childrenOf(mEntry.id, SET_TYPE)
    await tick(mSet.id)
    expect(await finishSession(repo, morning)).toBe('done')

    const evening = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([lift('Bench press', 1)]))
    const [eEntry] = await childrenOf(evening, EXERCISE_ENTRY_TYPE)
    const [eSet] = await childrenOf(eEntry.id, SET_TYPE)
    await tick(eSet.id)
    expect(await finishSession(repo, evening)).toBe('done')

    const history = buildHistory(
      await repo.query.typedBlocks({workspaceId: WORKSPACE_ID, types: [WORKOUT_TYPE]}).load(),
      await repo.query.typedBlocks({workspaceId: WORKSPACE_ID, types: [EXERCISE_ENTRY_TYPE]}).load(),
      await repo.query.typedBlocks({workspaceId: WORKSPACE_ID, types: [SET_TYPE]}).load(),
    )
    expect(history.map(w => w.id)).toEqual([morning, evening])
    expect(history.every(w => w.recordedAt !== undefined)).toBe(true)
  })
})

describe('a set the outline has rearranged, and text you typed', () => {
  const closedSetTabbedUnderItsNeighbour = async (): Promise<string> => {
    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([lift('Bench press', 2)]))
    const [entry] = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    const sets = await childrenOf(entry.id, SET_TYPE)
    await tick(sets[0].id)
    expect(await finishSession(repo, workoutId)).toBe('done')
    // Tabbed in AFTER closing — Finish refuses a tree shaped like this, so
    // this is the way a closed session comes to hold one. It puts the workout
    // THREE hops above the set instead of two.
    await repo.tx(tx => tx.move(sets[1].id, {parentId: sets[0].id, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault, description: 'tab the set in'})
    return sets[1].id
  }

  it('refuses a nested set whose session is closed, not just a direct grandchild', async () => {
    const setId = await closedSetTabbedUnderItsNeighbour()
    const before = repo.block(setId).peekProperty(weightProp)

    expect(await adjustSet(repo, setId, {weight: 5})).toBe('closed')

    expect(repo.block(setId).peekProperty(weightProp)).toBe(before)
  })

  it('leaves text you typed alone, rather than overwriting it from the properties', async () => {
    // Restoring `Inner` made the set line editable again, so this is a
    // legitimate thing to have typed — and rewriting it from the properties
    // threw away both the note and the number, neither of which is read back.
    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([lift('Bench press', 1)]))
    const [entry] = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    const [set] = await childrenOf(entry.id, SET_TYPE)
    await repo.tx(tx => tx.update(set.id, {content: '225lb × 5 — felt easy'}),
      {scope: ChangeScope.BlockDefault, description: 'type over the set line'})

    expect(await adjustSet(repo, set.id, {reps: 1})).toBe('written')

    expect(repo.block(set.id).peek()?.content).toBe('225lb × 5 — felt easy')
    // The properties still move, so the buttons keep working.
    expect(repo.block(set.id).peekProperty(repsProp)).toBe(9)
  })

  it('still keeps the text in step while it is the text we wrote', async () => {
    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([lift('Bench press', 1)]))
    const [entry] = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    const [set] = await childrenOf(entry.id, SET_TYPE)

    await adjustSet(repo, set.id, {weight: 5})

    expect(repo.block(set.id).peek()?.content).toBe('140lb × 8')
  })
})

describe('two lifts that share a name', () => {
  it('does not collapse them into one entry when only one came from the plan', async () => {
    // `planFromPrescription` keys occurrence on `defId ?? name`, so these are
    // both occurrence 0. Matching on the name whenever either side lacked a
    // plan block merged them: one lift left the session entirely and its set
    // seats adopted the other's blocks.
    // The BARE lift comes first, and the two carry different set counts. Both
    // matter: scanned in this order a too-permissive match lets the bare row
    // claim the plan-keyed entry before its rightful owner gets there, and the
    // swap is only visible in which entry ends up holding which sets —
    // adopting never rewrites the definition, so comparing those sees nothing.
    const twoPresses = () => plan([
      lift('Press', 1),
      lift('Press', 3, {definitionId: 'def-ohp'}),
    ])
    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID, twoPresses())
    expect(await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)).toHaveLength(2)

    await startSession(repo, WORKSPACE_ID, PAGE_ID, twoPresses())

    const entries = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    expect(entries).toHaveLength(2)
    const byDef = new Map(await Promise.all(entries.map(async e => [
      repo.block(e.id).peekProperty(definitionProp) ?? 'bare',
      (await childrenOf(e.id, SET_TYPE)).length,
    ] as const)))
    expect(byDef.get('def-ohp')).toBe(3)
    expect(byDef.get('bare')).toBe(1)
  })

  it('does not fork an entry when the plan becomes readable between two taps', async () => {
    // A device that starts before the plan has synced keys the entry on the
    // NAME; the next tap, with the plan readable, derives elsewhere — and
    // stamped a second entry and a second whole set tree in the same workout.
    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID,
      plan([lift('Bench press', 2)]))

    await startSession(repo, WORKSPACE_ID, PAGE_ID,
      plan([lift('Bench press', 2, {definitionId: 'def-bench'})]))

    const entries = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    expect(entries).toHaveLength(1)
    expect(await childrenOf(entries[0].id, SET_TYPE)).toHaveLength(2)
  })
})

describe('an entry whose plan block appears or disappears between taps', () => {
  it('continues it when the plan becomes unreadable, rather than deriving a second', async () => {
    // The mirror of the readable direction. This tap knows the plan block; the
    // next one does not (the outline has not synced, or stopped resolving), so
    // it keys on the NAME and derives elsewhere. Without the by-name pass
    // that is a second entry and a second set tree in the same workout.
    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID,
      plan([lift('Bench press', 2, {definitionId: 'def-bench'})]))

    await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([lift('Bench press', 2)]))

    const entries = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    expect(entries).toHaveLength(1)
    expect(await childrenOf(entries[0].id, SET_TYPE)).toHaveLength(2)
  })

  it('settles every exact match before any row falls back to a name', async () => {
    // Two same-named lifts, one plan-keyed and one not, with the BARE row
    // listed first. Matched greedily row by row, the bare row reaches the
    // plan-keyed entry first and both rows land on the wrong tree — visible
    // only in which entry ends up holding which sets, since adopting never
    // rewrites the definition.
    const first = plan([lift('Press', 3, {definitionId: 'def-ohp'}), lift('Press', 1)])
    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID, first)
    expect(await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)).toHaveLength(2)

    // Same two lifts, bare one first.
    await startSession(repo, WORKSPACE_ID, PAGE_ID,
      plan([lift('Press', 1), lift('Press', 3, {definitionId: 'def-ohp'})]))

    const entries = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    expect(entries).toHaveLength(2)
    const byDef = new Map(await Promise.all(entries.map(async e => [
      repo.block(e.id).peekProperty(definitionProp) ?? 'bare',
      (await childrenOf(e.id, SET_TYPE)).length,
    ] as const)))
    expect(byDef.get('def-ohp')).toBe(3)
    expect(byDef.get('bare')).toBe(1)
  })
})

describe('a closed session is a record, not a form', () => {
  it('takes the checkbox off every set, performed ones included', async () => {
    // Untagging only the skipped sets left the performed ones tickable. One
    // tap unticks a set of a session that can never be finished again:
    // `buildHistory` drops it from progression while the entry keeps the
    // working weight stamped from it, and the two disagree for good.
    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([lift('Bench press', 2)]))
    const [entry] = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    const sets = await childrenOf(entry.id, SET_TYPE)
    await tick(sets[0].id)

    expect(await finishSession(repo, workoutId)).toBe('done')

    for (const set of sets) {
      expect(hasBlockType(repo.block(set.id).peek()!, TODO_TYPE)).toBe(false)
      expect(hasBlockType(repo.block(set.id).peek()!, SET_TYPE)).toBe(true)
    }
    // Done-ness lives in `status`, which is what history reads — untouched,
    // so the record still says what was performed.
    expect(repo.block(sets[0].id).peekProperty(todoStatusProp)).toBe('done')
    expect(repo.block(entry.id).peekProperty(workingWeightProp)).toBe(135)
  })

  it('refuses a set indented where history cannot read it, rather than closing around it', async () => {
    // `buildHistory` groups sets by their DIRECT parent entry — it gets flat
    // rows and cannot walk through a note block it never queried. Closing
    // around a nested set would report the session recorded while progression
    // never sees the work, and would strip the todo that is your only sign it
    // is there. Both readers use one rule; anything outside it is reported.
    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([lift('Bench press', 1)]))
    const [entry] = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    const [set] = await childrenOf(entry.id, SET_TYPE)
    await repo.tx(async tx => {
      await tx.create({
        id: 'a-note', workspaceId: WORKSPACE_ID, parentId: entry.id, orderKey: 'a1',
        content: 'felt tight, went lighter',
      })
      await tx.move(set.id, {parentId: 'a-note', orderKey: 'a0'})
    }, {scope: ChangeScope.BlockDefault, description: 'indent the set under a note'})
    await tick(set.id)

    expect(await finishSession(repo, workoutId)).toBe('misfiled')

    // Nothing written: still open, still a todo, still yours to outdent.
    expect(repo.block(workoutId).peekProperty(statusProp)).toBe('in-progress')
    expect(hasBlockType(repo.block(set.id).peek()!, TODO_TYPE)).toBe(true)
    expect(repo.block(entry.id).peekProperty(workingWeightProp)).toBeUndefined()
  })
})

describe('typing a starting weight', () => {
  it('sets the value outright rather than nudging from it', async () => {
    // A lift with no history stamps at 0; reaching 135 with the ± button is
    // 27 taps. The typed path is a separate field so the delta path can never
    // be handed an absolute and quietly lose a tap.
    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([
      lift('Bench press', 1, {sets: [{weight: 0, reps: 8}]}),
    ]))
    const [entry] = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    const [set] = await childrenOf(entry.id, SET_TYPE)

    expect(await adjustSet(repo, set.id, {set: {weight: 135}})).toBe('written')
    expect(repo.block(set.id).peekProperty(weightProp)).toBe(135)
    expect(repo.block(set.id).peek()?.content).toBe('135lb × 8')

    // Typed again from a NON-zero value, which is the only thing that tells
    // "set to" apart from "add": from 0 the two agree.
    expect(await adjustSet(repo, set.id, {set: {weight: 100}})).toBe('written')
    expect(repo.block(set.id).peekProperty(weightProp)).toBe(100)
  })
})

describe('a plan block renamed away from the name an entry still carries', () => {
  it('keeps the two lifts on separate trees', async () => {
    // Logged as "Press" from `def-ohp`. The plan block is later renamed to
    // "Overhead Press", and the plan also has a bare "Press" row.
    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID,
      plan([lift('Press', 1, {definitionId: 'def-ohp'})]))

    // The bare row wins the existing entry by NAME. The renamed row matches
    // nothing — but its derived id is that same entry's, and `stillNamesLift`
    // sees a matching definition and would wave it through. Both lifts would
    // then write into one entry and one set tree.
    await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([
      lift('Overhead Press', 3, {definitionId: 'def-ohp'}),
      lift('Press', 1),
    ]))

    const entries = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    expect(entries).toHaveLength(2)
    const byName = new Map(await Promise.all(entries.map(async e => [
      repo.block(e.id).peekProperty(exerciseProp),
      (await childrenOf(e.id, SET_TYPE)).length,
    ] as const)))
    expect(byName.get('Overhead Press')).toBe(3)
    expect(byName.get('Press')).toBe(1)
  })
})

describe('a session that cannot be filed on a day', () => {
  it('refuses to close a workout whose date was cleared, rather than substituting today', async () => {
    // `strength:date` is hand-editable. Substituting the clock closes a
    // workout that `buildHistory` then drops whole — gone from progression,
    // todos already stripped, and no way back in through Finish.
    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([lift('Bench press', 1)]))
    const [entry] = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    const [set] = await childrenOf(entry.id, SET_TYPE)
    await tick(set.id)
    await repo.tx(tx => tx.setProperties(workoutId, {set: [propertyValue(dateProp, undefined)]}),
      {scope: ChangeScope.BlockDefault, description: 'clear the date by hand'})

    expect(await closeSession(repo, WORKSPACE_ID, workoutId)).toBe('undated')

    expect(repo.block(workoutId).peekProperty(statusProp)).toBe('in-progress')
    expect(hasBlockType(repo.block(set.id).peek()!, TODO_TYPE)).toBe(true)
  })
})
