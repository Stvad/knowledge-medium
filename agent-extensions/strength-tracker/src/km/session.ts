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
  adoptTypedBlock, createTypedChild, derivedBlockId, getOrCreateTypedChild, type DerivedIdentity,
} from '@/data/typedRecords.js'
// A logged set composes with the built-in todo: the todo type + its `status`
// prop make done-ness the native checkbox and reuse todo tooling.
import {statusProp as todoStatusProp, TODO_TYPE} from '@/plugins/todo/schema.js'

import {workingWeight} from '../engine/progression'
import type {LayoffRecord, SessionType} from '../engine/types'
import {dateToDay, dayToDate} from './day'
import {EXERCISE_ENTRY_TYPE, FIELD, SET_TYPE, WORKOUT_TYPE} from './fields'
import {escapeKeyPart} from './history'
import {writeLayoffInTx} from './store'
import {matchEntries, namesThisLift, type PlannedLift, type PlannedSet, type SessionPlan} from './sessionPlan'
import {
  completedAtProp,
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

/** Newest first, id as the tiebreak so every device orders ties the same. */
const newestFirst = (a: BlockData, b: BlockData): number =>
  (b.createdAt ?? 0) - (a.createdAt ?? 0) || (a.id < b.id ? -1 : 1)

/** The chain above a block, nearest first, bounded so a cycle in hand-edited
 *  parentage cannot spin. */
const ancestorsOf = async (tx: Tx, block: BlockData): Promise<BlockData[]> => {
  const chain: BlockData[] = []
  let current: BlockData | null = block
  for (let hop = 0; hop < 6 && current?.parentId; hop += 1) {
    current = await tx.get(current.parentId)
    if (!current || current.deleted) break
    chain.push(current)
  }
  return chain
}

/** The `taken` fallback, in the shape `getOrCreateTypedChild`'s contract
 *  prescribes: look for the record you mean inside this same transaction,
 *  adopt it if it is there, mint only if it is not. Without the lookup the
 *  mint is unfindable next time, and a permanently-rejected seat mints again
 *  on every call. */
const adoptOrMint = async (
  repo: Repo,
  tx: Tx,
  parentId: string,
  spec: Parameters<typeof createTypedChild>[2],
  isTheOne: (block: BlockData) => boolean,
  typeSnapshot: TypeSnapshot,
): Promise<string> => {
  const existing = (await tx.childrenOf(parentId, undefined, {hidePropertyChildren: true}))
    .find(block => !block.deleted && isTheOne(block))
  return existing !== undefined
    ? (await adoptTypedBlock(repo, tx, existing, spec.types, typeSnapshot)).id
    : createTypedChild(repo, tx, spec)
}

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
    // Denormalised onto the set, like `exercise` onto the entry: the row is
    // rendered and edited on its own, and reading the unit off the parent
    // would put a parent load in the render path of every set on screen.
    propertyValue(unitProp, unit),
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
  // Candidates for the standing-session scan, from the same workspace-wide
  // population the readers use — a page-children-only scan would miss a
  // session filed under a year heading, which is exactly where the sessions
  // logged before this redesign live. Filtered HERE, on rows already loaded,
  // so the in-transaction re-read below is bounded by the handful that could
  // plausibly be tonight rather than by every workout ever recorded — those
  // `tx.get`s hold the write lock while every other write queues behind them.
  // Re-checked inside the transaction regardless, so a stale list can only
  // cause a mint, never a bad adoption.
  const known = (await repo.query.typedBlocks({workspaceId, types: [WORKOUT_TYPE]}).load())
    .filter((row: BlockData) => isTonightsLog(row, plan))
    .map((row: BlockData) => row.id)

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
    // More than one can look standing: a device that has received the second
    // session's create row but not yet the FIRST one's status update sees both
    // as in-progress. Prefer the derived seat, then the newest — "the session
    // you are in", not "the lowest id". Picking arbitrarily (which is all
    // picking the lowest id would — that rule exists to make two READERS
    // agree, not to choose a write target) stamped tonight into a session the
    // other device had already closed, which derived ids exist to stop.
    const derivedSeat = derivedBlockId(workoutIdentity(workspaceId, plan.day, plan.session))
    const candidates = [...seen.values()]
      .filter(block => !block.deleted && isTonightsLog(block, plan))
    const standing = candidates.find(block => block.id === derivedSeat)
      ?? [...candidates].sort(newestFirst)[0]

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

    // Scanned before deriving, for the same reason the workout is: a lift's
    // derived id is keyed on its PLAN BLOCK when the plan could be read and
    // on its NAME when it could not, so a device that starts before the plan
    // has synced writes name-keyed entries, and the next tap — with the plan
    // readable — derives elsewhere and stamps a second entry, and a second
    // whole set tree, inside the same workout. The block already there says
    // which lift it is; ask it first, and the derived id becomes the way to
    // create rather than the only way to find.
    const liveEntries = (await tx.childrenOf(workout.id, undefined, {hidePropertyChildren: true}))
      .filter(block => !block.deleted && hasBlockType(block, EXERCISE_ENTRY_TYPE))
    // Settled for every row at once, before any of them writes.
    const {matched: continues, claimed} = matchEntries(plan.lifts, liveEntries)

    for (const [row, lift] of plan.lifts.entries()) {
      const already = continues[row]
      const entry = already !== undefined
        ? await adoptTypedBlock(repo, tx, already, [EXERCISE_ENTRY_TYPE], typeSnapshot)
        : await getOrCreateTypedChild(repo, tx, {
          identity: exerciseIdentity(workout.id, lift.definitionId ?? lift.exercise, lift.occurrence),
          // …and never one another row was already given. A row that matched
          // nothing above still derives an id, and that id can be an entry the
          // by-name pass just handed out — a definition renamed away from the
          // name a bare row still carries is enough. `stillNamesLift` would
          // wave it through, and both lifts would share one set tree.
          adoptable: both(
            block => !claimed.has(block.id),
            both(stillUnder(workout.id), stillNamesLift(lift)),
          ),
          ...entrySpec(workout.id, lift, typeSnapshot),
        })
      const entryId = entry.status !== 'taken'
        ? entry.id
        // A rejected seat is PERMANENT — a tombstone stays one, and a block
        // the user dragged out or repointed keeps failing `adoptable` — so a
        // blind mint here adds another entry (and another whole set tree) on
        // every Start tap, forever. Look for the mint the last tap made
        // before making a new one: the same lookup-then-mint the layoff path
        // does, and the reason `startSession` can claim to be idempotent.
        : await adoptOrMint(repo, tx, workout.id, entrySpec(workout.id, lift, typeSnapshot),
          block => hasBlockType(block, EXERCISE_ENTRY_TYPE) && namesThisLift(block, lift),
          typeSnapshot)

      // Read once, and kept up to date as we mint: a set's re-find key is its
      // POSITION among its lift's live sets, which is the same thing its
      // derived id encodes. Re-reading per index would miss the sets minted
      // earlier in this very loop.
      const liveSets = (await tx.childrenOf(entryId, undefined, {hidePropertyChildren: true}))
        .filter(block => !block.deleted && hasBlockType(block, SET_TYPE))

      for (const [index, set] of lift.sets.entries()) {
        const seat = await getOrCreateTypedChild(repo, tx, {
          identity: setIdentity(entryId, index),
          adoptable: stillUnder(entryId),
          ...setSpec(entryId, set, lift.unit, typeSnapshot),
        })
        if (seat.status === 'taken' && liveSets[index] === undefined) {
          const minted = await createTypedChild(repo, tx, setSpec(entryId, set, lift.unit, typeSnapshot))
          const block = await tx.get(minted)
          if (block) liveSets[index] = block
        }
      }
    }
    return workout.id
  }, {scope: ChangeScope.BlockDefault, description: `Start ${sessionLabel(plan.session)}`})
}

// ──── editing a set ────

const numberAt = (block: BlockData, field: string, fallback: number): number =>
  typeof block.properties[field] === 'number' ? block.properties[field] as number : fallback

/** Nudge what a set says you lifted, by a DELTA rather than to a value.
 *
 *  Deltas because the caller is a thumb on a ± button, and the value it would
 *  otherwise send is read off a render. Two taps before the first write lands
 *  both compute `135 + 5`, so tapping quickly to dial 135 up to 185 silently
 *  loses increments — and the number lost is the one the whole progression
 *  engine reads. A delta resolved against the row inside the transaction
 *  cannot lose a tap, whatever the render was showing.
 *
 *  ONE transaction for the properties and the content, because they are two
 *  views of the same fact: the engine reads
 *  `strength:weight`/`strength:reps`, the outline shows the text, and a
 *  reader trusting the text while progression trusts the properties would
 *  train off the wrong numbers.
 */
export const adjustSet = async (
  repo: Repo,
  setId: string,
  /** A relative nudge, or — for `set` — an outright value. `set` exists for
   *  typing a starting weight: a lift with no history stamps at 0, and
   *  dialling that to 135 with a ± button is 27 taps. It is deliberately a
   *  different field, so the delta path cannot be accidentally handed an
   *  absolute and lose a tap. */
  delta: {weight?: number; reps?: number; set?: {weight?: number; reps?: number}},
): Promise<'written' | 'gone' | 'closed'> =>
  repo.tx(async tx => {
    const block = await tx.get(setId)
    if (!block || block.deleted) return 'gone' as const

    // Walked, not hopped: a set tabbed under its neighbour or outdented up to
    // the workout is an ordinary outline gesture, and a fixed set→entry→
    // workout walk misses both — leaving the closed-session refusal and the
    // unit fallback silently inactive for exactly the blocks a thumb is most
    // likely to have rearranged.
    const ancestors = await ancestorsOf(tx, block)
    const workout = ancestors.find(row => hasBlockType(row, WORKOUT_TYPE))
      ?? ancestors.find(row => row.properties[FIELD.status] !== undefined)

    // A closed session is a record, not a form. The old per-set writer
    // refused once the workout was finished, and dropping that guard while
    // WIDENING the surface from one view to every set block in the outline is
    // how one stray tap rewrites the baseline the next prescription derives
    // from — and leaves the stamped working weight disagreeing with its sets.
    if (workout && workout.properties[FIELD.status] === 'done') return 'closed' as const

    const previousWeight = numberAt(block, FIELD.weight, 0)
    const previousReps = numberAt(block, FIELD.reps, 0)
    const weight = Math.max(0, delta.set?.weight ?? previousWeight + (delta.weight ?? 0))
    const reps = Math.max(0, delta.set?.reps ?? previousReps + (delta.reps ?? 0))
    // Sets logged before this redesign carry no `strength:unit` — it lived on
    // the entry — so reading the set alone would rewrite "185lb × 5" as
    // "185 × 5", stripping the unit from a record meant to stay readable
    // without the extension. Nearest ancestor that has one, for the same
    // reason the workout is walked to rather than hopped to.
    const unit = typeof block.properties[FIELD.unit] === 'string'
      ? block.properties[FIELD.unit] as string
      : (ancestors.find(row => typeof row.properties[FIELD.unit] === 'string')
        ?.properties[FIELD.unit] as string | undefined) ?? ''
    const side = block.properties[FIELD.side] === 'L' || block.properties[FIELD.side] === 'R'
      ? block.properties[FIELD.side] as 'L' | 'R'
      : undefined
    const shape = (w: number, r: number): string =>
      setContent({weight: w, reps: r, ...(side ? {side} : {})}, unit)

    await tx.setProperties(setId, {set: [
      propertyValue(weightProp, weight),
      propertyValue(repsProp, reps),
    ]})
    // We only own the text we wrote. Restoring `Inner` made the set line
    // editable again, so "185lb × 5 — felt easy" is something you can
    // legitimately have typed — and rewriting it from the properties threw
    // away both the note AND the number you typed, which nothing reads back.
    // Untouched when it is no longer machine-shaped: the properties still
    // move, so the ± buttons work, and your words survive.
    if (block.content === shape(previousWeight, previousReps)) {
      await tx.update(setId, {content: shape(weight, reps)})
    }
    return 'written' as const
  }, {scope: ChangeScope.BlockDefault, description: 'Adjust set'})

// ──── closing ────

export type FinishOutcome =
  /** Closed. */
  | 'done'
  /** No longer in progress — finished or discarded elsewhere, or deleted. */
  | 'gone'
  /** Nothing was ticked, so there is no training day to record. Writes
   *  nothing: an empty tree is never consent to commit an empty record. */
  | 'nothing-logged'

/** Every set in a subtree, however deep.
 *
 *  Sets DESCEND rather than only sit as direct children: indenting one under
 *  a note you typed is an ordinary outline gesture, and a direct-children
 *  scan silently omits it from the record while leaving it behind as an open
 *  todo under a session that can never be finished again. Bounded so
 *  hand-edited parentage cannot spin. */
const setsUnder = async (tx: Tx, rootId: string, depth = 0): Promise<BlockData[]> => {
  if (depth > 4) return []
  const found: BlockData[] = []
  for (const child of await tx.childrenOf(rootId, undefined, {hidePropertyChildren: true})) {
    if (child.deleted) continue
    if (hasBlockType(child, SET_TYPE)) found.push(child)
    else found.push(...await setsUnder(tx, child.id, depth + 1))
  }
  return found
}

/** Every set block under a workout, with the entry it belongs to. */
const setsOf = async (
  tx: Tx,
  workoutId: string,
): Promise<{entry: BlockData; sets: BlockData[]}[]> => {
  const out: {entry: BlockData; sets: BlockData[]}[] = []
  for (const entry of await tx.childrenOf(workoutId, undefined, {hidePropertyChildren: true})) {
    if (!hasBlockType(entry, EXERCISE_ENTRY_TYPE)) continue
    out.push({entry, sets: await setsUnder(tx, entry.id)})
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
  /** A layoff to record in the SAME transaction, when this session is the
   *  first one back from a break.
   *
   *  Atomic with the finish, not a write beside it: the gap stops being
   *  detectable the moment the finish lands (`detectPendingLayoff` reads no
   *  gap on any later day), so writing it separately and failing loses the
   *  record for good — every session after the first back silently returns to
   *  full loads. */
  layoff?: {pageId: string; record: Omit<LayoffRecord, 'id'>},
): Promise<FinishOutcome> => {
  const typeSnapshot = repo.snapshotTypeRegistries()
  return repo.tx(async tx => {
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

    // Finish is the moment we know the work happened by. The native todo
    // checkbox writes only `status`, so without this nothing stamps
    // `strength:completedAt` at all — and `buildHistory` derives `recordedAt`
    // from it, which is the ONLY thing that orders two sessions of the same
    // training day. Absent, `compareRecords` calls them incomparable and
    // whichever row the query returns first decides which one tomorrow's
    // prescription progresses from. Only when absent, so a real tick-time
    // stamp always wins over this approximation.
    const finishedAt = Date.now()

    for (const {entry, sets} of tree) {
      for (const set of sets) {
        if (isDone(set) && set.properties[FIELD.completedAt] === undefined) {
          await tx.setProperty(set.id, completedAtProp, finishedAt)
        }
        // EVERY set stops being a todo, performed or not — a closed session is
        // a record, and a record holds no outstanding tasks. Untagging only the
        // skipped ones left the performed sets with a live checkbox, and one
        // tap unticks a set of a session that can never be finished again:
        // `buildHistory` drops it from progression while the entry keeps the
        // working weight stamped from it. Done-ness lives in the `status`
        // property, which is what history reads and which this leaves alone —
        // so this changes what you can DO to the record, not what it says.
        if (hasBlockType(set, TODO_TYPE)) await repo.removeTypeInTx(tx, set.id, TODO_TYPE)
      }
      // Denormalised so "last working weight for lift X" stays a flat scan.
      // Written from what was actually performed, by the same function
      // progression judges with — not from what was prescribed.
      const weight = workingWeight({exercise: '', sets: sets.filter(isDone).map(setRecord)})
      if (weight !== undefined) await tx.setProperty(entry.id, workingWeightProp, weight)
    }

    if (layoff) {
      await writeLayoffInTx(repo, tx, workout.workspaceId, layoff.pageId, layoff.record, typeSnapshot)
    }
    await tx.setProperty(workoutId, statusProp, 'done')
    return 'done' as const
  }, {scope: ChangeScope.BlockDefault, description: 'Finish session'})
}
