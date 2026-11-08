/** The one read the night/dose decorations and the page renderer share.
 *
 *  A decorator renders per block, so anything it needs must not cost a query
 *  per block — same shape as the Strength Tracker's `useSessionRows`: one
 *  typed query over the whole log, joined once and memoised, so every night
 *  row on screen plus the page renderer all read one answer.
 *
 *  Deliberately blocks-only: no engine input beyond what the blocks
 *  themselves record. `STRENGTH_WORKOUT_TYPE` rows are queried alongside our
 *  own so `trainedDays` can read them straight from the query result — see
 *  `../km/records`, which owns the read-only mirror of the Strength
 *  Tracker's own type/property spelling.
 */
import {useMemo} from 'react'

import type {BlockData} from '@/data/api/index.js'
import {useBlockQuery} from '@/hooks/block.js'

import type {ExperimentRecord, NightRecord} from '../engine/types'
import {DOSE_TYPE, EXPERIMENT_TYPE, NIGHT_TYPE, PERIOD_TYPE, SESSION_TYPE} from '../km/fields'
import {buildExperiments, buildNights, trainedDays} from '../km/records'

export interface LabRows {
  nights: readonly NightRecord[]
  experiments: readonly ExperimentRecord[]
}

/** Read alongside the extension's own types so a trained day is known from
 *  this one query — see `trainedDays` in `../km/records`. */
const STRENGTH_WORKOUT_TYPE = 'strength-workout'

const derive = (rows: readonly BlockData[]): LabRows => ({
  nights: buildNights(rows, trainedDays(rows)),
  experiments: buildExperiments(rows),
})

/** Shared across every consumer, not per instance — see `useSessionRows`'s
 *  doc for why a plain `useMemo` would re-derive per rendered row. Keyed on
 *  the query handle's result array, which is identity-stable per resolve. */
const cache = new WeakMap<readonly BlockData[], LabRows>()

export const useLabRows = (workspaceId: string): LabRows => {
  const rows = useBlockQuery({
    workspaceId,
    types: [NIGHT_TYPE, SESSION_TYPE, DOSE_TYPE, EXPERIMENT_TYPE, PERIOD_TYPE, STRENGTH_WORKOUT_TYPE],
  })

  return useMemo(() => {
    const cached = cache.get(rows)
    if (cached) return cached
    const derived = derive(rows)
    cache.set(rows, derived)
    return derived
  }, [rows])
}
