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
import {deleteBlock} from '@/data/mutators.js'
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
// The placement DECISION and the delete that carries it out share one
// predicate on purpose — see `takePlaceOf`. A pure rule, no repo behind it.
import {isExpendableLine} from '../ui/placement'
import {dateToDay, dayToDate} from './day'
import {EXERCISE_ENTRY_TYPE, FIELD, SET_TYPE, WORKOUT_TYPE} from './fields'
import {escapeKeyPart} from './history'
import {writeLayoffInTx} from './store'
import {countLoggedSets} from './subtree'
import {matchEntries, namesThisLift, type PlannedLift, type PlannedSet, type SessionPlan} from './sessionPlan'
import {
  catchUpRpeProp,
  completedAtProp,
  dateProp,
  definitionProp,
  exerciseProp,
  occurrenceProp,
  prescribedRepsProp,
  prescribedSetsProp,
  prescribedWeightProp,
  repsProp,
  rpeProp,
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

/** Is a session already under way on this training day — WHATEVER its type.
 *
 *  The rule `standingSession` uses, stated once so the pre-dialog check and
 *  the stamping transaction cannot mean different things by "a session is
 *  under way". They did: this side also required the session TYPE to match, so
 *  a peer starting Session B while you configured Session A was invisible
 *  here, and the tap made a second live workout for one day — which every
 *  later Start then walks past, since it continues only the newest.
 *
 *  Deliberately no type check on the BLOCK: the properties are both key and
 *  evidence, which lets a workout that lost its type tag be repaired rather
 *  than duplicated. */
const isStandingToday = (block: BlockData, plan: SessionPlan): boolean =>
  block.properties[FIELD.status] === 'in-progress'
  && liveDay(block.properties[FIELD.date]) === plan.day

/** …and is it the one tonight's tap would be LOGGING into, which additionally
 *  needs the session type to match — stamping Session A's lifts into a Session
 *  B record files them under a session you did not do. */
const isTonightsLog = (block: BlockData, plan: SessionPlan): boolean =>
  isStandingToday(block, plan) && block.properties[FIELD.session] === plan.session

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

/** Which of several live sessions a tap continues.
 *
 *  Most recently STARTED. Two can look live at once while a peer's `done`
 *  update is still in flight, and an id has nothing to do with chronology —
 *  so taking the lowest could send you to the session you already finished,
 *  whose set checkboxes are (deliberately) still live, and log tonight's work
 *  into last night's record. `created_at` is the creating device's clock at
 *  insert, and the systemMint path zeroes `updated_at` only, so it survives a
 *  derived-id mint intact.
 *
 *  Id breaks the tie so every device names the same one. Pulled out as a pure
 *  function because that tie-break is otherwise untestable: the query happens
 *  to return rows in an order that produces the same answer, so a test
 *  through `standingSession` passes whether the clause is there or not.
 *
 *  Lives HERE, beside the stamp, rather than in `tonight.ts` where it was
 *  written: the pre-dialog check and the transaction that actually adopts have
 *  to agree about which session you are in, and two implementations of "which
 *  one" is exactly how a tap navigates to one session and stamps into another.
 */
export const mostRecentlyStarted = (
  rows: readonly {id: string; createdAt?: number}[],
): string | null => {
  let best: {id: string; createdAt?: number} | null = null
  for (const row of rows) {
    if (best === null
      || (row.createdAt ?? 0) > (best.createdAt ?? 0)
      || ((row.createdAt ?? 0) === (best.createdAt ?? 0) && row.id < best.id)) best = row
  }
  return best?.id ?? null
}

/** The chain above a block, nearest first.
 *
 *  A visited set rather than a hop limit: a cutoff dropped the workout out of
 *  reach for a set moved deep enough, and `adjustSet` then missed the
 *  closed-session guard entirely and let the controls rewrite a finished
 *  record. Cycles are what the bound is actually for, so that is what it
 *  guards against. */
const ancestorsOf = async (tx: Tx, block: BlockData): Promise<BlockData[]> => {
  const chain: BlockData[] = []
  const seen = new Set<string>([block.id])
  let current: BlockData | null = block
  while (current?.parentId && !seen.has(current.parentId)) {
    seen.add(current.parentId)
    current = await tx.get(current.parentId)
    if (!current || current.deleted) break
    chain.push(current)
  }
  return chain
}

/** Put a freshly-stamped session where an empty line was, and clear the line.
 *
 *  Runs AFTER the stamp, never before, so a session that fails to be created
 *  costs you nothing. The move is exact — the empty block is about to stop
 *  using its `orderKey`, so that slot is free — which is how the session
 *  lands where the cursor was rather than merely on the same parent, without
 *  asking `getOrCreateTypedChild` for the anchored position it refuses.
 */
export const takePlaceOf = async (
  repo: Repo,
  workoutId: string,
  placement: {parentId: string; replaces?: {id: string; orderKey: string}},
): Promise<'took-its-place' | 'cleared-only' | 'kept-the-line' | 'nothing-to-do'> => {
  const replaces = placement.replaces
  if (replaces === undefined || replaces.id === workoutId) return 'nothing-to-do'
  return repo.tx(async tx => {
    // Re-decided HERE, against the line as it is now, not as it was when the
    // action started. `replaces` is a snapshot from before the dialog opened,
    // and this delete cascades: type into that line from another pane, or
    // indent something under it, or let a peer do either while the dialog sits
    // open, and clearing it on a minutes-old read destroys work nobody asked
    // us to touch. The SAME predicate the placement decision used, so the
    // delete can never take something the decision would have spared.
    const line = await tx.get(replaces.id)
    const stillExpendable = line !== null && !line.deleted
      && line.parentId === placement.parentId
      && isExpendableLine({
        content: line.content,
        parentId: line.parentId,
        properties: line.properties,
        hasChildren: (await tx.childrenOf(replaces.id, undefined, {hidePropertyChildren: true}))
          .some(child => !child.deleted),
      })
    // Left where `startSession` put it — appended under the same parent — and
    // the line left alone. A session one slot lower than you pointed at is a
    // far smaller thing than a deleted block.
    if (!stillExpendable) return 'kept-the-line' as const

    // Only when the session actually landed where we asked. `startSession`
    // ADOPTS one already started for this training day, and that one can live
    // anywhere — dragging it out of wherever it is kept because you happened
    // to run this on an empty line is not a placement, it is a move nobody
    // asked for.
    //
    // Read in the transaction for the same reason the line above it is: a
    // pre-transaction load is old by the time the write lock is held, and
    // acting on it drags a workout back out of wherever a concurrent filing
    // gesture just put it.
    const workout = await tx.get(workoutId)
    const mine = workout !== null && !workout.deleted
      && workout.parentId === placement.parentId
    if (mine) {
      await tx.move(workoutId, {parentId: placement.parentId, orderKey: replaces.orderKey})
    }
    // Cleared either way: the line was opened to hold a session and now has
    // one — here, or wherever the adopted one lives.
    await tx.run(deleteBlock, {id: replaces.id})
    return mine ? 'took-its-place' as const : 'cleared-only' as const
  }, {scope: ChangeScope.BlockDefault, description: 'Put the session where the cursor was'})
}

/** What Discard is about to destroy, read before the confirmation.
 *
 *  The same walk `discardSession` re-runs inside its transaction — see
 *  `countLoggedSets`. Two implementations of "is there logged work here?" is
 *  how the warning ends up describing a tree the delete no longer applies to.
 */
export const loggedSetCount = async (repo: Repo, workoutId: string): Promise<number> =>
  countLoggedSets(async id => (await repo.block(id).children.load()) ?? [], workoutId)

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
    // Only where the plan gives RPE something to do. Absent on every other
    // set, and that absence is what the row reads to decide not to ask —
    // so a stray control never appears on a lift whose progression would
    // ignore the answer.
    ...(set.catchUpRpe !== undefined ? [propertyValue(catchUpRpeProp, set.catchUpRpe)] : []),
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
    ...(lift.prescribedReps !== undefined
      ? [propertyValue(prescribedRepsProp, lift.prescribedReps)]
      : []),
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
export interface StartedSession {
  id: string
  /** Whether THIS call wrote the confirmed plan into it.
   *
   *  `false` means a session that arrived since the caller's check was handed
   *  back untouched — the lifts you picked are not in it. The caller needs to
   *  know, because the things it does AFTER a start are all conditional on the
   *  start having happened: recording an `or`-group choice says "this is the
   *  variant I am now tracking", and recording it off a session that never got
   *  the pick changes what future sessions prescribe on the strength of a race
   *  you lost and were never told about. */
  stamped: boolean
}

export const startSession = async (
  repo: Repo,
  workspaceId: string,
  parentId: string,
  plan: SessionPlan,
  /** Where among `parentId`'s children the workout lands. `first` reads as a
   *  log (newest on top), which is what the Strength Log page wants; `last`
   *  is what taking the place of an empty block you just opened at the end of
   *  a page looks like. Anchored positions are not on offer —
   *  `getOrCreateTypedChild` refuses them, since re-keying siblings can throw
   *  before the derived id is known to be free. */
  position: {kind: 'first'} | {kind: 'last'} = {kind: 'first'},
  /** The standing session the caller saw when it last looked — `null` for "I
   *  checked, there was none". Re-checked inside the transaction, and a
   *  session that turns up anyway is CONTINUED rather than stamped into; see
   *  the comment at that check for what stamping into it costs.
   *
   *  Omitted entirely means "no premise to keep", which leaves the plain
   *  adopt-and-stamp behaviour a second tap with the same plan relies on. */
  expectedStanding?: string | null,
): Promise<StartedSession> => {
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
  // Widened to any session under way today, not only this type: the premise
  // check below asks the same question `standingSession` does, and it cannot
  // ask it about rows this list never carried into the transaction.
  const known = (await repo.query.typedBlocks({workspaceId, types: [WORKOUT_TYPE]}).load())
    .filter((row: BlockData) => isStandingToday(row, plan))
    .map((row: BlockData) => row.id)

  return repo.tx(async tx => {
    const workoutSpec = {
      parentId,
      content: `${sessionLabel(plan.session)} · ${plan.day}`,
      position,
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
    const live = [...seen.values()].filter(block => !block.deleted)

    // FIRST, before anything is created: a session that arrived since the
    // caller last looked is CONTINUED, not started beside and not stamped
    // into.
    //
    // `runStartSession` checks for one before the dialog and again after it,
    // and navigates rather than starting — but those checks and this
    // transaction are separate operations, and a peer's create can land in
    // between. It does not even need a race: an offline device's row applies
    // whenever it syncs. Stamping the confirmed plan into a session somebody
    // else configured adds THIS device's pick of an `or`-group beside the one
    // already there, and Finish records both — the both-alternatives session
    // those checks exist to prevent, arriving inside the transaction they
    // cannot cover. The `or`-group pick does not change `workoutIdentity`, so
    // no id comparison can tell that session apart from your own re-tap; only
    // the caller's premise can.
    //
    // Which is why the premise travels in, the same way `finishSession`
    // re-checks `expectedDate` and `discardSession` re-checks its count. A
    // caller that says nothing keeps the plain adopt-and-stamp behaviour — a
    // second tap with the same plan is idempotent, which is what the derived
    // seats are for.
    //
    // Asked with `isStandingToday`, the rule the CALLER's check used: a peer
    // starting Session B while you configured Session A is a session under way
    // whatever it is called, and creating an A beside it leaves two live
    // workouts for one day — which every later Start then walks past, since it
    // continues only the newest. Nothing is written on this path, not even a
    // type repair: the mandate is "hand it back", and a transaction that
    // writes nothing costs nothing.
    if (expectedStanding !== undefined) {
      const arrived = mostRecentlyStarted(live.filter(block => isStandingToday(block, plan)))
      if (arrived !== null && arrived !== expectedStanding) return {id: arrived, stamped: false}
    }

    // More than one can look standing: a device that has received the second
    // session's create row but not yet the FIRST one's status update sees both
    // as in-progress. Most recently STARTED — "the session you are in", not
    // "the lowest id", and not "the derived one" either. Preferring the
    // derived seat here made this disagree with `standingSession`, which is
    // the check that decided a moment ago which workout to send you to: a
    // session arriving between the two reaches this selection instead, and the
    // tap then stamps tonight's lifts into a session you are not looking at.
    // One rule, one function, both ends.
    //
    // `isTonightsLog`, not `isStandingToday`: what gets ADOPTED and stamped
    // has to be this session type, since Session A's lifts filed under a
    // Session B record are filed under a session you did not do.
    const candidates = live.filter(block => isTonightsLog(block, plan))
    const continuesId = mostRecentlyStarted(candidates)
    const standing = candidates.find(block => block.id === continuesId)

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
    return {id: workout.id, stamped: true}
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
/** Load steps in the unit the set records. Deliberately not the plan's
 *  `roundTo`: this is a thumb correcting a number under a bar, and a plate you
 *  can actually add is the useful increment. */
export const weightStep = (unit: string): number => (unit === 'kg' ? 2.5 : 5)

export interface SetAdjustment {
  weight?: number
  reps?: number
  /** ± one plate, sized HERE rather than by the caller.
   *
   *  The unit is resolved inside the transaction by walking to the nearest
   *  ancestor that has one, and the caller cannot do that: `strength:unit` has
   *  a schema default of `lb`, so a set logged before the unit lived on the
   *  set reads back as `lb` in the UI however the workout is actually kept.
   *  The two answers then disagreed in the worst possible way — a 5 lb step
   *  applied to a row this same function goes on to write as kg. Ask for a
   *  step and only one of them has to be right. */
  weightSteps?: number
  set?: {weight?: number; reps?: number; rpe?: number | null}
}

const writeSet = async (
  repo: Repo,
  setId: string,
  /** A relative nudge, or — for `set` — an outright value. `set` exists for
   *  typing a starting weight: a lift with no history stamps at 0, and
   *  dialling that to 135 with a ± button is 27 taps. It is deliberately a
   *  different field, so the delta path cannot be accidentally handed an
   *  absolute and lose a tap.
   *
   *  `set.rpe` has no delta form on purpose: an RPE is a judgement about the
   *  set you just did, not a number you dial up from the last one. `null`
   *  clears it, because a mis-tap has to be undoable — and an ABSENT rpe is
   *  load-bearing, being exactly what stops the catch-up jump firing on
   *  evidence that was never given. */
  delta: SetAdjustment,
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

    // Sets logged before this redesign carry no `strength:unit` — it lived on
    // the entry — so reading the set alone would rewrite "185lb × 5" as
    // "185 × 5", stripping the unit from a record meant to stay readable
    // without the extension. Nearest ancestor that has one, for the same
    // reason the workout is walked to rather than hopped to.
    //
    // Resolved BEFORE the weight, because it is what sizes a `weightSteps`
    // nudge — see `SetAdjustment`.
    const unit = typeof block.properties[FIELD.unit] === 'string'
      ? block.properties[FIELD.unit] as string
      : (ancestors.find(row => typeof row.properties[FIELD.unit] === 'string')
        ?.properties[FIELD.unit] as string | undefined) ?? ''

    const previousWeight = numberAt(block, FIELD.weight, 0)
    const previousReps = numberAt(block, FIELD.reps, 0)
    const nudged = (delta.weight ?? 0) + (delta.weightSteps ?? 0) * weightStep(unit)
    const weight = Math.max(0, delta.set?.weight ?? previousWeight + nudged)
    const reps = Math.max(0, delta.set?.reps ?? previousReps + (delta.reps ?? 0))
    const side = block.properties[FIELD.side] === 'L' || block.properties[FIELD.side] === 'R'
      ? block.properties[FIELD.side] as 'L' | 'R'
      : undefined
    const shape = (w: number, r: number): string =>
      setContent({weight: w, reps: r, ...(side ? {side} : {})}, unit)

    const rpe = delta.set?.rpe
    await tx.setProperties(setId, {
      set: [
        propertyValue(weightProp, weight),
        propertyValue(repsProp, reps),
        ...(typeof rpe === 'number' ? [propertyValue(rpeProp, rpe)] : []),
      ],
      // Cleared, not written as undefined: `unset` is the only thing that
      // takes the key back OUT of the bag, and `allSetsAtOrBelowRpe` asks
      // whether the value is there at all.
      ...(rpe === null ? {unset: [rpeProp]} : {}),
    })
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

/** Set edits that have been started and have not landed yet.
 *
 *  Finish is one tap away from a blur, and nothing awaits the blur's write:
 *  the weight field commits on blur (mousedown), the button commits on click
 *  (mouseup), and the two run as independent transactions. Lose that race and
 *  the session closes around the OLD number while the edit then refuses as
 *  `closed` — telling you to reopen a session the extension offers no way to
 *  reopen, with the number you typed nowhere in the record.
 *
 *  A module-level set rather than plumbing through React because the two ends
 *  are different components with no relationship: `SetLine` writes, and
 *  `WorkoutFooter` — anywhere in the tree — is what must not overtake it.
 */
const inFlight = new Set<Promise<unknown>>()

/** A set edit that rejected and has not been superseded.
 *
 *  Waiting on `inFlight` alone only catches a write still running when Finish
 *  is tapped. Lose by a hair the other way — the blur's write rejects between
 *  mousedown and mouseup — and the set is empty again by the time Finish
 *  looks, so it closes around the old number while `SetLine` is displaying
 *  "could not save that". The closed-session guard then refuses every retry.
 *  So a failure outlives its promise.
 */
let failedEdit = false

/** Let the set edits that were ALREADY running finish, and say whether any
 *  edit has failed since the last time this asked.
 *
 *  One drain of what is in flight now, not a loop until quiet: writes started
 *  after this was called are not part of the gesture that called it, and
 *  waiting for those would let a stuck field block Finish for ever.
 *
 *  The sticky flag CLEARS on the way out, so the refusal happens once. It has
 *  to: the alternative is a session nothing can close until a write succeeds,
 *  and "I know, 135 is right, finish it" is a perfectly good answer to being
 *  told the edit did not save. Tapping Finish again means you were told.
 */
let draining: Promise<'settled' | 'failed'> | null = null

export const setEditsSettled = (): Promise<'settled' | 'failed'> => {
  // One drain, shared by everyone who asks while it runs. Clearing the flag on
  // read is what makes the refusal happen once — but two Finish taps that
  // OVERLAP (the same workout in two panels, say) both awaited, both resumed,
  // and only the first saw the failure: the second read the flag the first had
  // just cleared and closed the session around the unsaved number. Sharing the
  // promise means one failure produces one answer, and every caller holding
  // that answer gets it.
  draining ??= (async () => {
    const results = await Promise.allSettled([...inFlight])
    const failed = failedEdit || results.some(result => result.status === 'rejected')
    failedEdit = false
    return failed ? 'failed' as const : 'settled' as const
  })()
  const drain = draining
  // Released once it settles, so the NEXT tap gets a fresh look rather than
  // this one's cached verdict — which is the whole of "refuse once".
  void drain.then(() => { if (draining === drain) draining = null },
    () => { if (draining === drain) draining = null })
  return drain
}

/** @see writeSet — this is that, with the write registered so Finish can wait
 *  for it. The caller still gets the real promise, refusals and all. */
export const adjustSet = (
  repo: Repo,
  setId: string,
  delta: SetAdjustment,
): Promise<'written' | 'gone' | 'closed'> => {
  const write = writeSet(repo, setId, delta)
  inFlight.add(write)
  // Both arms, so a rejected write is counted as handled here and its failure
  // still reaches `setEditsSettled` — through `allSettled` while it is running,
  // and through the sticky flag once it is not.
  write.then(
    () => inFlight.delete(write),
    () => { inFlight.delete(write); failedEdit = true },
  )
  return write
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
  /** A set or a lift is sitting somewhere `buildHistory` cannot read it —
   *  indented under a note, or under another set. Writes nothing. */
  | 'misfiled'
  /** The workout's `strength:date` is missing or unreadable, so nothing can
   *  file it on a training day. Writes nothing. */
  | 'undated'
  /** A set edit was still in flight and did not land, so closing now would
   *  record a number you had already replaced. Writes nothing. */
  | 'edit-failed'

/** Anything typed as a set or a lift that is NOT in the one position history
 *  can read it from.
 *
 *  `buildHistory` groups sets by their DIRECT parent entry and entries by
 *  their direct parent workout — it is handed flat rows and cannot walk
 *  through a note block it never queried. So descending here, as an earlier
 *  round did, bought nothing but a disagreement: Finish counted a nested set
 *  and reported the session recorded, while progression never saw it. Both
 *  readers use the same rule now, and anything outside it is reported rather
 *  than silently left out of your training history. */
const misfiled = async (tx: Tx, workoutId: string): Promise<BlockData[]> => {
  const found: BlockData[] = []
  // Every reachable block, not the first few levels: a depth cutoff let a set
  // nested deeper than it through, which is precisely the corruption this
  // guard exists to stop. A visited set is what keeps hand-edited parentage
  // from looping, and it does that without deciding how deep is too deep.
  const seen = new Set<string>([workoutId])
  // The canonical shape stated as the rule the readers use, not as a DEPTH.
  // An entry is a direct child of the workout; a set is a direct child of one
  // of those entries. Depth was a proxy for that, and it was the wrong one:
  // `workout → note → set` puts a set at depth 1 with an untyped block in
  // between, so the guard called it filed while `setsOf` — which descends
  // only into typed entries — could not reach it. Finish then closed around a
  // set that never entered history and kept its checkbox.
  const walk = async (parentId: string, parentIsEntry: boolean): Promise<void> => {
    for (const child of await tx.childrenOf(parentId, undefined, {hidePropertyChildren: true})) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      if (child.deleted) continue
      // Another workout ENDS this scan's territory. Run the shortcut while
      // pointing at last week's unfinished session and the new one is stamped
      // as its child — that is the placement contract, and it is a session in
      // its own right, not a stray. `buildHistory` files its entries under IT,
      // so they are canonical where it counts; descending here called them
      // misfiled against the outer record and left the outer session
      // permanently unfinishable, under a message about outdenting sets that
      // describes nothing that is wrong.
      if (hasBlockType(child, WORKOUT_TYPE)) continue
      const entryHere = parentId === workoutId && hasBlockType(child, EXERCISE_ENTRY_TYPE)
      const setHere = parentIsEntry && hasBlockType(child, SET_TYPE)
      if (!entryHere && !setHere
        && (hasBlockType(child, SET_TYPE) || hasBlockType(child, EXERCISE_ENTRY_TYPE))) {
        found.push(child)
      }
      await walk(child.id, entryHere)
    }
  }
  await walk(workoutId, false)
  return found
}

/** Every set block under a workout, with the entry it belongs to — direct
 *  children at both levels, the same rule `buildHistory` reads by. */
const setsOf = async (
  tx: Tx,
  workoutId: string,
): Promise<{entry: BlockData; sets: BlockData[]}[]> => {
  const out: {entry: BlockData; sets: BlockData[]}[] = []
  for (const entry of await tx.childrenOf(workoutId, undefined, {hidePropertyChildren: true})) {
    if (!hasBlockType(entry, EXERCISE_ENTRY_TYPE)) continue
    const sets = (await tx.childrenOf(entry.id, undefined, {hidePropertyChildren: true}))
      .filter(child => !child.deleted && hasBlockType(child, SET_TYPE))
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

/** Every reason Finish would refuse, asked in the order it asks them.
 *
 *  Split out so the same questions can be asked WITHOUT writing — see
 *  `finishBlocker`. One implementation, because a second one drifts and the
 *  drift shows up as a caller preparing for a finish that then refuses.
 *
 *  Hands back the tree it read when there is nothing in the way, so the
 *  transaction that goes on to write does not walk it twice.
 */
type FinishCheck =
  | {blocked: FinishOutcome}
  | {blocked: null; workout: BlockData; tree: {entry: BlockData; sets: BlockData[]}[]}

const checkFinishable = async (
  tx: Tx,
  workoutId: string,
  expectedDate?: unknown,
): Promise<FinishCheck> => {
  // Read here rather than trusted from the caller: another client can close
  // this workout between the tap and this transaction opening.
  const workout = await tx.get(workoutId)
  if (!workout || workout.deleted) return {blocked: 'gone'}
  if (workout.properties[FIELD.status] !== 'in-progress') return {blocked: 'gone'}

  // Checked before anything is written: closing around a set history cannot
  // read would report the session recorded while progression never sees the
  // work.
  if (expectedDate !== undefined && workout.properties[FIELD.date] !== expectedDate) {
    return {blocked: 'undated'}
  }

  if ((await misfiled(tx, workoutId)).length > 0) return {blocked: 'misfiled'}

  const tree = await setsOf(tx, workoutId)
  // Counted before anything is written, so the refusal below leaves the
  // session exactly as it was rather than half-closed.
  const logged = tree.reduce((n, {sets}) => n + sets.filter(isDone).length, 0)
  if (logged === 0) return {blocked: 'nothing-logged'}

  return {blocked: null, workout, tree}
}

/** Would Finish refuse, and why — without writing anything.
 *
 *  For the one caller that has to WRITE something before it can finish (the
 *  layoff record needs a page to live on, and that page may not exist yet).
 *  Bootstrapping it eagerly left a Strength Log page behind every time Finish
 *  went on to refuse, on paths documented as writing nothing.
 *
 *  Advisory, never authoritative: `finishSession` asks the same questions
 *  again inside its own transaction, which is the answer that counts.
 */
export const finishBlocker = async (
  repo: Repo,
  workoutId: string,
  expectedDate?: unknown,
): Promise<FinishOutcome | null> =>
  // A transaction that writes nothing costs nothing — `repo.tx` pins no
  // workspace and records no undo entry for one — and it is the only way to
  // reach `misfiled`/`setsOf`, which read through `tx.childrenOf`.
  repo.tx(
    async tx => (await checkFinishable(tx, workoutId, expectedDate)).blocked,
    {scope: ChangeScope.BlockDefault, description: 'Check whether the session can be finished'},
  )

/** Close the session.
 *
 *  Nothing is deleted and nothing is untagged. A set you did not do stays a
 *  `strength-set` and stays a todo, recording what was prescribed and not
 *  performed; done-ness is the `status` property, which is what history reads.
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
  layoff?: {pageId: string; record: Omit<LayoffRecord, 'id'>; knownIds?: readonly string[]},
  /** The RAW `strength:date` the caller validated and computed the layoff
   *  against. Re-checked inside the transaction, because it is a hand-editable
   *  property and the caller's read is several awaits old: cleared in that
   *  window the workout closes and `buildHistory` drops it whole, and changed
   *  to another valid day it closes with a layoff measured to the old one.
   *
   *  The raw value, deliberately, not a decoded day. Decoding on both sides
   *  invites the two decoders to disagree — and they did: the caller used
   *  `trainingDay` (which shifts back by `rolloverHour`) while this compared
   *  `dateToDay` (which does not), so any rollover past 12 moved the caller's
   *  answer to the previous day and made EVERY workout permanently
   *  unfinishable. Comparing the stored string needs no decoder at all, and
   *  catches any change including ones a decoder would round away. */
  expectedDate?: unknown,
): Promise<FinishOutcome> => {
  const typeSnapshot = repo.snapshotTypeRegistries()
  return repo.tx(async tx => {
    // Asked again HERE, inside the transaction that writes — a caller's read
    // is several awaits old and a peer can close, misfile or untick in that
    // window. This is the answer that counts.
    const check = await checkFinishable(tx, workoutId, expectedDate)
    if (check.blocked !== null) return check.blocked
    const {workout, tree} = check

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
        // A finished set stays a todo. Finish used to strip TODO_TYPE from
        // every set to stop a stray tap unticking a closed record — but a type
        // is not ours to take away on the user's behalf: it is what makes the
        // block answer to every other todo query and view in the app, so
        // removing it retroactively deletes these sets from the user's todo
        // world to protect an invariant of ours. Unticking a set of a closed
        // session is an ordinary outline edit that says "I did not do that
        // one", and `buildHistory` reading it back is the correct answer, not
        // corruption.
      }
      // Denormalised so "last working weight for lift X" stays a flat scan.
      // Written from what was actually performed, by the same function
      // progression judges with — not from what was prescribed.
      const weight = workingWeight({exercise: '', sets: sets.filter(isDone).map(setRecord)})
      if (weight !== undefined) await tx.setProperty(entry.id, workingWeightProp, weight)
    }

    if (layoff) {
      await writeLayoffInTx(repo, tx, workout.workspaceId, layoff.pageId, layoff.record,
        typeSnapshot, layoff.knownIds ?? [])
    }
    await tx.setProperty(workoutId, statusProp, 'done')
    return 'done' as const
  }, {scope: ChangeScope.BlockDefault, description: 'Finish session'})
}
