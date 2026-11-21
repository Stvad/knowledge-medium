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
export const lastTimeShape = (sets: readonly SetRecord[]): string => {
  const performed = progressionSets(sets)
  const reps = performed.map(set => set.reps)
  if (reps.length === 0) return '?'
  if (!reps.every(count => count === reps[0])) return reps.join('/')
  // What you PERFORMED, with no correction on top of it.
  //
  // There used to be one: entries predating `strength:side` stored both sides
  // as bare rows, so a three-set single-arm lift read as six, and this inferred
  // that from "exactly twice the prescribed count, and no row claims a side".
  // That inference cannot be told apart from doing double the prescribed
  // volume — three extra sets on a prescribed three, all at the same reps, is
  // an ordinary session — and it reported those six as `3×10`. Under-reporting
  // what you did, on the line you load the next bar against, is the worse of
  // the two errors, and it lands on live sessions rather than pre-migration
  // ones.
  //
  // Nothing is left for it to catch: single-arm work is identified by the
  // explicit `strength:side`, which `progressionSets` reads directly (an L/R
  // pair per prescribed set collapses to one row), and the live workspace has
  // no un-sided doubled entry at all — all 33 of its sided rows carry the
  // property, because the migration stamped them.
  return `${reps.length}×${reps[0]}`
}
