/** The quarterly assessment battery: what a test measures, and the plan's one
 *  rule over a result — a left/right gap over ~15% earns an extra set on the
 *  weaker side until a retest closes it. */

/** `pass-fail` records one outcome; every other measure is a number per side,
 *  since the battery is left/right comparisons throughout. */
export const ASSESSMENT_MEASURES = ['reps', 'seconds', 'cm', 'pass-fail'] as const

export type AssessmentMeasure = typeof ASSESSMENT_MEASURES[number]

export const asMeasure = (raw: unknown): AssessmentMeasure | undefined =>
  ASSESSMENT_MEASURES.find(measure => measure === raw)

export interface AssessmentTest {
  name: string
  measure: AssessmentMeasure
}

/** In whole percent: the rule is "over ~15%", and the row shows the gap
 *  rounded to a percent — flagging on that same number keeps a row from
 *  reading "15% gap · extra set", and keeps float noise off the boundary. */
const SIDE_GAP_FLAG_PERCENT = 15

export interface SideGap {
  /** |L − R| as a whole percent of the better side. */
  percent: number
  /** The weaker side, when the gap is over the flag — the plan's "extra set on
   *  the weak side until a retest closes it". */
  extraSetOn?: 'L' | 'R'
}

/** Undefined until both sides are recorded, and for two zeros, which compare
 *  nothing. */
export const sideGap = (left: number | undefined, right: number | undefined): SideGap | undefined => {
  if (left === undefined || right === undefined) return undefined
  const better = Math.max(left, right)
  if (better <= 0) return undefined
  const percent = Math.round((Math.abs(left - right) / better) * 100)
  return percent > SIDE_GAP_FLAG_PERCENT ? {percent, extraSetOn: left < right ? 'L' : 'R'} : {percent}
}
