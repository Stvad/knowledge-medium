/** The shoulder re-open triggers, straight from the plan's shoulder policy.
 *
 *  These are a lightweight periodic self-check, surfaced occasionally after
 *  logging. Any checked trigger means "book the consult, no re-litigating" —
 *  the caller turns a non-empty result into a todo referencing the policy
 *  block. One of the triggers (left plateau while right progresses) the
 *  engine can also flag from the logs; the rest are subjective.
 */

import {lastEntryFor, modalWeight} from './progression'
import type {WorkoutRecord} from './types'

export interface ShoulderTrigger {
  id: string
  prompt: string
  /** True when the logs themselves suggest this trigger — surfaced pre-checked
   *  so the objective one (left/right asymmetry) isn't missed. */
  autoFlag?: boolean
}

export const SHOULDER_TRIGGERS: readonly Omit<ShoulderTrigger, 'autoFlag'>[] = [
  {id: 'ache-48h', prompt: 'An ache lasting >48h that has recurred across weeks?'},
  {id: 'movement-change', prompt: 'Pain that changes how you perform a movement?'},
  {id: 'instability', prompt: 'Any instability or apprehension sensation?'},
  {id: 'left-plateau', prompt: 'Left side plateauing while the right progresses?'},
  {id: 'push-press', prompt: 'Symptoms appearing as push-press loads climb?'},
]

/** Single-arm lifts whose left/right working weights we compare for the
 *  asymmetry trigger. */
const SINGLE_ARM_LIFTS = ['Waiter carry']

const sideWorkingWeight = (
  history: readonly WorkoutRecord[],
  exercise: string,
  side: 'L' | 'R',
): number | undefined => {
  const last = lastEntryFor(history, exercise)
  if (!last) return undefined
  return modalWeight(last.entry.sets.filter(s => s.side === side))
}

/** True when a single-arm lift's left side is stuck below its right — the
 *  objective form of the "left plateau" trigger the plan says the logs will
 *  surface. */
export const detectLeftRightAsymmetry = (history: readonly WorkoutRecord[]): boolean =>
  SINGLE_ARM_LIFTS.some(lift => {
    const left = sideWorkingWeight(history, lift, 'L')
    const right = sideWorkingWeight(history, lift, 'R')
    return left !== undefined && right !== undefined && right > left
  })

/** The trigger checklist for a given history, with the asymmetry trigger
 *  pre-flagged when the logs support it. */
export const shoulderChecklist = (history: readonly WorkoutRecord[]): ShoulderTrigger[] => {
  const asymmetry = detectLeftRightAsymmetry(history)
  return SHOULDER_TRIGGERS.map(t => ({
    ...t,
    autoFlag: t.id === 'left-plateau' ? asymmetry : false,
  }))
}
