/** Logging draft — the editing model for tonight's session.
 *
 *  Pure and UI-independent. A draft is built from the prescription (every set
 *  pre-filled so accepting as-prescribed is one tap), then *overlaid* with the
 *  live in-progress workout block when one exists — so the block is the source
 *  of truth and each set carries its block id for in-place edits. The mappers
 *  turn a draft into what the store materializes and what "Finish" prunes.
 */

import type {ExerciseVideo, Prescription, PrescribedExercise} from '../engine/types'
import {workingWeight} from '../engine/progression'
import type {LiveWorkout} from '../km/history'
import type {ExerciseDraft, FinishPlan, WorkoutDraft} from '../km/store'

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
  altOptions?: readonly string[]
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
 *  exercise name, the block's set values + ids replace the pre-filled ones, so
 *  the rendered draft reflects (and can edit) the actual blocks. Exercises the
 *  live workout doesn't have keep their pre-filled sets. */
export const overlayLive = (
  draft: readonly DraftExercise[],
  live: LiveWorkout | undefined,
): DraftExercise[] => {
  if (!live) return draft.map(ex => ({...ex}))
  const byName = new Map(live.exercises.map(e => [e.exercise, e]))
  return draft.map(ex => {
    const le = byName.get(ex.exercise)
    if (!le) return {...ex}
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

const toExerciseDraft = (ex: DraftExercise): ExerciseDraft => ({
  exercise: ex.exercise,
  unit: ex.unit,
  prescribedWeight: ex.prescribedWeight,
  prescribedSets: ex.prescribedSets,
  sets: ex.sets.map(s => ({
    weight: s.weight,
    reps: s.reps,
    done: s.done,
    ...(s.rpe !== undefined ? {rpe: s.rpe} : {}),
    ...(s.side !== undefined ? {side: s.side} : {}),
    ...(s.completedAt !== undefined ? {completedAt: s.completedAt} : {}),
  })),
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

/** What "Finish" keeps vs prunes: exercises with ≥1 done set keep only their
 *  done sets (with the derived working weight); exercises with none are
 *  removed. Only meaningful once the draft is materialized (sets have ids). */
export const finishPlan = (workoutId: string, draft: readonly DraftExercise[]): FinishPlan => {
  const keep: FinishPlan['keep'] = []
  const removeExerciseIds: string[] = []
  for (const ex of draft) {
    if (ex.blockId === undefined) continue
    const doneSets = ex.sets.filter(s => s.done)
    if (doneSets.length === 0) {
      removeExerciseIds.push(ex.blockId)
      continue
    }
    keep.push({
      exerciseId: ex.blockId,
      workingWeight: workingWeight({
        exercise: ex.exercise,
        sets: doneSets.map(s => ({weight: s.weight, reps: s.reps, side: s.side})),
      }),
      removeSetIds: ex.sets.filter(s => !s.done && s.blockId !== undefined).map(s => s.blockId as string),
    })
  }
  return {workoutId, keep, removeExerciseIds}
}

/** Every block id under a draft (sets, exercises) plus the workout — for
 *  discarding an abandoned in-progress workout wholesale. */
export const draftBlockIds = (workoutId: string, draft: readonly DraftExercise[]): string[] => {
  const ids: string[] = []
  for (const ex of draft) {
    for (const s of ex.sets) if (s.blockId) ids.push(s.blockId)
    if (ex.blockId) ids.push(ex.blockId)
  }
  ids.push(workoutId)
  return ids
}
