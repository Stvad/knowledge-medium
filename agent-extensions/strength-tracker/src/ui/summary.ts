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
 *  The COUNT is what you actually performed, for the same reason. `sets` holds
 *  only the ticked rows (`buildHistory` filters them), so a lift you cut short
 *  at two of three arrives here with two — and printing `prescribedSets`
 *  reported it as three, which is the same lie about the same session by
 *  another route, and one progression itself does not tell: it treats the
 *  short session as incomplete and holds the load.
 *
 *  Counted over the rows progression reads, so single-arm work — an L and an R
 *  per prescribed set — is not called six.
 */
export const lastTimeShape = (
  sets: readonly SetRecord[],
  prescribedSets: number | undefined,
): string => {
  const performed = progressionSets(sets)
  const reps = performed.map(set => set.reps)
  if (reps.length === 0) return '?'
  if (!reps.every(count => count === reps[0])) return reps.join('/')
  // The one case the row count cannot answer: entries logged before
  // `strength:side` existed store both sides as bare rows, so nothing can
  // halve them and a three-set lift reads as six.
  //
  // Identified POSITIVELY — exactly twice as many as were prescribed, and no
  // row claiming a side — rather than by preferring `prescribedSets` wherever
  // it happens to be stated, which is what turned every partial session into a
  // complete-looking one.
  //
  // The side clause is defence in depth, not the load-bearing half:
  // `progressionSets` already returns every row precisely when none has a
  // side, so the count test alone decides for any entry this extension wrote.
  // It earns its place only on a half-sided entry, which takes hand-editing to
  // produce and is pinned directly rather than through this path.
  const doubledLegacyRows = prescribedSets !== undefined
    && reps.length === prescribedSets * 2
    && performed.every(set => set.side === undefined)
  return `${doubledLegacyRows ? prescribedSets : reps.length}×${reps[0]}`
}
