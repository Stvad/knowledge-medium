/** How a previous performance reads on one line.
 *
 *  Pure and separate from the decoration that renders it, because this
 *  extension has no DOM test tier — a rule living inside a component is a
 *  rule reviewed by eye, and this one decides the number you load the bar
 *  against.
 */

import {progressionSets} from '../engine/progression'
import type {SetRecord} from '../engine/types'

/** `3×10` when the sets agree, `10/8/7` when they don't.
 *
 *  The compact form is a claim that every set was the same, and fatiguing
 *  down a set is ordinary — the per-set rep controls make it a two-tap
 *  edit. Reported as `3×10`, a 10/8/7 session reads as a clean top-of-range
 *  performance, which is exactly the shape that says "add load next time".
 *
 *  Counted over the rows progression itself reads: single-arm work stores an
 *  L and an R per prescribed set, so counting rows called a three-set lift
 *  six. `prescribedSets` still wins where the entry states it, for legacy
 *  rows that recorded no side and would otherwise double.
 */
export const lastTimeShape = (
  sets: readonly SetRecord[],
  prescribedSets: number | undefined,
): string => {
  const reps = progressionSets(sets).map(set => set.reps)
  if (reps.length === 0) return '?'
  return reps.every(count => count === reps[0])
    ? `${prescribedSets ?? reps.length}×${reps[0]}`
    : reps.join('/')
}
