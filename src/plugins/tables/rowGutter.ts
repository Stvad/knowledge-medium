import { useIsMobile } from '@/utils/react'

/** Where a row's controls stand (the expand toggle, 12px, beside the 20px
 *  bullet, and the frame's 4px gap; on a phone the toggle moves to the gutter):
 *  the header's columns are set in by `margin`, and the first column freezes at
 *  `frozenLeft`, just right of the frozen controls, in the rows and the header.
 *  A margin on the header row, not padding on its scroller: a scroller's
 *  padding moves where the frozen column sticks. */
export interface RowGutter {
  margin: string
  frozenLeft: string
  /** On the header's frozen column: covers the gutter to its left, which the
   *  rows' frozen controls cover below it. */
  cover: string
  /** A row's children: frozen beside the controls, as wide as the rest of the visible table. */
  notes: {className: string; maxWidth: string}
  /** A row's body (its grid and children): the header row's width, which is
   *  the visible table less the gutter, or the grid's minimum when wider. */
  bodyWidth: string
}

const COVER = "before:absolute before:inset-y-0 before:right-full before:bg-background before:content-['']"
/** Set on the rows' scroller to its visible width. */
export const VIEW_WIDTH_VARIABLE = '--tables-view-width'
/** Set on the grid's root to the sum of the columns' minimum widths. */
export const MIN_WIDTH_VARIABLE = '--tables-min-width'
const gutter = (width: string, margin: string, left: string, cover: string): RowGutter => {
  const visible = `calc(var(${VIEW_WIDTH_VARIABLE}, 0px) - ${width})`
  return {
    margin, frozenLeft: left, cover: `${COVER} ${cover}`,
    notes: {className: `sticky ${left}`, maxWidth: visible},
    bodyWidth: `max(var(${MIN_WIDTH_VARIABLE}), ${visible})`,
  }
}
const DESKTOP = gutter('2.25rem', 'ml-9', 'left-9', 'before:w-9')
const PHONE = gutter('1.5rem', 'ml-6', 'left-6', 'before:w-6')

export const useRowGutter = (): RowGutter => useIsMobile() ? PHONE : DESKTOP
