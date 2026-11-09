/** How a block's content makes room for its top-right gutter items:
 *  - `flow`: the block's own text starts at the corner, so only its first line
 *    yields (the text draws the spacer, see `useGutterText`);
 *  - `column`: the text is registered but something sits above or beside it,
 *    so the whole content is narrowed;
 *  - `none`: no text is registered (a video, a review deck), so the host
 *    reserves a row above the content or, for overlay items, nothing. */
export type GutterTopMode = 'none' | 'column' | 'flow'

export interface GutterTopState {
  mode: GutterTopMode
  /** The `key` of the measurement that sent the host from flow to column. */
  stuckKey: string | null
}

export interface GutterTopMeasure {
  hasText: boolean
  /** Text box top minus the host's top, px. */
  topGap: number
  /** The host's content-box right minus the text box right, px. */
  rightGap: number
  /** The sizes a mode flip cannot change: host width, cluster width and the
   *  text registration. */
  key: string
}

export const INITIAL_GUTTER_TOP_STATE: GutterTopState = {mode: 'column', stuckKey: null}

const TOLERANCE_PX = 1

/** Column never overlaps anything, so a host may always fall back to it; it
 *  leaves column for flow only when `key` differs from the measurement that
 *  sent it there. Text whose width depends on the spacer (text that shrinks to
 *  fit, e.g. beside type chips) reaches the corner in one mode and not the
 *  other, and would otherwise flip on every frame. */
export const decideGutterTopMode = (
  state: GutterTopState,
  measure: GutterTopMeasure,
): GutterTopState => {
  if (!measure.hasText) return {mode: 'none', stuckKey: null}
  const textHoldsCorner = Math.abs(measure.topGap) <= TOLERANCE_PX && measure.rightGap <= TOLERANCE_PX
  if (state.mode === 'flow') return textHoldsCorner ? state : {mode: 'column', stuckKey: measure.key}
  if (textHoldsCorner && measure.key !== state.stuckKey) return {mode: 'flow', stuckKey: null}
  return {mode: 'column', stuckKey: state.stuckKey}
}
