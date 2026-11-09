/** The weights of two neighbouring layout columns after the divider between
 *  them moves `dx` px to the right, from their widths and weights when the
 *  drag started. The pair keeps its total weight, so the other columns keep
 *  their widths, and neither column goes under `minWidth`. Rounded to three
 *  decimals, which is finer than a pixel at any realistic width. */
export const resizeColumnPair = ({widths, weights, dx, minWidth}: {
  widths: readonly [number, number]
  weights: readonly [number, number]
  dx: number
  minWidth: number
}): [number, number] => {
  const total = widths[0] + widths[1]
  if (total <= 2 * minWidth) return [weights[0], weights[1]]
  const left = Math.min(total - minWidth, Math.max(minWidth, widths[0] + dx))
  const weightTotal = weights[0] + weights[1]
  const leftWeight = Math.round(weightTotal * left / total * 1000) / 1000
  return [leftWeight, Math.round((weightTotal - leftWeight) * 1000) / 1000]
}
