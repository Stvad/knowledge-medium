const round = (weight: number): number => Math.round(weight * 1000) / 1000

/** Every layout column's weight after the divider left of column `divider`
 *  moves `dx` px to the right, from the columns' rendered widths when the
 *  drag started. Each weight is that column's width, so the grid renders
 *  exactly those widths whatever weights produced them (a column held at the
 *  minimum included): only the pair beside the divider changes, and neither
 *  goes under `minWidth`. Scaled to average 1, the weight of a column never
 *  resized, and rounded to three decimals, finer than a pixel at any
 *  realistic width. */
export const resizeColumns = ({widths, divider, dx, minWidth}: {
  widths: readonly number[]
  divider: number
  dx: number
  minWidth: number
}): number[] => {
  const next = [...widths]
  const pair = widths[divider - 1] + widths[divider]
  if (pair > 2 * minWidth) {
    next[divider - 1] = Math.min(pair - minWidth, Math.max(minWidth, widths[divider - 1] + dx))
    next[divider] = pair - next[divider - 1]
  }
  const mean = next.reduce((sum, width) => sum + width, 0) / next.length
  return next.map(width => round(width / mean))
}

/** The weights with the pair beside the divider left of column `divider`
 *  given equal shares of their combined weight. */
export const equalizeColumnPair = (weights: readonly number[], divider: number): number[] => {
  const half = round((weights[divider - 1] + weights[divider]) / 2)
  return weights.map((weight, index) => index === divider - 1 || index === divider ? half : weight)
}
