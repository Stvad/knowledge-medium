/** Truncate `value` to at most `max` characters, replacing the overflow with a
 *  single ellipsis (`…`). Strings already within `max` are returned unchanged.
 *  The result is always ≤ `max` chars — the ellipsis occupies the last slot. */
export const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value

/** The first line of `value`, or `''` if it starts with a break. Handles CR,
 *  LF and CRLF alike. The one-line reduction every block PREVIEW surface
 *  needs — a crumb, a breadcrumb label, a collapsed row — where multi-line
 *  content has to render as a single line without wrapping. */
export const firstLine = (value: string): string => value.match(/^[^\r\n]*/)?.[0] ?? ''
