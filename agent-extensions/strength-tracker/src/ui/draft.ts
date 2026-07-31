/** Logging draft — the editing model for tonight's session, pure and
 *  UI-independent. Built from the prescription (every set pre-filled, so
 *  accepting as-prescribed is one tap), then *overlaid* with the live
 *  in-progress workout block when one exists, so the block is the source of
 *  truth and each set carries its block id for in-place edits. */

import type {AltOption, ExerciseVideo, Prescription, PrescribedExercise} from '../engine/types'
import {liftKey, matchLiveExercises} from '../km/history'
import type {LiftRef, LiveExercise, LiveSet, LiveWorkout} from '../km/history'
import type {ExerciseDraft, SetDraft, WorkoutDraft} from '../km/store'

export interface DraftSet {
  weight: number
  reps: number
  /** Accepted — only accepted sets are written / counted. */
  done: boolean
  /** Epoch ms the set was marked done (cleared when un-done). */
  completedAt?: number
  rpe?: number
  side?: 'L' | 'R'
  /** The set block once the workout is materialized; undefined while the
   *  draft is still ephemeral (before the first edit). */
  blockId?: string
}

export interface DraftExercise {
  exercise: string
  /** Plan block behind this row (see `PrescribedExercise.defId`). */
  defId?: string
  /** Which row of THIS lift the session is on — 0 unless the plan prescribes
   *  the same lift twice. Counted once, in `buildDraft`, and carried from
   *  here into the block-id derivation, the live-block match, and the
   *  in-flight bookkeeping — never recounted from a different array. */
  occurrence: number
  unit: string
  freeform: boolean
  perSide: boolean
  repMin?: number
  repMax?: number
  prescribedWeight?: number
  prescribedSets?: number
  rationale: string
  note?: string
  videos?: readonly ExerciseVideo[]
  /** Set when this exercise is the chosen option of a plan `or`-group, so the
   *  UI can offer a switch to the other options. */
  altGroupKey?: string
  altOptions?: readonly AltOption[]
  sets: DraftSet[]
  /** The exercise entry block once materialized. */
  blockId?: string
}

/** Reps to pre-fill a set with: aim for the top of the range (that's what
 *  earns the next jump); fall back to last time's reps for freeform work,
 *  else the bottom of the range, else blank-ish. */
const defaultReps = (ex: PrescribedExercise): number => {
  if (ex.repMax !== undefined) return ex.repMax
  const lastReps = ex.lastTime?.reps
  if (lastReps && lastReps.length > 0) return lastReps[0]
  return ex.repMin ?? 0
}

const initialSets = (ex: PrescribedExercise): DraftSet[] => {
  const weight = ex.weight ?? 0
  const reps = defaultReps(ex)
  const n = Math.max(1, ex.sets)
  if (ex.perSide) {
    return Array.from({length: n}).flatMap(() => [
      {weight, reps, done: false, side: 'L' as const},
      {weight, reps, done: false, side: 'R' as const},
    ])
  }
  return Array.from({length: n}, () => ({weight, reps, done: false}))
}

export const buildDraft = (prescription: Prescription, unit: string): DraftExercise[] => {
  // The ONE place a lift's occurrence within the session is counted.
  const seen = new Map<string, number>()
  return prescription.exercises.map(ex => {
    const base = ex.defId ?? ex.exercise
    const occurrence = seen.get(base) ?? 0
    seen.set(base, occurrence + 1)
    return {
      exercise: ex.exercise,
      defId: ex.defId,
      occurrence,
      unit,
      freeform: ex.freeform,
      perSide: ex.perSide,
      repMin: ex.repMin,
      repMax: ex.repMax,
      prescribedWeight: ex.weight,
      prescribedSets: ex.sets,
      rationale: ex.rationale,
      note: ex.note,
      videos: ex.videos,
      altGroupKey: ex.altGroupKey,
      altOptions: ex.altOptions,
      sets: initialSets(ex),
    }
  })
}

/** What the coordinator watches to know the session's LIFTS changed — a plan
 *  edit, an `or`-group switched — as distinct from a value moving. JSON, not
 *  a joined string: exercise names are user text, so a joined encoding lets
 *  one lift called `Bench:100:3:5-5:false,Squat` spell two rows — reading as
 *  one shape would skip the generation bump and cache clear. */
export const prescriptionShape = (exercises: readonly PrescribedExercise[]): string =>
  JSON.stringify(exercises.map(
    e => [e.defId ?? e.exercise, e.weight ?? null, e.sets, e.repMin ?? null, e.repMax ?? null, e.perSide],
  ))

/** This row's identity — stable across a re-prescription, a rename, and every
 *  query emission, because it's the same thing the row's blocks derive from.
 *  Row POSITION is not identity: a plan edit can reorder rows, and keying on
 *  the index would make a switched-in lift adopt its neighbour's in-flight
 *  create. */
export const rowKey = (ex: Pick<DraftExercise, 'exercise' | 'defId' | 'occurrence'>): string =>
  liftKey(ex.defId, ex.exercise, ex.occurrence)

/** This row as the block readers name a lift — the draft calls its plan block
 *  `defId`, a logged entry calls it `definitionId`. */
export const liftRef = (ex: Pick<DraftExercise, 'exercise' | 'defId' | 'occurrence'>): LiftRef =>
  ({definitionId: ex.defId, exercise: ex.exercise, occurrence: ex.occurrence})

/** Identity of one set row. Sets are positional within their lift — including
 *  the L/R rows of a per-side lift, which alternate — so the index IS the
 *  identity here, exactly as it is in the derived set-block id. */
export const setKey = (
  ex: Pick<DraftExercise, 'exercise' | 'defId' | 'occurrence'>,
  setIdx: number,
): string => `${rowKey(ex)}|${setIdx}`

const fromLiveSet = (s: LiveSet): DraftSet => ({
  weight: s.weight,
  reps: s.reps,
  done: s.done,
  ...(s.rpe !== undefined ? {rpe: s.rpe} : {}),
  ...(s.side !== undefined ? {side: s.side} : {}),
  ...(s.completedAt !== undefined ? {completedAt: s.completedAt} : {}),
  blockId: s.id,
})

const sameSet = (a: DraftSet, b: DraftSet): boolean =>
  a.weight === b.weight
  && a.reps === b.reps
  && a.done === b.done
  && a.rpe === b.rpe
  && a.side === b.side
  && a.completedAt === b.completedAt
  && a.blockId === b.blockId

/** Field-wise, over whatever keys the row has, rather than a hand-written
 *  list: an enumerated list would silently stop noticing a field the moment
 *  one is added, and under-reporting a change shows stale data — the unsafe
 *  direction to be wrong in. Array-valued metadata compares by reference,
 *  stable because the prescription it comes from is memoized. */
const sameRow = (a: DraftExercise, b: DraftExercise): boolean => {
  // Over the UNION of both key sets, so a field absent on one side and
  // present-but-undefined on the other still compares equal — exactly the
  // `blockId` of a fresh row from `buildDraft` vs. one seen here before.
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof DraftExercise>) {
    if (key === 'sets') continue
    if (a[key] !== b[key]) return false
  }
  return a.sets.length === b.sets.length && a.sets.every((s, i) => sameSet(s, b.sets[i]))
}

/** The largest slot a stored index is allowed to claim — not a limit on
 *  logging, just a cap so a hand-edited number can't render an unbounded list. */
const MAX_SETS_PER_LIFT = 64

/** A set slot the prescription does not reach — shaped like the row's
 *  prescribed sets (L/R alternation included) so it's editable and logs like
 *  any other. Never marked done: Finish prunes it if nothing is performed. */
const blankSet = (row: DraftExercise, index: number): DraftSet => ({
  weight: row.prescribedWeight ?? 0,
  reps: row.repMax ?? row.repMin ?? 0,
  done: false,
  ...(row.perSide ? {side: index % 2 === 0 ? ('L' as const) : ('R' as const)} : {}),
})

const mergeSets = (
  row: DraftExercise,
  live: LiveExercise | undefined,
  previous: DraftExercise | undefined,
  writing: ReadonlySet<string>,
  /** The workout is on screen with no entry for this lift, so it's gone
   *  rather than late — its sets went with it (deleting a block takes its subtree). */
  entryGone: boolean,
  /** The blocks behind `live` have answered at least once. */
  loaded: boolean,
): DraftSet[] => {
  const liveSets = live?.sets ?? []
  // Does the live workout have anything to SAY about this lift's sets? Once
  // the queries have ANSWERED, yes — even an entry listing no sets is
  // authoritative; before that, absence is silence. `[]` can't tell the two
  // apart on its own, so the signal comes from the query, not its result.
  const liveIsAuthoritative = entryGone || (loaded && live !== undefined)

  // `live.sets` is a COMPACTED list, so position isn't the set's index once
  // one has been deleted — the block says which set it is (`FIELD.setIndex`)
  // instead, falling back to position only for sets written before that
  // property existed. The index is hand-editable, so it sizes the draft only
  // when plausible.
  const plausible = (set: LiveSet): number | undefined =>
    set.index !== undefined
      && Number.isSafeInteger(set.index) && set.index >= 0 && set.index < MAX_SETS_PER_LIFT
      ? set.index
      : undefined

  // Two sets claiming one slot means neither claim can be believed, so BOTH
  // fall back — letting the first keep the slot would swap them instead,
  // sending every later edit to the wrong set's block.
  const claims = new Map<number, number>()
  for (const set of liveSets) {
    const slot = plausible(set)
    if (slot !== undefined) claims.set(slot, (claims.get(slot) ?? 0) + 1)
  }

  const bySlot = new Map<number, LiveSet>()
  const unplaced: LiveSet[] = []
  for (const set of liveSets) {
    const slot = plausible(set)
    if (slot !== undefined && claims.get(slot) === 1) bySlot.set(slot, set)
    else unplaced.push(set)
  }
  let unplacedAt = 0

  // The highest CLAIMED slot, not `liveSets.length`: once the list is sparse,
  // sizing by length would drop a set past a gap off the end.
  const highest = [...bySlot.keys()].reduce((max, slot) => Math.max(max, slot), -1)
  const count = Math.max(row.sets.length, liveSets.length, highest + 1)

  const sets: DraftSet[] = []
  for (let i = 0; i < count; i += 1) {
    const previousSet = previous?.sets[i]
    const liveSet = bySlot.get(i) ?? (unplacedAt < unplaced.length ? unplaced[unplacedAt++] : undefined)
    // A write is in flight for this set: the block is momentarily BEHIND what
    // the user just did, so letting it win would revert their own tap.
    if (previousSet && writing.has(setKey(row, i))) {
      sets.push(liveSet && previousSet.blockId === undefined
        ? {...previousSet, blockId: liveSet.id}
        : previousSet)
      continue
    }
    if (liveSet) {
      sets.push(fromLiveSet(liveSet))
      continue
    }
    // We created this block ourselves and the query hasn't caught up —
    // keeping it lets this whole function run unconditionally.
    if (!liveIsAuthoritative && previousSet?.blockId !== undefined) {
      sets.push(previousSet)
      continue
    }
    // `?? blankSet` — a slot past the end of the prescription, because a
    // HIGHER index is live (the plan was shortened, or a set was deleted).
    // `row.sets[i]` alone would push `undefined` into the draft.
    sets.push(row.sets[i] ?? blankSet(row, i))
  }
  return sets
}

/** The draft the view renders: tonight's prescription, with the live blocks
 *  laid over it. Non-destructive: takes what's on screen as an input rather
 *  than replacing it, so it can run unconditionally on every query emission.
 *  Precedence, per set:
 *
 *    1. a write in flight — the block is behind, not ahead
 *    2. the block, whenever there is one
 *    3. what is on screen, if it already has a block id — our own create,
 *       one query behind
 *    4. the prescription's pre-filled value
 *
 *  Rows are matched by `rowKey`; a live entry with no row (an `or`-group
 *  option switched away from) is deliberately absent — Finish reads the
 *  committed tree, not this draft.
 *
 *  `previous` is what's on screen NOW; the caller must not pass it across a
 *  session switch or a just-finished workout — Rule 3 can't tell "our
 *  create, one query behind" from "that workout is over".
 *
 *  Returns `previous` unchanged when nothing moved (one comparison pass, no
 *  re-render). Safe to be unconditional only because the draft holds no
 *  uncommitted state — a number being typed lives in the input's own React
 *  state until blur. */
export const overlayLive = (
  base: readonly DraftExercise[],
  live: LiveWorkout | undefined,
  previous: DraftExercise[] = [],
  writing: ReadonlySet<string> = new Set(),
  /** Have the blocks behind `live` answered at least once? Until they have, an
   *  absent workout/entry/set is silence, not news — the three queries
   *  resolve independently, so a workout can arrive before its entries. */
  loaded = true,
): DraftExercise[] => {
  const matches = matchLiveExercises(base.map(liftRef), live?.exercises)
  const previousByKey = new Map(previous.map(ex => [rowKey(ex), ex] as const))

  const next = base.map((row, i) => {
    const liveEntry = matches[i]
    const previousRow = previousByKey.get(rowKey(row))
    // Same rule as for a set, one level up: a workout on screen with no entry
    // for this lift means the entry is GONE, not that a create is still
    // catching up — holding the id would point every later write at a
    // tombstone with no way to recover.
    const entryGone = loaded && live !== undefined && liveEntry === undefined
    const merged: DraftExercise = {
      ...row,
      blockId: liveEntry?.id ?? (entryGone ? undefined : previousRow?.blockId),
      sets: mergeSets(row, liveEntry, previousRow, writing, entryGone, loaded),
    }
    return previousRow && sameRow(merged, previousRow) ? previousRow : merged
  })
  return next.length === previous.length && next.every((row, i) => row === previous[i]) ? previous : next
}

/** One set as the store writes it — the single mapper, since the write path
 *  needs it per set (`writeSet`) and per exercise (`materialize*`). */
export const toSetDraft = (s: DraftSet): SetDraft => ({
  weight: s.weight,
  reps: s.reps,
  done: s.done,
  ...(s.rpe !== undefined ? {rpe: s.rpe} : {}),
  ...(s.side !== undefined ? {side: s.side} : {}),
  ...(s.completedAt !== undefined ? {completedAt: s.completedAt} : {}),
})

export const toExerciseDraft = (ex: DraftExercise): ExerciseDraft => ({
  exercise: ex.exercise,
  definitionId: ex.defId,
  occurrence: ex.occurrence,
  unit: ex.unit,
  prescribedWeight: ex.prescribedWeight,
  prescribedSets: ex.prescribedSets,
  sets: ex.sets.map(toSetDraft),
})

/** The whole draft (every prescribed set, done or not) — what the store
 *  materializes into blocks on the first edit. */
export const toMaterializeDraft = (
  day: string,
  session: Prescription['session'],
  draft: readonly DraftExercise[],
): WorkoutDraft => ({day, session, exercises: draft.map(toExerciseDraft)})

/** True when at least one set anywhere has been accepted — gates "Finish". */
export const hasAcceptedSets = (draft: readonly DraftExercise[]): boolean =>
  draft.some(ex => ex.sets.some(s => s.done))
