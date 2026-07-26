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
import {matchLiveExercises} from '../km/history'
import type {LiveSet, LiveWorkout} from '../km/history'
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
 *  pre-filled sets.
 *
 *  STRUCTURAL: it rebuilds rows wholesale, so it runs only on a reseed (a
 *  session switch, the block structure changing). Value-only news uses
 *  `overlayLiveValues`, which can run on every emission without discarding
 *  what you are typing. */
export const overlayLive = (
  draft: readonly DraftExercise[],
  live: LiveWorkout | undefined,
): DraftExercise[] => {
  const matches = matchLiveExercises(draft.map(ex => ({name: ex.exercise, defId: ex.defId})), live)
  return draft.map((ex, i) => {
    const le = matches[i]
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

const sameAsBlock = (draftSet: DraftSet, live: LiveSet): boolean =>
  draftSet.weight === live.weight
  && draftSet.reps === live.reps
  && draftSet.done === live.done
  && draftSet.rpe === live.rpe
  && draftSet.side === live.side
  && draftSet.completedAt === live.completedAt

/** Track the blocks' current values without touching structure or ids.
 *
 *  Matched by set block, so it only ever speaks about sets this draft has
 *  already attached to a block — and it always wins, because the block IS the
 *  record. That is what makes the draft un-stale-able: another device's tick,
 *  the outline's checkbox, and the values of a workout this view adopted all
 *  arrive the same way, and Finish writing the draft back can never clobber a
 *  value it has already re-read.
 *
 *  Safe to be unconditional because the draft holds no uncommitted state: a
 *  number being typed lives in the input's own React state until blur. Keep
 *  it that way — moving keystrokes back into the draft would need a per-set
 *  dirty flag to make this safe again, and that flag is exactly what this
 *  design avoids.
 *
 *  `writing` is the one exemption, and it is not a value the draft carries:
 *  those sets have a write IN FLIGHT, so the block is momentarily behind what
 *  the user just did and "the block wins" would revert their own tap in front
 *  of them. A failed write is deliberately NOT exempt — it reverts, which is
 *  the honest outcome. The caller owns that set because only it knows which
 *  of its writes are outstanding; a pure function cannot tell in-flight from
 *  failed.
 *
 *  Returns the input array unchanged (same reference) when nothing moved, so
 *  running it on every query emission costs one comparison pass and no
 *  re-render. */
export const overlayLiveValues = (
  draft: DraftExercise[],
  live: LiveWorkout | undefined,
  writing: ReadonlySet<string> = new Set(),
): DraftExercise[] => {
  if (!live) return draft
  const byId = new Map<string, LiveSet>()
  for (const ex of live.exercises) for (const s of ex.sets) byId.set(s.id, s)

  let changed = false
  const next = draft.map(ex => {
    let rowChanged = false
    const sets = ex.sets.map(s => {
      if (s.blockId !== undefined && writing.has(s.blockId)) return s
      const block = s.blockId !== undefined ? byId.get(s.blockId) : undefined
      if (!block || sameAsBlock(s, block)) return s
      rowChanged = true
      return {
        ...s,
        weight: block.weight,
        reps: block.reps,
        done: block.done,
        rpe: block.rpe,
        side: block.side,
        completedAt: block.completedAt,
      }
    })
    if (!rowChanged) return ex
    changed = true
    return {...ex, sets}
  })
  return changed ? next : draft
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
