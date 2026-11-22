// CSS variables the grid sets, read by the header and the rows.

/** The rows' scroller's visible width (set on the scroller). */
export const VIEW_WIDTH_VARIABLE = '--tables-view-width'
/** The sum of the columns' minimum widths. */
export const MIN_WIDTH_VARIABLE = '--tables-min-width'
/** Where a row's controls stand: the expand toggle (12px) beside the 20px
 *  bullet and the frame's 4px gap, or the bullet alone on a phone, where the
 *  toggle moves to the gutter. The header's columns are set in by it, and the
 *  first column freezes at it, in the rows and the header. */
export const GUTTER_VARIABLE = '--tables-gutter'
export const gutterWidth = (isMobile: boolean) => isMobile ? '1.5rem' : '2.25rem'
