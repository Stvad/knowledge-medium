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

export type WeightSlot =
  | {kind: 'panel'; id: string; weight?: number}
  | {kind: 'stack'; children: readonly WeightSlot[]}

const panelsOf = (slot: WeightSlot): Array<Extract<WeightSlot, {kind: 'panel'}>> =>
  slot.kind === 'panel' ? [slot] : slot.children.flatMap(panelsOf)

/** The panel row a column's width is stored on, with the width (absent ≡ 1):
 *  a panel's own; for a stack, its first panel with a width stored, else its
 *  first panel. Kept on panels, never on a stack row, so a column's width
 *  stays with its panels when a stack is made around them, collapses to one
 *  of them, or is rebuilt from the URL. Undefined for an empty stack. */
export const columnWeightHolder = (slot: WeightSlot): {id: string; weight: number} | undefined => {
  const panels = panelsOf(slot)
  const holder = panels.find(panel => panel.weight !== undefined) ?? panels[0]
  return holder && {id: holder.id, weight: holder.weight ?? 1}
}
