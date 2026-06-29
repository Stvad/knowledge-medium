/** Truncate `value` to at most `max` characters, replacing the overflow with a
 *  single ellipsis (`…`). Strings already within `max` are returned unchanged.
 *  The result is always ≤ `max` chars — the ellipsis occupies the last slot. */
export const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value
