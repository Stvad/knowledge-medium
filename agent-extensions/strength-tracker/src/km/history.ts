/** Pure block → record readers.
 *
 *  These take the raw rows a typed-block query returns and assemble the
 *  engine's `WorkoutRecord` / `LayoffRecord` shapes. They import only field
 *  names and plain helpers — no runtime `@/` module — so the mapping is
 *  unit-testable in a plain node environment.
 *
 *  Property values on a row are codec-*encoded*: dates are ISO strings,
 *  everything the extension stores otherwise round-trips as identity JSON
 *  (numbers, strings, the sets array). So the only decode needed here is
 *  ISO-string → Date for the two date fields.
 */

import type {LayoffRecord, SessionType, SetRecord, WorkoutRecord} from '../engine/types'
import {dateToDay} from './day'
import {FIELD} from './fields'

/** Minimal shape the readers need — a structural subset of the app's
 *  `BlockData`, so the real rows satisfy it without importing its type. */
export interface RowLike {
  id: string
  parentId: string | null
  orderKey: string
  properties: Record<string, unknown>
}

const num = (row: RowLike, name: string, fallback: number): number => {
  const raw = row.properties[name]
  return typeof raw === 'number' ? raw : fallback
}

const optNum = (row: RowLike, name: string): number | undefined => {
  const raw = row.properties[name]
  return typeof raw === 'number' ? raw : undefined
}

const str = (row: RowLike, name: string, fallback = ''): string => {
  const raw = row.properties[name]
  return typeof raw === 'string' ? raw : fallback
}

const optStr = (row: RowLike, name: string): string | undefined => {
  const raw = row.properties[name]
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

const date = (row: RowLike, name: string): Date | undefined => {
  const raw = row.properties[name]
  if (typeof raw !== 'string') return undefined
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? undefined : d
}

/** A set is accepted when its composed todo `status` is done. */
const isDone = (row: RowLike): boolean => row.properties[FIELD.todoStatus] === 'done'

const side = (row: RowLike, name: string): 'L' | 'R' | undefined => {
  const raw = row.properties[name]
  return raw === 'L' || raw === 'R' ? raw : undefined
}

const compareByOrderKey = (a: RowLike, b: RowLike): number =>
  a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : a.id < b.id ? -1 : 1

const groupByParent = (rows: readonly RowLike[]): Map<string, RowLike[]> => {
  const byParent = new Map<string, RowLike[]>()
  for (const row of rows) {
    if (row.parentId === null) continue
    const list = byParent.get(row.parentId) ?? []
    list.push(row)
    byParent.set(row.parentId, list)
  }
  return byParent
}

/** A done set block → the engine's `SetRecord`. */
const toSetRecord = (row: RowLike): SetRecord => ({
  weight: num(row, FIELD.weight, 0),
  reps: num(row, FIELD.reps, 0),
  ...(optNum(row, FIELD.rpe) !== undefined ? {rpe: optNum(row, FIELD.rpe)} : {}),
  ...(side(row, FIELD.side) !== undefined ? {side: side(row, FIELD.side)} : {}),
})

/** Assemble workout records from the workout / exercise / set block trees.
 *  Only DONE workouts count as history (an in-progress session is the live
 *  logging state and must never feed its own prescription), and within a
 *  workout only DONE sets are counted (a pre-filled, un-accepted set records
 *  nothing). */
export const buildHistory = (
  workoutRows: readonly RowLike[],
  exerciseRows: readonly RowLike[],
  setRows: readonly RowLike[],
): WorkoutRecord[] => {
  const exercisesByWorkout = groupByParent(exerciseRows)
  const setsByExercise = groupByParent(setRows)

  const workouts: WorkoutRecord[] = []
  for (const row of workoutRows) {
    const d = date(row, FIELD.date)
    if (d === undefined) continue
    if (str(row, FIELD.status) === 'in-progress') continue
    const entries = (exercisesByWorkout.get(row.id) ?? []).slice().sort(compareByOrderKey)
    const session = str(row, FIELD.session, 'A') as SessionType
    workouts.push({
      id: row.id,
      date: d.toISOString(),
      session,
      exercises: entries.map(entry => ({
        exercise: str(entry, FIELD.exercise),
        definitionId: optStr(entry, FIELD.definition),
        prescribedWeight: optNum(entry, FIELD.prescribedWeight),
        prescribedSets: optNum(entry, FIELD.prescribedSets),
        sets: (setsByExercise.get(entry.id) ?? [])
          .slice()
          .sort(compareByOrderKey)
          .filter(isDone)
          .map(toSetRecord),
      })),
    })
  }
  return workouts.sort((a, b) => a.date.localeCompare(b.date))
}

// ──── live in-progress workouts (for the logging UI) ────
// Distinct from buildHistory: keeps EVERY set (done and not) with its block id
// so the UI can edit sets in place, and only surfaces in-progress workouts.

export interface LiveSet {
  id: string
  weight: number
  reps: number
  rpe?: number
  side?: 'L' | 'R'
  done: boolean
  completedAt?: number
}

export interface LiveExercise {
  id: string
  exercise: string
  /** Plan block it was logged from — how the draft re-attaches to the right
   *  prescription even if the exercise has since been renamed. */
  definitionId?: string
  unit: string
  prescribedWeight?: number
  prescribedSets?: number
  sets: LiveSet[]
}

export interface LiveWorkout {
  id: string
  day: string
  session: SessionType
  exercises: LiveExercise[]
}

const toLiveSet = (row: RowLike): LiveSet => ({
  id: row.id,
  weight: num(row, FIELD.weight, 0),
  reps: num(row, FIELD.reps, 0),
  ...(optNum(row, FIELD.rpe) !== undefined ? {rpe: optNum(row, FIELD.rpe)} : {}),
  ...(side(row, FIELD.side) !== undefined ? {side: side(row, FIELD.side)} : {}),
  done: isDone(row),
  ...(optNum(row, FIELD.completedAt) !== undefined ? {completedAt: optNum(row, FIELD.completedAt)} : {}),
})

/** Which live entry backs each prescribed row, positionally.
 *
 *  By plan block first, then by name — so a lift renamed mid-session still
 *  re-attaches to the entry it was logged into. Each live entry backs at most
 *  ONE row: two rows sharing a name (a hand-written plan, a default-config
 *  session) would otherwise both adopt it and then write over each other.
 *
 *  Shared, because two callers must agree on the answer or they corrupt each
 *  other: the draft overlay decides which blocks a row *edits*, and the
 *  adopt path decides which blocks a row *reuses* instead of creating. */
export const matchLiveExercises = (
  rows: readonly {readonly name: string; readonly defId?: string}[],
  live: LiveWorkout | undefined,
): (LiveExercise | undefined)[] => {
  if (!live) return rows.map(() => undefined)
  const byName = new Map(live.exercises.map(e => [e.exercise, e]))
  const byDefId = new Map(
    live.exercises.filter(e => e.definitionId !== undefined).map(e => [e.definitionId as string, e]),
  )
  const claimed = new Set<string>()
  return rows.map(row => {
    const match = (row.defId !== undefined ? byDefId.get(row.defId) : undefined) ?? byName.get(row.name)
    if (!match || claimed.has(match.id)) return undefined
    claimed.add(match.id)
    return match
  })
}

export const buildLiveWorkouts = (
  workoutRows: readonly RowLike[],
  exerciseRows: readonly RowLike[],
  setRows: readonly RowLike[],
): LiveWorkout[] => {
  const exercisesByWorkout = groupByParent(exerciseRows)
  const setsByExercise = groupByParent(setRows)

  const live: LiveWorkout[] = []
  for (const row of workoutRows) {
    if (str(row, FIELD.status) !== 'in-progress') continue
    const d = date(row, FIELD.date)
    if (d === undefined) continue
    const entries = (exercisesByWorkout.get(row.id) ?? []).slice().sort(compareByOrderKey)
    live.push({
      id: row.id,
      day: dateToDay(d),
      session: str(row, FIELD.session, 'A') as SessionType,
      exercises: entries.map(entry => ({
        id: entry.id,
        exercise: str(entry, FIELD.exercise),
        definitionId: optStr(entry, FIELD.definition),
        unit: str(entry, FIELD.unit, 'lb'),
        prescribedWeight: optNum(entry, FIELD.prescribedWeight),
        prescribedSets: optNum(entry, FIELD.prescribedSets),
        sets: (setsByExercise.get(entry.id) ?? []).slice().sort(compareByOrderKey).map(toLiveSet),
      })),
    })
  }
  return live
}

/** `{groupId: optionId}` from the `or`-group choice blocks (children of the
 *  settings block). One block per answered group; a group with no block is
 *  absent, and falls back to the plan's own default. Pure, so the mapping is
 *  testable without a repo. */
export const buildAltChoices = (rows: readonly RowLike[]): Record<string, string> => {
  const choices: Record<string, string> = {}
  for (const row of rows) {
    const group = row.properties[FIELD.choiceGroup]
    const option = row.properties[FIELD.choiceOption]
    if (typeof group === 'string' && group && typeof option === 'string' && option) {
      choices[group] = option
    }
  }
  return choices
}

export const buildLayoffs = (layoffRows: readonly RowLike[]): LayoffRecord[] => {
  const layoffs: LayoffRecord[] = []
  for (const row of layoffRows) {
    const from = date(row, FIELD.layoffFrom)
    const to = date(row, FIELD.layoffTo)
    if (from === undefined || to === undefined) continue
    layoffs.push({
      id: row.id,
      from: dateToDay(from),
      to: dateToDay(to),
      days: num(row, FIELD.layoffDays, 0),
      tierId: str(row, FIELD.layoffTier),
      pct: num(row, FIELD.layoffPct, 1),
    })
  }
  return layoffs.sort((a, b) => a.to.localeCompare(b.to))
}
