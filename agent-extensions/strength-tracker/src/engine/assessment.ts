/** The quarterly assessment battery: what a test measures, and the plan's one
 *  rule over a result — a left/right gap over ~15% earns an extra set on the
 *  weaker side until a retest closes it. */

/** `pass-fail` records one outcome; every other measure is a number per side,
 *  since the battery is left/right comparisons throughout. */
export type AssessmentMeasure = 'reps' | 'seconds' | 'cm' | 'pass-fail'

export const ASSESSMENT_MEASURES: readonly AssessmentMeasure[] = ['reps', 'seconds', 'cm', 'pass-fail']

export const asMeasure = (raw: unknown): AssessmentMeasure | undefined =>
  ASSESSMENT_MEASURES.find(measure => measure === raw)

export interface AssessmentTest {
  name: string
  measure: AssessmentMeasure
}

export const SIDE_GAP_FLAG = 0.15

/** `gap` is |L − R| as a fraction of the better side. A flagged gap always has
 *  a weaker side; an unflagged one lacks it only when the sides are level. */
export type SideGap =
  | {gap: number; flagged: true; weaker: 'L' | 'R'}
  | {gap: number; flagged: false; weaker?: 'L' | 'R'}

/** Undefined until both sides are recorded, and for two zeros, which compare
 *  nothing. */
export const sideGap = (left: number | undefined, right: number | undefined): SideGap | undefined => {
  if (left === undefined || right === undefined) return undefined
  const better = Math.max(left, right)
  if (better <= 0) return undefined
  const gap = Math.abs(left - right) / better
  if (left === right) return {gap, flagged: false}
  const weaker = left < right ? 'L' : 'R'
  return gap > SIDE_GAP_FLAG ? {gap, weaker, flagged: true} : {gap, weaker, flagged: false}
}
