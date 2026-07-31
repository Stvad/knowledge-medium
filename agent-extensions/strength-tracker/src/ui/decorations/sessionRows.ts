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
  workouts: readonly BlockData[]
  exercises: readonly BlockData[]
  sets: readonly BlockData[]
  /** Finished sessions only — `buildHistory` drops in-progress ones, which is
   *  what keeps tonight from feeding its own "last time". */
  history: readonly WorkoutRecord[]
  setsOf: (parentId: string) => readonly BlockData[]
}

const EMPTY: readonly BlockData[] = []

export const useSessionRows = (workspaceId: string): SessionRows => {
  const rows = useBlockQuery({
    workspaceId,
    types: [WORKOUT_TYPE, EXERCISE_ENTRY_TYPE, SET_TYPE],
  })

  return useMemo(() => {
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
    const byParent = new Map<string, BlockData[]>()
    for (const set of sets) {
      if (set.parentId === null) continue
      const list = byParent.get(set.parentId) ?? []
      list.push(set)
      byParent.set(set.parentId, list)
    }
    for (const list of byParent.values()) {
      list.sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : a.id < b.id ? -1 : 1))
    }
    return {
      workouts,
      exercises,
      sets,
      history: buildHistory(workouts, exercises, sets),
      setsOf: (parentId: string) => byParent.get(parentId) ?? EMPTY,
    }
  }, [rows])
}
