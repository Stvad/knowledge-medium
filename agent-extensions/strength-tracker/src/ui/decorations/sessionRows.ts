/** The one read the decorations share.
 *
 *  A decoration renders per block, so anything it needs must not cost a query
 *  per block. This is a single typed query over the whole log — the same
 *  any-of query shape the old view used — split by type and memoised, so ten
 *  set rows and their lift and their workout footer all read one answer.
 *
 *  Deliberately blocks-only: no plan outline, no config, no engine input
 *  beyond what the blocks themselves record. The plan is needed to BUILD a
 *  prescription, which happens once at Start; a decoration only ever
 *  describes what is already written down.
 */

import {useMemo} from 'react'

import {hasBlockType} from '@/data/properties.js'
import type {BlockData} from '@/data/api/index.js'
import {useBlockQuery} from '@/hooks/block.js'

import {buildHistory} from '../../km/history'
import {EXERCISE_ENTRY_TYPE, SET_TYPE, WORKOUT_TYPE} from '../../km/fields'
import type {WorkoutRecord} from '../../engine/types'

export interface SessionRows {
  /** Finished sessions only — `buildHistory` drops in-progress ones, which is
   *  what keeps tonight from feeding its own "last time". */
  history: readonly WorkoutRecord[]
  setsOf: (parentId: string) => readonly BlockData[]
  entriesOf: (workoutId: string) => readonly BlockData[]
}

const EMPTY: readonly BlockData[] = []

const byOrderKey = (a: BlockData, b: BlockData): number =>
  a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : a.id < b.id ? -1 : 1

const groupByParent = (rows: readonly BlockData[]): Map<string, BlockData[]> => {
  const byParent = new Map<string, BlockData[]>()
  for (const row of rows) {
    if (row.parentId === null) continue
    const list = byParent.get(row.parentId) ?? []
    list.push(row)
    byParent.set(row.parentId, list)
  }
  for (const list of byParent.values()) list.sort(byOrderKey)
  return byParent
}

const derive = (rows: readonly BlockData[]): SessionRows => {
  const workouts: BlockData[] = []
  const exercises: BlockData[] = []
  const sets: BlockData[] = []
  // "Carries this type", never "is only this type" — a set block is
  // deliberately a `todo` as well.
  for (const row of rows) {
    if (hasBlockType(row, WORKOUT_TYPE)) workouts.push(row)
    if (hasBlockType(row, EXERCISE_ENTRY_TYPE)) exercises.push(row)
    if (hasBlockType(row, SET_TYPE)) sets.push(row)
  }
  const setsByEntry = groupByParent(sets)
  const entriesByWorkout = groupByParent(exercises)
  return {
    history: buildHistory(workouts, exercises, sets),
    setsOf: parentId => setsByEntry.get(parentId) ?? EMPTY,
    entriesOf: workoutId => entriesByWorkout.get(workoutId) ?? EMPTY,
  }
}

/** Shared across every consumer, not per component.
 *
 *  A `useMemo` here would be per INSTANCE, and this hook is called by every
 *  lift and every workout footer on screen — so ticking one set would re-run
 *  `buildHistory` over the whole workspace once per visible row, on the app's
 *  most frequent interaction. The query handle is shared and its result array
 *  keeps a stable identity per resolve, so keying on that array gives exactly
 *  one derivation per change, however many rows read it. */
const cache = new WeakMap<readonly BlockData[], SessionRows>()

export const useSessionRows = (workspaceId: string): SessionRows => {
  const rows = useBlockQuery({
    workspaceId,
    types: [WORKOUT_TYPE, EXERCISE_ENTRY_TYPE, SET_TYPE],
  })

  return useMemo(() => {
    const cached = cache.get(rows)
    if (cached) return cached
    const derived = derive(rows)
    cache.set(rows, derived)
    return derived
  }, [rows])
}
