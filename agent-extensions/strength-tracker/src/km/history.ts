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

import type {LayoffRecord, SessionType, WorkoutRecord} from '../engine/types'
import {dateToDay} from './day'
import {FIELD, type StoredSet} from './fields'

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

const date = (row: RowLike, name: string): Date | undefined => {
  const raw = row.properties[name]
  if (typeof raw !== 'string') return undefined
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? undefined : d
}

const sets = (row: RowLike, name: string): StoredSet[] => {
  const raw = row.properties[name]
  return Array.isArray(raw) ? (raw as StoredSet[]) : []
}

const compareByOrderKey = (a: RowLike, b: RowLike): number =>
  a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : a.id < b.id ? -1 : 1

export const buildHistory = (
  workoutRows: readonly RowLike[],
  exerciseRows: readonly RowLike[],
): WorkoutRecord[] => {
  const byWorkout = new Map<string, RowLike[]>()
  for (const entry of exerciseRows) {
    if (entry.parentId === null) continue
    const list = byWorkout.get(entry.parentId) ?? []
    list.push(entry)
    byWorkout.set(entry.parentId, list)
  }

  const workouts: WorkoutRecord[] = []
  for (const row of workoutRows) {
    const d = date(row, FIELD.date)
    if (d === undefined) continue
    const entries = (byWorkout.get(row.id) ?? []).slice().sort(compareByOrderKey)
    const session = str(row, FIELD.session, 'A') as SessionType
    workouts.push({
      id: row.id,
      date: d.toISOString(),
      session,
      exercises: entries.map(entry => ({
        exercise: str(entry, FIELD.exercise),
        prescribedWeight: optNum(entry, FIELD.prescribedWeight),
        prescribedSets: optNum(entry, FIELD.prescribedSets),
        sets: sets(entry, FIELD.sets),
      })),
    })
  }
  return workouts.sort((a, b) => a.date.localeCompare(b.date))
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
