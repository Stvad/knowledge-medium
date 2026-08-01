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
 *  The compact form claims every set was the same, and fatiguing down a set is
 *  ordinary — reported as `3×10`, a 10/8/7 session reads as a clean
 *  top-of-range performance, the exact shape that says "add load next time".
 *
 *  The COUNT is what you PERFORMED, for the same reason: `sets` holds only the
 *  ticked rows, so a lift cut short at two of three arrives with two, and
 *  printing `prescribedSets` would tell the same lie by another route.
 *  Counted over the rows progression reads, so single-arm work (an L and an R
 *  per prescribed set) is not called six. */
export const lastTimeShape = (
  sets: readonly SetRecord[],
  prescribedSets: number | undefined,
): string => {
  const performed = progressionSets(sets)
  const reps = performed.map(set => set.reps)
  if (reps.length === 0) return '?'
  if (!reps.every(count => count === reps[0])) return reps.join('/')
  // The one case the row count cannot answer: entries predating
  // `strength:side` store both sides as bare rows, so a three-set lift reads
  // as six. Identified POSITIVELY — exactly twice the prescribed count, no row
  // claiming a side — rather than by preferring `prescribedSets` wherever it
  // is stated, which turned every partial session into a complete-looking one.
  //
  // The side clause is defence in depth: `progressionSets` returns every row
  // precisely when none has a side, so the count test alone decides for
  // anything this extension wrote. It earns its place only on a half-sided
  // entry, which is hand-edited and pinned directly.
  const doubledLegacyRows = prescribedSets !== undefined
    && reps.length === prescribedSets * 2
    && performed.every(set => set.side === undefined)
  return `${doubledLegacyRows ? prescribedSets : reps.length}×${reps[0]}`
}
