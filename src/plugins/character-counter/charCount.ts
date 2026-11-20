/** Pure formatter for the count badge (count text + over-limit flag), kept
 *  out of the React decorator so it is unit-testable without a render
 *  harness. */

export interface CharCountDisplay {
  /** Text shown in the badge, e.g. `42` or `42 / 280`. */
  readonly text: string
  /** True only when a positive limit is set and the count exceeds it. */
  readonly over: boolean
}

/** `limit` undefined / non-finite / non-positive ≡ "no limit": bare count,
 *  never over. A positive limit yields `count / limit` and `over` once the
 *  count passes it (strictly greater — being exactly at the limit is fine). */
export const charCountDisplay = (count: number, limit?: number): CharCountDisplay => {
  const hasLimit = typeof limit === 'number' && Number.isFinite(limit) && limit > 0
  if (!hasLimit) return {text: String(count), over: false}
  return {text: `${count} / ${limit}`, over: count > limit}
}
