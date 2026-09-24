/** Stamping an assessment and recording its results.
 *
 *  A form, not a workflow: one tap stamps the dated block with one result
 *  block per test, and each number is then typed where it sits. Nothing closes
 *  an assessment and no prescription reads it — the gap rule is shown beside
 *  the numbers, for a person to act on.
 */

import {ChangeScope, propertyValue} from '@/data/api/index.js'
import type {Repo} from '@/data/repo.js'
import {createTypedChild} from '@/data/typedRecords.js'

import type {AssessmentTest} from '../engine/assessment'
import {dayToDate} from './day'
import {ASSESSMENT_RESULT_TYPE, ASSESSMENT_TYPE} from './fields'
import {dateProp, leftProp, measureProp, outcomeProp, rightProp} from './schema'

/** Stamp an assessment for `day` as the first child of `parentId` — the log
 *  page, which reads newest first. A second tap stamps a second one: it is on
 *  screen, and deleting it is the ordinary gesture. */
export const startAssessment = async (
  repo: Repo,
  parentId: string,
  day: string,
  battery: readonly AssessmentTest[],
): Promise<string> => {
  const typeSnapshot = repo.snapshotTypeRegistries()
  return repo.tx(async tx => {
    const id = await createTypedChild(repo, tx, {
      parentId,
      content: `Assessment · ${day}`,
      position: {kind: 'first'},
      types: [ASSESSMENT_TYPE],
      properties: [propertyValue(dateProp, dayToDate(day))],
      typeSnapshot,
    })
    for (const test of battery) {
      await createTypedChild(repo, tx, {
        parentId: id,
        content: test.name,
        types: [ASSESSMENT_RESULT_TYPE],
        properties: [propertyValue(measureProp, test.measure)],
        typeSnapshot,
      })
    }
    return id
  }, {scope: ChangeScope.BlockDefault, description: 'Log an assessment'})
}

export type ResultEntry =
  /** A side's number; undefined clears it. */
  | {side: 'L' | 'R'; value: number | undefined}
  /** Empty clears it. */
  | {outcome: 'pass' | 'fail' | ''}

export const recordResult = (repo: Repo, resultId: string, entry: ResultEntry): Promise<void> =>
  repo.tx(async tx => {
    if ('outcome' in entry) {
      await tx.setProperties(resultId, {set: [propertyValue(outcomeProp, entry.outcome)]})
      return
    }
    const prop = entry.side === 'L' ? leftProp : rightProp
    // Unset rather than written as undefined: only `unset` takes the key back
    // out of the bag, and the gap is computed from whether it is there.
    await tx.setProperties(resultId, entry.value === undefined
      ? {unset: [prop]}
      : {set: [propertyValue(prop, entry.value)]})
  }, {scope: ChangeScope.BlockDefault, description: 'Record an assessment result'})
