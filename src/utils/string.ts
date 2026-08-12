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

/** Truncate from the MIDDLE, keeping both ends (`Quarterly Plan…2026`).
 *  Result is always ≤ `max` chars, like {@link truncate}.
 *
 *  For NAMES rather than prose, the tail is usually where the identity
 *  lives — a year, a version, a number — while the head is shared boilerplate.
 *  End-truncating "Quarterly Planning Meeting Notes 2026" and its 2027
 *  sibling yields the same string for both, which is precisely the
 *  collision a name is being shown to resolve. Keep more of the head than
 *  the tail, since the head is what a reader scans first. */
export const truncateMiddle = (value: string, max: number): string => {
  if (value.length <= max) return value
  if (max <= 1) return '…'
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  return `${value.slice(0, head)}…${value.slice(value.length - (keep - head))}`
}
