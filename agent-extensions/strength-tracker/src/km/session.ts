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
 *  A tap therefore either STARTS tonight's session or hands back the one
 *  already under way. It never writes into an existing session, and that is
 *  the whole of the idempotency: the second tap is a no-op, so there is
 *  nothing to reconcile, no entry to match against a plan row, and no set
 *  position to re-find.
 *
 *  Records here carry ordinary minted ids. Nothing looks a workout, lift or
 *  set up BY id — every reader scans by type — so a derived id would buy only
 *  offline convergence, at the price of handling an occupied seat at three
 *  levels. `store.ts` (layoff) and `page.ts` (settings) keep theirs, on the
 *  bar that decides it: a duplicate there is silent and permanent, where a
 *  duplicate session is visible and Discard removes it.
 */

import {ChangeScope, propertyValue, type BlockData, type Tx} from '@/data/api/index.js'
import {deleteBlock} from '@/data/mutators.js'
import {hasBlockType} from '@/data/properties.js'
import type {Repo} from '@/data/repo.js'
import {createTypedChild} from '@/data/typedRecords.js'
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
import {writeLayoffInTx} from './store'
import {countLoggedSets} from './subtree'
import type {PlannedLift, PlannedSet, SessionPlan} from './sessionPlan'
import {
  catchUpRpeProp,
  completedAtProp,
  dateProp,
  definitionProp,
  finishedAtProp,
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

/** Is a session already under way on this training day — whatever its SESSION
 *  type (A / B / mini).
 *
 *  The one question a tap asks before writing anything, and the same one
 *  `standingSession` asks before the dialog opens. Stated once, because two
 *  implementations of "am I already in a session" is how a tap navigates to
 *  one session and starts another.
 *
 *  ANY session type: a peer's Session B is a session under way while you
 *  configure Session A, and starting an A beside it leaves two live workouts
 *  for one day — which every later Start walks past, continuing only the newest.
 *
 *  The block TYPE is required, unlike the settings block, which tolerates a
 *  missing tag (`page.ts` says why). The difference is that a workout has no
 *  id-based lookup: every scan feeding this queries BY type, so tolerating an
 *  untagged block would only ever reach one filed under the parent being
 *  stamped into. Every other reader gates on the tag too, so removing it takes
 *  a block out of the strength world entirely. */
const isStandingToday = (block: BlockData, day: string): boolean =>
  hasBlockType(block, WORKOUT_TYPE)
  && block.properties[FIELD.status] === 'in-progress'
  && liveDay(block.properties[FIELD.date]) === day

/** Which of several live sessions a tap continues: the most recently STARTED.
 *
 *  Two can look live at once while a peer's `done` update is in flight, and an
 *  id has nothing to do with chronology — taking the lowest could send you to
 *  the session you already finished (whose checkboxes are deliberately still
 *  live) and log tonight's work into last night's record.
 *
 *  Id breaks the tie so every device names the same one. Pure, because that
 *  tie-break is otherwise untestable: the query returns rows in an order that
 *  gives the same answer whether the clause is there or not.
 *
 *  Lives beside the stamp rather than in `tonight.ts`, so the pre-dialog check
 *  and the transaction cannot disagree about which session you are in. */
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
 *  using its `orderKey`, so that slot is free — which lands the session where
 *  the cursor was rather than merely on the same parent. See `placement.ts`
 *  for why this is a move afterwards and not an anchored insert. */
export const takePlaceOf = async (
  repo: Repo,
  workoutId: string,
  placement: {parentId: string; replaces?: {id: string; orderKey: string}},
  /** Whether THIS call is the one that created the session — `startSession`'s
   *  `stamped`. Sharing a parent is not ownership: a peer that won the start
   *  race and filed its workout under the same page passed the parent check,
   *  so the line's slot was applied to somebody else's session, reordering it
   *  for a placement this call never made. */
  placedByUs = true,
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

    // Only when the session actually landed where we asked. A session handed
    // back rather than created can live anywhere, and dragging it out of there
    // because you ran this on an empty line is a move nobody asked for.
    //
    // `placedByUs` first: parentage alone answers wrong for a peer's session
    // filed under the same page. It stays as the secondary check, since one we
    // created but that has since MOVED is no longer ours to slot either. Read
    // in-transaction, like the line above, so a concurrent filing gesture is
    // not undone from a stale load.
    const workout = await tx.get(workoutId)
    const mine = placedByUs && workout !== null && !workout.deleted
      && workout.parentId === placement.parentId
    if (mine) {
      // `line.orderKey`, not the snapshot's: another pane can reorder the
      // still-empty line under the same parent while the dialog sits open, and
      // the pre-dialog key then names a slot it has left — putting the session
      // somewhere it never was, possibly across unrelated siblings, before
      // deleting the line from where it actually is.
      await tx.move(workoutId, {parentId: placement.parentId, orderKey: line.orderKey})
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

/** Stamp tonight's session into `parentId`, or hand back the one already
 *  under way for this training day.
 *
 *  Idempotent by refusing to write rather than by converging on what it would
 *  have written: a second call finds the standing session and returns it
 *  untouched. Every logged value therefore survives trivially — there is no
 *  path on which a tap edits a session that already exists.
 *
 *  A workout already `done` is not standing, so "I did session A twice today"
 *  stays representable: Finish the first and the next tap starts a second.
 */
export interface StartedSession {
  id: string
  /** Whether THIS call created it.
   *
   *  `false` means a session already under way was handed back untouched — the
   *  lifts you picked are not in it. The caller needs to know, because the
   *  things it does AFTER a start are all conditional on the start having
   *  happened: recording an `or`-group choice says "this is the variant I am
   *  now tracking", and recording it off a session that never got the pick
   *  changes what future sessions prescribe on the strength of a race you lost
   *  and were never told about. */
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
   *  a page looks like. */
  position: {kind: 'first'} | {kind: 'last'} = {kind: 'first'},
): Promise<StartedSession> => {
  const typeSnapshot = repo.snapshotTypeRegistries()
  // Workspace-wide, like the readers: a page-children scan would miss a session
  // filed under a year heading. Narrowed to today HERE, on rows already loaded,
  // so the in-transaction re-reads below are bounded by the handful that could
  // be tonight — those `tx.get`s hold the write lock.
  const known = (await repo.query.typedBlocks({workspaceId, types: [WORKOUT_TYPE]}).load())
    .filter((row: BlockData) => isStandingToday(row, plan.day))
    .map((row: BlockData) => row.id)

  return repo.tx(async tx => {
    // Two populations, because neither alone is the answer: the workspace-wide
    // list is what finds a session filed somewhere this tap would never look,
    // and `parentId`'s children are what a session created microseconds ago —
    // too recently for the query above to have seen it — is guaranteed to be
    // among when the two taps stamp into the same place.
    const seen = new Map<string, BlockData>()
    for (const block of await tx.childrenOf(parentId, undefined, {hidePropertyChildren: true})) {
      seen.set(block.id, block)
    }
    for (const id of known) {
      if (seen.has(id)) continue
      const block = await tx.get(id)
      if (block) seen.set(id, block)
    }

    // Asked FIRST, before a single write, and the answer that counts: the
    // caller's pre-dialog check is a separate operation, and a peer's create
    // can land in between — it need not even be a race, since an offline
    // device's row applies whenever it syncs. Stamping the confirmed plan into
    // a session somebody else configured would add this device's `or`-group
    // pick beside theirs, and Finish would record both.
    const standing = mostRecentlyStarted(
      [...seen.values()].filter(block => !block.deleted && isStandingToday(block, plan.day)),
    )
    if (standing !== null) return {id: standing, stamped: false}

    const workoutId = await createTypedChild(repo, tx, {
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
    })

    for (const lift of plan.lifts) {
      const entryId = await createTypedChild(repo, tx, entrySpec(workoutId, lift, typeSnapshot))
      for (const set of lift.sets) {
        await createTypedChild(repo, tx, setSpec(entryId, set, lift.unit, typeSnapshot))
      }
    }
    return {id: workoutId, stamped: true}
  }, {scope: ChangeScope.BlockDefault, description: `Start ${sessionLabel(plan.session)}`})
}

// ──── editing a set ────

const numberAt = (block: BlockData, field: string, fallback: number): number =>
  typeof block.properties[field] === 'number' ? block.properties[field] as number : fallback

/** Load steps in the unit the set records. Deliberately not the plan's
 *  `roundTo`: this is a thumb correcting a number under a bar, and a plate you
 *  can actually add is the useful increment. */
export const weightStep = (unit: string): number => (unit === 'kg' ? 2.5 : 5)

export interface SetAdjustment {
  weight?: number
  reps?: number
  /** ± one plate, sized HERE rather than by the caller, because only this side
   *  can resolve the unit: `strength:unit` has a schema default of `lb`, so a
   *  set that predates the unit living on the set reads back as `lb` in the UI
   *  however the workout is actually kept — a 5 lb step applied to a row this
   *  same call goes on to write as kg. */
  weightSteps?: number
  set?: {weight?: number; reps?: number; rpe?: number | null}
}

/** Nudge what a set says you lifted, by a DELTA rather than to a value.
 *
 *  Deltas because the caller is a thumb on a ± button reading a render. Two
 *  taps before the first write lands both compute `135 + 5`, so dialling 135
 *  up to 185 quickly loses increments — and that number is what the whole
 *  progression engine reads. Resolved against the row inside the transaction,
 *  a tap cannot be lost whatever the render was showing.
 *
 *  Properties and content move in ONE transaction: the engine reads
 *  `strength:weight`/`strength:reps` and the outline shows the text, so a
 *  reader trusting one while progression trusts the other trains off the
 *  wrong numbers.
 */
const writeSet = async (
  repo: Repo,
  setId: string,
  /** A relative nudge, or — for `set` — an outright value. `set` exists for
   *  typing a starting weight (a lift with no history stamps at 0, and
   *  dialling to 135 with a ± button is 27 taps), and is a separate field so
   *  the delta path cannot be handed an absolute and lose a tap.
   *
   *  `set.rpe` has no delta form: an RPE is a judgement about the set you just
   *  did, not a number dialled up from the last one. `null` clears it, because
   *  an ABSENT rpe is load-bearing — it is what stops the catch-up jump firing
   *  on evidence never given. */
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

    // A closed session is a record, not a form: one stray tap would rewrite
    // the baseline the next prescription derives from, and leave the stamped
    // working weight disagreeing with its own sets.
    if (workout && workout.properties[FIELD.status] === 'done') return 'closed' as const

    // Older sets carry no `strength:unit` (it lived on the entry), so reading
    // the set alone would rewrite "185lb × 5" as "185 × 5" — stripping the unit
    // from a record meant to stay readable without the extension. Resolved
    // BEFORE the weight, since it sizes a `weightSteps` nudge.
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
    // We only own the text we wrote. The set line is editable, so "185lb × 5 —
    // felt easy" is something you can legitimately have typed; rewriting that
    // from the properties would throw away the note. Left alone once it stops
    // being machine-shaped — the properties still move, so ± still works.
    if (block.content === shape(previousWeight, previousReps)) {
      await tx.update(setId, {content: shape(weight, reps)})
    }
    return 'written' as const
  }, {scope: ChangeScope.BlockDefault, description: 'Adjust set'})

/** Set edits started and not yet landed.
 *
 *  Finish is one tap away from a blur, and nothing awaits the blur's write:
 *  the field commits on mousedown, the button on mouseup, as independent
 *  transactions. Lose that race and the session closes around the OLD number
 *  while the edit refuses as `closed` — telling you to reopen a session
 *  nothing here can reopen.
 *
 *  Module-level rather than threaded through React: `SetLine` writes and
 *  `WorkoutFooter` (anywhere in the tree) must not overtake it. */
const inFlight = new Set<Promise<unknown>>()

/** A set edit that rejected and has not been superseded.
 *
 *  `inFlight` alone only catches a write still RUNNING at Finish. Lose the
 *  other way — the write rejects between mousedown and mouseup — and the set
 *  is empty again by the time Finish looks, so it closes around the old number
 *  while `SetLine` shows "could not save that". So a failure outlives its
 *  promise. */
const failedEdits = new Set<string>()

/** The workout a set belongs to, walked the way `writeSet` walks it and
 *  without a transaction — a set can be tabbed under its neighbour or
 *  outdented, so the parent is not where a fixed hop would look. `null` when
 *  the chain runs out, which is what a deleted set gives. */
const workoutOf = async (repo: Repo, setId: string): Promise<string | null> => {
  const seen = new Set<string>([setId])
  let current = await repo.load(setId)
  while (current?.parentId && !seen.has(current.parentId)) {
    seen.add(current.parentId)
    current = await repo.load(current.parentId)
    if (!current || current.deleted) return null
    if (hasBlockType(current, WORKOUT_TYPE)) return current.id
  }
  return null
}

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
const draining = new Map<string, Promise<'settled' | 'failed'>>()

export const setEditsSettled = (
  repo: Repo,
  /** The session being closed. A failure belongs to the workout whose set it
   *  was, and nothing else: two in-progress workouts is a supported state
   *  (nesting makes one, a peer makes the other), and a module-wide flag let
   *  finishing B consume A's failure — B got a refusal about a set it does not
   *  own, and A then closed around the stale value with nothing left to warn
   *  it. */
  workoutId: string,
): Promise<'settled' | 'failed'> => {
  // One drain PER WORKOUT, shared by everyone asking about that one while it
  // runs. Consuming the failure is what makes the refusal happen once — but
  // two Finish taps that OVERLAP (the same workout in two panels, say) both
  // awaited, both resumed, and only the first saw it: the second read state
  // the first had just cleared and closed around the unsaved number. Keyed,
  // because the answer is no longer the same for every session.
  const existing = draining.get(workoutId)
  if (existing !== undefined) return existing

  const drain = (async () => {
    // Waited on for its own sake — an edit still running has to land before
    // anything reads the tree. The VERDICT comes from `failedEdits`, which is
    // scoped to a workout; a rejected write is added there by the handler
    // `adjustSet` attached before `allSettled` attached its own, so every
    // rejection among these is recorded by the time this resumes.
    await Promise.allSettled([...inFlight])

    const mine: string[] = []
    for (const setId of [...failedEdits]) {
      // Resolved now rather than recorded at write time: a rejected write may
      // never have reached the point where it knew its own workout, and the
      // set is still in the tree to be walked from here.
      const owner = await workoutOf(repo, setId)
      // A set that resolves to no workout is forgotten. HOUSEKEEPING only,
      // and mutation-tested as such: the verdict already requires
      // `owner === workoutId`, so an unresolvable entry could never refuse
      // anything whether it is dropped or not. Dropping it just stops the set
      // growing without bound and stops every later Finish re-walking it.
      if (owner === null) failedEdits.delete(setId)
      else if (owner === workoutId) mine.push(setId)
    }
    for (const setId of mine) failedEdits.delete(setId)
    return mine.length > 0 ? 'failed' as const : 'settled' as const
  })()

  draining.set(workoutId, drain)
  // Released once it settles, so the NEXT tap gets a fresh look rather than
  // this one's cached verdict — which is the whole of "refuse once".
  const release = () => { if (draining.get(workoutId) === drain) draining.delete(workoutId) }
  void drain.then(release, release)
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
    () => { inFlight.delete(write); failedEdits.add(setId) },
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
   *  against, re-checked in-transaction: it is hand-editable and the caller's
   *  read is several awaits old, so a clear makes `buildHistory` drop the
   *  session whole and a change files the layoff against the wrong day.
   *
   *  The raw value, not a decoded day: decoding on both sides let the two
   *  decoders disagree (`trainingDay` shifts by `rolloverHour`, `dateToDay`
   *  does not), which made every workout permanently unfinishable at any
   *  rollover past 12. Comparing the stored string needs no decoder. */
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
    // On the WORKOUT too, not only on the sets. The set-derived ordering
    // stamp empties out under an ordinary correction — untick what Finish
    // stamped, tick a set you had skipped, and every done set is left without
    // a `completedAt`, because the native checkbox writes only `status`. Two
    // same-day sessions then compare as incomparable and query order picks the
    // progression baseline. See `finishedAtProp`.
    await tx.setProperty(workoutId, finishedAtProp, finishedAt)

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
      //
      // A SNAPSHOT taken at Finish, not a maintained cache — and it cannot be
      // one: unticking a set of a closed session is a supported correction
      // (that is the whole of the undo), the tick is the todo plugin's own
      // write with no hook of ours on it, and `buildHistory` recomputes from
      // the sets the moment it changes. So an untick leaves this value behind.
      // Nothing in the extension reads it — progression and every view compute
      // `workingWeight(entry)` from the sets — so it can mislead a hand-written
      // SQL query and nothing else. The README's example reads the sets.
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
