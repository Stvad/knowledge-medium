/** Stamping and closing a session.
 *
 *  One tap creates the whole session — workout, one entry per prescribed
 *  lift, one block per prescribed set — in a single transaction, so it lands
 *  and undoes as one step. From that moment the outline IS the state: a set
 *  block's EXISTENCE means prescribed and its todo `status` means performed,
 *  which is why nothing here is materialized on a guess and nothing is pruned
 *  at the end. Editing a set is editing its block, through the ordinary block
 *  path; there is no draft to reconcile and no writer of last resort.
 *
 *  What survived from the old write path, and why: the derived ids. Two taps,
 *  two tabs or two devices starting the same session converge on one row
 *  instead of racing. They cost almost nothing now — the machinery that used
 *  to surround them (index repair, stray placement, re-finding a refilled
 *  block) existed for the refill, and there is no refill.
 */

import {ChangeScope, propertyValue, type BlockData, type Tx} from '@/data/api/index.js'
import {hasBlockType} from '@/data/properties.js'
import type {Repo} from '@/data/repo.js'
import {
  adoptTypedBlock, createTypedChild, getOrCreateTypedChild, type DerivedIdentity,
} from '@/data/typedRecords.js'
// A logged set composes with the built-in todo: the todo type + its `status`
// prop make done-ness the native checkbox and reuse todo tooling.
import {statusProp as todoStatusProp, TODO_TYPE} from '@/plugins/todo/schema.js'

import {workingWeight} from '../engine/progression'
import type {SessionType} from '../engine/types'
import {dateToDay, dayToDate} from './day'
import {EXERCISE_ENTRY_TYPE, FIELD, SET_TYPE, WORKOUT_TYPE} from './fields'
import {escapeKeyPart, preferredLive} from './history'
import type {PlannedLift, PlannedSet, SessionPlan} from './sessionPlan'
import {
  dateProp,
  definitionProp,
  exerciseProp,
  occurrenceProp,
  prescribedSetsProp,
  prescribedWeightProp,
  repsProp,
  sessionProp,
  sideProp,
  statusProp,
  unitProp,
  weightProp,
  workingWeightProp,
} from './schema'

type TypeSnapshot = ReturnType<Repo['snapshotTypeRegistries']>

const sessionLabel = (session: SessionType): string =>
  session === 'mini' ? 'Mini day' : `Session ${session}`

const setContent = (set: PlannedSet, unit: string): string =>
  `${set.side ? `${set.side} ` : ''}${set.weight}${unit} × ${set.reps}`

/** Which training day a raw `date` property lands on, read the way the
 *  readers read it: `undefined` for anything that doesn't decode as a day. */
const liveDay = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string') return undefined
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? undefined : dateToDay(date)
}

// ──── derived identities ────
//
// Unchanged namespaces and key layouts: sessions already logged on these ids
// must keep resolving to the same blocks.
const WORKOUT_NS = '80ae2b6d-7bde-4de7-9790-04e2d24eeb02'
const EXERCISE_NS = '6d216957-1c1f-45c8-8ee6-b44bb0e7f4aa'
const SET_NS = 'feda0816-3421-4fe5-8249-ac2655cc962b'

/** One workout per workspace/day/session — the FIRST one. A second session of
 *  the same type on the same day has nothing left to key on, so it is minted
 *  rather than derived (see `startSession`). */
const workoutIdentity = (workspaceId: string, day: string, session: SessionType): DerivedIdentity =>
  ({namespace: WORKOUT_NS, key: `${workspaceId}|${day}|${session}`})

/** One entry per lift, keyed on the plan block where there is one so a lift
 *  renamed mid-session stays the same entry. `escapeKeyPart` so a lift NAMED
 *  "Bench|1" cannot derive the same id as "Bench" at occurrence 1. */
const exerciseIdentity = (workoutId: string, key: string, occurrence: number): DerivedIdentity => {
  const part = escapeKeyPart(key)
  return {
    namespace: EXERCISE_NS,
    key: occurrence === 0 ? `${workoutId}|${part}` : `${workoutId}|${part}|${occurrence}`,
  }
}

/** Sets are positional within their entry — including the L/R rows of a
 *  per-side lift, which alternate. */
const setIdentity = (exerciseId: string, index: number): DerivedIdentity =>
  ({namespace: SET_NS, key: `${exerciseId}|${index}`})

/** Is this block the session tonight's tap would be logging into — the same
 *  three fields the readers file a workout by, so a start can never target a
 *  workout the outline shows as something else. Deliberately no type check:
 *  the properties are both key and evidence, which lets a workout that lost
 *  its type tag be repaired rather than duplicated. */
const isTonightsLog = (block: BlockData, plan: SessionPlan): boolean =>
  block.properties[FIELD.status] === 'in-progress'
  && block.properties[FIELD.session] === plan.session
  && liveDay(block.properties[FIELD.date]) === plan.day

/** A positional record's seat is where it sits: a block dragged out of this
 *  parent is no longer this slot's occupant, and adopting it would write the
 *  rest of the session into another tree. */
const stillUnder = (parentId: string) => (block: BlockData): boolean =>
  block.parentId === parentId

/** …and for an entry, also: does it still claim to be THIS lift. Silent about
 *  the name on purpose — an entry with no definition (or one logged while the
 *  plan outline was unreadable) still matches, so a later client that can read
 *  the plan adopts it instead of deriving a second entry beside it. */
const stillNamesLift = (lift: PlannedLift) => (block: BlockData): boolean => {
  const definition = block.properties[FIELD.definition]
  return typeof definition !== 'string'
    || lift.definitionId === undefined
    || definition === lift.definitionId
}

const both = (
  a: (block: BlockData) => boolean,
  b: (block: BlockData) => boolean,
) => (block: BlockData): boolean => a(block) && b(block)

// ──── stamping ────

const setSpec = (
  entryId: string,
  set: PlannedSet,
  unit: string,
  typeSnapshot: TypeSnapshot,
) => ({
  parentId: entryId,
  content: setContent(set, unit),
  types: [SET_TYPE, TODO_TYPE],
  properties: [
    propertyValue(weightProp, set.weight),
    propertyValue(repsProp, set.reps),
    ...(set.side !== undefined ? [propertyValue(sideProp, set.side)] : []),
    // Prescribed, not performed. The checkbox is the only thing that says
    // performed, and only you tick it.
    propertyValue(todoStatusProp, 'open' as const),
  ],
  typeSnapshot,
})

const entrySpec = (
  workoutId: string,
  lift: PlannedLift,
  typeSnapshot: TypeSnapshot,
) => ({
  parentId: workoutId,
  content: lift.exercise,
  types: [EXERCISE_ENTRY_TYPE],
  properties: [
    propertyValue(exerciseProp, lift.exercise),
    ...(lift.definitionId !== undefined ? [propertyValue(definitionProp, lift.definitionId)] : []),
    propertyValue(occurrenceProp, lift.occurrence),
    propertyValue(unitProp, lift.unit),
    ...(lift.prescribedWeight !== undefined
      ? [propertyValue(prescribedWeightProp, lift.prescribedWeight)]
      : []),
    propertyValue(prescribedSetsProp, lift.prescribedSets),
  ],
  typeSnapshot,
})

/** Stamp tonight's session into `parentId` and return the workout's block id.
 *
 *  Idempotent: everything is addressed by a derived id, so tapping Start
 *  again adopts what the first tap made and leaves every logged value exactly
 *  as it is. The one thing it will not adopt is a workout already `done` —
 *  "I did session A twice today" has to stay representable, and there is no
 *  second id to derive for it (which of two is "the second" is only knowable
 *  from rows a device happens to hold). So the repeat falls back to a lookup
 *  inside the transaction and mints if that comes back empty.
 */
export const startSession = async (
  repo: Repo,
  workspaceId: string,
  parentId: string,
  plan: SessionPlan,
): Promise<string> => {
  const typeSnapshot = repo.snapshotTypeRegistries()
  // Candidate ids for the standing-session scan, from the same workspace-wide
  // population the readers use — a page-children-only scan would miss a
  // session filed under a year heading. Ids only, read before the transaction
  // (`Tx` has no arbitrary queries) and re-checked inside it, so a stale list
  // can only cause a mint, never a bad adoption.
  const known = (await repo.query.typedBlocks({workspaceId, types: [WORKOUT_TYPE]}).load())
    .map((row: {id: string}) => row.id)

  return repo.tx(async tx => {
    const workoutSpec = {
      parentId,
      content: `${sessionLabel(plan.session)} · ${plan.day}`,
      position: {kind: 'first'} as const,
      types: [WORKOUT_TYPE],
      properties: [
        propertyValue(sessionProp, plan.session),
        propertyValue(dateProp, dayToDate(plan.day)),
        propertyValue(statusProp, 'in-progress' as const),
      ],
      typeSnapshot,
    }

    // Scanned BEFORE deriving, always: a workout written before derived ids
    // carries a random one, leaving the derived seat empty however live it is,
    // and deriving first there would stamp a second session beside it.
    const seen = new Map<string, BlockData>()
    for (const block of await tx.childrenOf(parentId, undefined, {hidePropertyChildren: true})) {
      seen.set(block.id, block)
    }
    for (const id of known) {
      if (seen.has(id)) continue
      const block = await tx.get(id)
      if (block) seen.set(id, block)
    }
    // `preferredLive` rather than "the first": this scan is ordered by
    // `(order_key, id)` and other readers order by `(created_at, id)`, so
    // "first" would mean different workouts to different callers.
    const standing = preferredLive([...seen.values()]
      .filter(block => !block.deleted && isTonightsLog(block, plan)))

    const workout = standing !== undefined
      ? await adoptTypedBlock(repo, tx, standing, workoutSpec.types, typeSnapshot)
      : await (async () => {
        const derived = await getOrCreateTypedChild(repo, tx, {
          identity: workoutIdentity(workspaceId, plan.day, plan.session),
          adoptable: block => isTonightsLog(block, plan),
          ...workoutSpec,
        })
        return derived.status !== 'taken'
          ? derived
          : {status: 'created' as const, id: await createTypedChild(repo, tx, workoutSpec)}
      })()

    for (const lift of plan.lifts) {
      const entry = await getOrCreateTypedChild(repo, tx, {
        identity: exerciseIdentity(workout.id, lift.definitionId ?? lift.exercise, lift.occurrence),
        adoptable: both(stillUnder(workout.id), stillNamesLift(lift)),
        ...entrySpec(workout.id, lift, typeSnapshot),
      })
      // A rejected seat means the block there answers for something else —
      // hand-repointed, or dragged out. Mint beside it rather than writing
      // this lift's sets into it.
      const entryId = entry.status !== 'taken'
        ? entry.id
        : await createTypedChild(repo, tx, entrySpec(workout.id, lift, typeSnapshot))

      for (const [index, set] of lift.sets.entries()) {
        const seat = await getOrCreateTypedChild(repo, tx, {
          identity: setIdentity(entryId, index),
          adoptable: stillUnder(entryId),
          ...setSpec(entryId, set, lift.unit, typeSnapshot),
        })
        if (seat.status === 'taken') {
          await createTypedChild(repo, tx, setSpec(entryId, set, lift.unit, typeSnapshot))
        }
      }
    }
    return workout.id
  }, {scope: ChangeScope.BlockDefault, description: `Start ${sessionLabel(plan.session)}`})
}

// ──── closing ────

export type FinishOutcome =
  /** Closed. */
  | 'done'
  /** No longer in progress — finished or discarded elsewhere, or deleted. */
  | 'gone'
  /** Nothing was ticked, so there is no training day to record. Writes
   *  nothing: an empty tree is never consent to commit an empty record. */
  | 'nothing-logged'

/** Every set block under a workout, with the entry it belongs to. */
const setsOf = async (
  tx: Tx,
  workoutId: string,
): Promise<{entry: BlockData; sets: BlockData[]}[]> => {
  const out: {entry: BlockData; sets: BlockData[]}[] = []
  for (const entry of await tx.childrenOf(workoutId, undefined, {hidePropertyChildren: true})) {
    if (!hasBlockType(entry, EXERCISE_ENTRY_TYPE)) continue
    const sets = (await tx.childrenOf(entry.id, undefined, {hidePropertyChildren: true}))
      .filter(child => hasBlockType(child, SET_TYPE))
    out.push({entry, sets})
  }
  return out
}

const isDone = (block: BlockData): boolean => block.properties[FIELD.todoStatus] === 'done'

const setRecord = (block: BlockData): {weight: number; reps: number; side?: 'L' | 'R'} => ({
  weight: typeof block.properties[FIELD.weight] === 'number' ? block.properties[FIELD.weight] as number : 0,
  reps: typeof block.properties[FIELD.reps] === 'number' ? block.properties[FIELD.reps] as number : 0,
  ...(block.properties[FIELD.side] === 'L' || block.properties[FIELD.side] === 'R'
    ? {side: block.properties[FIELD.side] as 'L' | 'R'}
    : {}),
})

/** Close the session.
 *
 *  Nothing is deleted. A set you did not do stops being a TODO — it drops the
 *  `todo` type, so it leaves every open-task query — but stays a `strength-set`
 *  block recording what was prescribed and not performed. That is the truthful
 *  record, and re-tagging it `todo` is the whole of the undo.
 */
export const finishSession = async (
  repo: Repo,
  workoutId: string,
): Promise<FinishOutcome> =>
  repo.tx(async tx => {
    // Checked here rather than trusted from the caller: another client can
    // close this workout between the tap and this transaction opening.
    const workout = await tx.get(workoutId)
    if (!workout || workout.deleted) return 'gone' as const
    if (workout.properties[FIELD.status] !== 'in-progress') return 'gone' as const

    const tree = await setsOf(tx, workoutId)
    // Counted before anything is written, so the refusal below leaves the
    // session exactly as it was rather than half-closed.
    const logged = tree.reduce((n, {sets}) => n + sets.filter(isDone).length, 0)
    if (logged === 0) return 'nothing-logged' as const

    for (const {entry, sets} of tree) {
      for (const set of sets) {
        if (isDone(set)) continue
        if (hasBlockType(set, TODO_TYPE)) await repo.removeTypeInTx(tx, set.id, TODO_TYPE)
      }
      // Denormalised so "last working weight for lift X" stays a flat scan.
      // Written from what was actually performed, by the same function
      // progression judges with — not from what was prescribed.
      const weight = workingWeight({exercise: '', sets: sets.filter(isDone).map(setRecord)})
      if (weight !== undefined) await tx.setProperty(entry.id, workingWeightProp, weight)
    }

    await tx.setProperty(workoutId, statusProp, 'done')
    return 'done' as const
  }, {scope: ChangeScope.BlockDefault, description: 'Finish session'})
