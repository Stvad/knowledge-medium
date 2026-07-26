/** Logging draft — the editing model for tonight's session.
 *
 *  Pure and UI-independent. A draft is built from the prescription (every set
 *  pre-filled so accepting as-prescribed is one tap), then *overlaid* with the
 *  live in-progress workout block when one exists — so the block is the source
 *  of truth and each set carries its block id for in-place edits. The mappers
 *  turn a draft into what the store materializes and what "Finish" prunes.
 */

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
   *  the same lift twice.
   *
   *  Counted once, in `buildDraft`, and carried from here into the block-id
   *  derivation, the live-block match and the in-flight bookkeeping. It used
   *  to be recounted at each of those, from a different array each time; two
   *  counts of the same thing is the shape of every bug this row identity
   *  exists to prevent. */
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

/** This row's identity — stable across a re-prescription, a rename, and every
 *  query emission, because it is the same thing the row's blocks are derived
 *  from. Row POSITION is not identity: an `or`-group switch reorders nothing
 *  but a plan edit can, and keying on the index made a switched-in lift adopt
 *  its neighbour's in-flight create. */
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
 *  list: this exists only to decide whether the previous object can be reused,
 *  and an enumerated list silently stops noticing a field the moment one is
 *  added. Over-reporting a change costs a re-render; under-reporting one shows
 *  stale data, so the generic comparison is the safe direction to be wrong in.
 *  Array-valued metadata (`videos`, `altOptions`) compares by reference, which
 *  is stable because the prescription it comes from is memoized. */
const sameRow = (a: DraftExercise, b: DraftExercise): boolean => {
  // Over the UNION of both key sets, so a field that is absent on one side
  // and present-but-undefined on the other still compares equal — which is
  // exactly the `blockId` of a row built by `buildDraft` versus one that has
  // been through here before.
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof DraftExercise>) {
    if (key === 'sets') continue
    if (a[key] !== b[key]) return false
  }
  return a.sets.length === b.sets.length && a.sets.every((s, i) => sameSet(s, b.sets[i]))
}

const mergeSets = (
  row: DraftExercise,
  live: LiveExercise | undefined,
  previous: DraftExercise | undefined,
  writing: ReadonlySet<string>,
): DraftSet[] => {
  // Never fewer rows than either side has. The three block queries behind
  // `live` emit independently, so an entry can legitimately arrive with none
  // of its sets yet; taking the live count verbatim made every set row vanish
  // for a beat mid-session. Live having MORE than the plan prescribes is just
  // as real — a set logged before the plan's set count was edited down.
  const liveSets = live?.sets ?? []
  const count = Math.max(row.sets.length, liveSets.length)
  // Does the live workout have anything to SAY about this lift's sets? An
  // entry that lists sets is authoritative for every index, including the
  // indices it doesn't list — those sets are gone. An entry with none yet (or
  // no entry at all) is simply behind: the workout, entry and set queries emit
  // independently, so that window is real and short.
  //
  // The distinction is the whole reason a set's id is ever carried forward,
  // and getting it wrong is not symmetric. Carrying too little blanks a lift
  // for a beat. Carrying too much means the draft keeps pointing at blocks
  // that are gone — after a Finish pruned them, after an undo, after another
  // device deleted one — and every tap lands somewhere it shouldn't.
  const liveIsAuthoritative = liveSets.length > 0

  // A set that already knows its block is matched to it BY ID, never by
  // position — the same rule the rows above it follow, and for the same
  // reason. `live.sets` is a compacted list, so deleting one set from the
  // middle of a lift shifts every set after it up a slot: row 1 would take
  // row 2's block while row 2 came up empty, and the create that filled row 2
  // in derives its id from row 2's INDEX — handing back the very block row 1
  // was already displaying. Two rows, one block, and the second one's edit
  // silently overwrites the set the first one logged.
  const byId = new Map(liveSets.map(set => [set.id, set] as const))
  const spokenFor = new Set(
    (previous?.sets ?? [])
      .map(set => set.blockId)
      .filter((id): id is string => id !== undefined && byId.has(id)),
  )
  // What's left over is attached positionally, which is right for exactly the
  // sets that have no block yet: a freshly materialized lift has a contiguous
  // run of them, holes only appear later.
  const spare = liveSets.filter(set => !spokenFor.has(set.id))
  let spareAt = 0

  const sets: DraftSet[] = []
  for (let i = 0; i < count; i += 1) {
    const previousSet = previous?.sets[i]
    const liveSet = previousSet?.blockId !== undefined
      ? byId.get(previousSet.blockId)
      : spare[spareAt++]
    // A write is in flight for this set: the block is momentarily BEHIND what
    // the user just did, so letting it win reverts their own tap in front of
    // them. Everything else here is "the block is the record".
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
    // We created this block ourselves and the query hasn't caught up. Keeping
    // it is what lets this whole function run unconditionally: the id, and the
    // values written with it, survive an emission that predates them.
    if (!liveIsAuthoritative && previousSet?.blockId !== undefined) {
      sets.push(previousSet)
      continue
    }
    sets.push(row.sets[i])
  }
  return sets
}

/** The draft the view renders: tonight's prescription, with the live blocks
 *  laid over it.
 *
 *  Non-destructive, and that is the whole design. It takes what is currently
 *  on screen as an input rather than replacing it, so it can run on EVERY
 *  query emission — there is no longer a question of whether this emission
 *  carries news worth reseeding for, which is what the deleted five-clause
 *  `ourWorkoutArrived` guard was trying (and failing) to answer. Precedence,
 *  per set:
 *
 *    1. a write in flight — the block is behind, not ahead
 *    2. the block, whenever there is one — another device's tick, the
 *       outline's checkbox, the values of a workout this view adopted
 *    3. what is on screen, if it already has a block id — our own create,
 *       one query behind
 *    4. the prescription's pre-filled value
 *
 *  Rows are matched by `rowKey` on all three sides, so a row keeps its blocks
 *  across a re-prescription and loses them exactly when it becomes a different
 *  lift. A live entry with no row (the `or`-group option you switched away
 *  from) is deliberately absent from the draft — Finish reads the committed
 *  tree, so nothing depends on this view having rendered it.
 *
 *  `previous` is what is on screen NOW, and the caller must not pass it when
 *  the screen is about to be about something else — a session switch, or a
 *  workout that just finished. Rule 3 has no way to tell "our create, one
 *  query behind" from "that workout is over": both look like a live query
 *  with nothing in it. Passing the old draft there carried a finished
 *  session's block ids into the next one, and the next tap wrote into it.
 *
 *  Returns `previous` unchanged (same reference) when nothing moved, and
 *  reuses each unchanged row object, so running it per emission costs one
 *  comparison pass and no re-render.
 *
 *  Safe to be unconditional only because the draft holds no uncommitted state:
 *  a number being typed lives in the input's own React state until blur. Keep
 *  it that way. */
export const overlayLive = (
  base: readonly DraftExercise[],
  live: LiveWorkout | undefined,
  previous: DraftExercise[] = [],
  writing: ReadonlySet<string> = new Set(),
): DraftExercise[] => {
  const matches = matchLiveExercises(base.map(liftRef), live)
  const previousByKey = new Map(previous.map(ex => [rowKey(ex), ex] as const))

  const next = base.map((row, i) => {
    const liveEntry = matches[i]
    const previousRow = previousByKey.get(rowKey(row))
    const merged: DraftExercise = {
      ...row,
      blockId: liveEntry?.id ?? previousRow?.blockId,
      sets: mergeSets(row, liveEntry, previousRow, writing),
    }
    return previousRow && sameRow(merged, previousRow) ? previousRow : merged
  })
  return next.length === previous.length && next.every((row, i) => row === previous[i]) ? previous : next
}

/** One exercise as the store writes it. Exported because a mid-session
 *  `or`-group switch materializes a single exercise into an existing
 *  workout. */
/** One set as the store writes it. The single mapper: the write path needs
 *  it per set (`writeSet`) and per exercise (`materialize*`), and two copies
 *  of the same field list is a field silently missed on one of them. */
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
