/** Logging draft — the editing model for tonight's session.
 *
 *  Pure and UI-independent. A draft is built from the prescription (every set
 *  pre-filled so accepting as-prescribed is one tap), then *overlaid* with the
 *  live in-progress workout block when one exists — so the block is the source
 *  of truth and each set carries its block id for in-place edits. The mappers
 *  turn a draft into what the store materializes and what "Finish" prunes.
 */

import type {AltOption, ExerciseVideo, Prescription, PrescribedExercise} from '../engine/types'
import {workingWeight} from '../engine/progression'
import type {LiveWorkout} from '../km/history'
import type {ExerciseDraft, FinishPlan, SetDraft, WorkoutDraft} from '../km/store'

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

export const buildDraft = (prescription: Prescription, unit: string): DraftExercise[] =>
  prescription.exercises.map(ex => ({
    exercise: ex.exercise,
    defId: ex.defId,
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
  }))

/** Overlay a live in-progress workout onto the prescription draft: matched by
 *  plan block (falling back to exercise name), the block's set values + ids
 *  replace the pre-filled ones, so the rendered draft reflects (and can edit)
 *  the actual blocks. Exercises the live workout doesn't have keep their
 *  pre-filled sets. */
export const overlayLive = (
  draft: readonly DraftExercise[],
  live: LiveWorkout | undefined,
): DraftExercise[] => {
  if (!live) return draft.map(ex => ({...ex}))
  const byName = new Map(live.exercises.map(e => [e.exercise, e]))
  const byDefId = new Map(
    live.exercises.filter(e => e.definitionId !== undefined).map(e => [e.definitionId as string, e]),
  )
  // A live entry backs at most ONE draft row. Two rows sharing a name (a
  // hand-written plan, or a default-config session) would otherwise both
  // adopt it, and then each would write over the other's blocks.
  const claimed = new Set<string>()
  return draft.map(ex => {
    const match = (ex.defId !== undefined ? byDefId.get(ex.defId) : undefined) ?? byName.get(ex.exercise)
    const le = match && !claimed.has(match.id) ? match : undefined
    if (!le) return {...ex}
    claimed.add(le.id)
    return {
      ...ex,
      blockId: le.id,
      sets: le.sets.map(s => ({
        weight: s.weight,
        reps: s.reps,
        done: s.done,
        completedAt: s.completedAt,
        rpe: s.rpe,
        side: s.side,
        blockId: s.id,
      })),
    }
  })
}

/** Stable identity of a live workout's block structure (ids only) — reseed the
 *  editing state when this changes, not on every value edit. */
export const liveIdentity = (live: LiveWorkout | undefined): string =>
  live
    ? `${live.id}:${live.exercises.map(e => `${e.id}[${e.sets.map(s => s.id).join(',')}]`).join('|')}`
    : ''

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

/** What "Finish" keeps vs prunes: an exercise with ≥1 accepted set keeps only
 *  those sets (with the derived working weight); one with none is removed.
 *  Only meaningful once the draft is materialized (sets have ids).
 *
 *  Two things make "accepted" wider than "ticked in this view":
 *
 *  - A set's done-ness is the built-in todo's checkbox, so it can be ticked
 *    anywhere — the outline below, a todo view, another device. The draft
 *    only reseeds on structural change, so it may not know. Done-ness is
 *    therefore the UNION of the draft and the block; a set the draft thinks
 *    is open but the block says is done must not be pruned.
 *  - `live` can hold an exercise the draft no longer does: you switched an
 *    `or`-group mid-session, so the option you moved off is gone from the
 *    prescription. It gets the SAME rule — pruned only when nothing was
 *    accepted. Deleting it outright erased sets that were actually
 *    performed, which is the one thing this log must never do.
 */
export const finishPlan = (
  workoutId: string,
  draft: readonly DraftExercise[],
  live?: LiveWorkout,
): FinishPlan => {
  const keep: FinishPlan['keep'] = []
  const removeExerciseIds: string[] = []
  const draftBlockIds = new Set(draft.map(ex => ex.blockId).filter((id): id is string => id !== undefined))
  const doneInBlocks = new Set(
    (live?.exercises ?? []).flatMap(ex => ex.sets.filter(s => s.done).map(s => s.id)),
  )

  const plan = (
    exerciseId: string,
    exerciseName: string,
    sets: ReadonlyArray<{blockId?: string; weight: number; reps: number; side?: 'L' | 'R'; done: boolean}>,
  ) => {
    const accepted = sets.filter(s => s.done || (s.blockId !== undefined && doneInBlocks.has(s.blockId)))
    if (accepted.length === 0) {
      removeExerciseIds.push(exerciseId)
      return
    }
    keep.push({
      exerciseId,
      workingWeight: workingWeight({
        exercise: exerciseName,
        sets: accepted.map(s => ({weight: s.weight, reps: s.reps, side: s.side})),
      }),
      removeSetIds: sets
        .filter(s => !accepted.includes(s) && s.blockId !== undefined)
        .map(s => s.blockId as string),
    })
  }

  for (const liveEx of live?.exercises ?? []) {
    if (draftBlockIds.has(liveEx.id)) continue
    plan(liveEx.id, liveEx.exercise, liveEx.sets.map(s => ({...s, blockId: s.id})))
  }
  for (const ex of draft) {
    if (ex.blockId === undefined) continue
    plan(ex.blockId, ex.exercise, ex.sets)
  }
  return {workoutId, keep, removeExerciseIds}
}
