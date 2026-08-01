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
import {adjustSet, finishSession, startSession} from '../../src/km/session'
import type {PlannedLift, SessionPlan} from '../../src/km/sessionPlan'
import {
  STRENGTH_PROPS,
  STRENGTH_TYPES,
  dateProp,
  definitionProp,
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
  it('flips the workout done, untags un-performed sets from todo while keeping them, and stamps the performed working weight', async () => {
    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([lift('Bench press', 3)]))
    const [entry] = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    const sets = await childrenOf(entry.id, SET_TYPE)
    // Two performed at a heavier weight than prescribed, one never done — so
    // the stamped weight has to come from what was logged, not from the
    // prescription still sitting on the third block.
    for (const set of sets.slice(0, 2)) {
      await repo.tx(async tx => {
        await tx.setProperties(set.id, {set: [
          propertyValue(weightProp, 145), propertyValue(todoStatusProp, 'done'),
        ]})
      }, {scope: ChangeScope.BlockDefault, description: 'log a set'})
    }

    expect(await finishSession(repo, workoutId)).toBe('done')

    expect(repo.block(workoutId).peekProperty(statusProp)).toBe('done')
    expect(repo.block(entry.id).peekProperty(workingWeightProp)).toBe(145)

    // Nothing was pruned — the un-performed set is still a block recording
    // what was asked for and not done…
    expect(await isBlockDeleted(repo, sets[2].id)).toBe(false)
    expect(hasBlockType(repo.block(sets[2].id).peek()!, SET_TYPE)).toBe(true)
    // …it just stops claiming to be an outstanding task, so it leaves every
    // open-todo query instead of sitting in them forever.
    expect(hasBlockType(repo.block(sets[2].id).peek()!, TODO_TYPE)).toBe(false)
    // The performed ones keep both tags and their tick.
    expect(hasBlockType(repo.block(sets[0].id).peek()!, TODO_TYPE)).toBe(true)
    expect(repo.block(sets[0].id).peekProperty(todoStatusProp)).toBe('done')
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

  it('leaves a note typed under a lift alone', async () => {
    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan([lift('Bench press', 1)]))
    const [entry] = await childrenOf(workoutId, EXERCISE_ENTRY_TYPE)
    const [set] = await childrenOf(entry.id, SET_TYPE)
    await tick(set.id)
    await repo.tx(async tx => {
      await tx.create({
        id: 'shoulder-note', workspaceId: WORKSPACE_ID, parentId: entry.id, orderKey: 'z0',
        content: 'left shoulder felt tight',
      })
    }, {scope: ChangeScope.BlockDefault, description: 'user note under the lift'})

    expect(await finishSession(repo, workoutId)).toBe('done')

    expect(await isBlockDeleted(repo, 'shoulder-note')).toBe(false)
    expect(repo.block(entry.id).peekProperty(occurrenceProp)).toBe(0)
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
      await tx.setProperty(entryId, unitProp, 'kg')
      await repo.addTypeInTx(tx, legacyId, SET_TYPE, {}, repo.snapshotTypeRegistries())
    }, {scope: ChangeScope.BlockDefault, description: 'a set from before the redesign'})

    await adjustSet(repo, legacyId, {weight: 5})

    expect(repo.block(legacyId).peek()?.content).toBe('190kg × 5')
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
