/** Does `value` contain a UTF-16 code unit with no partner — the artefact of
 *  cutting a string mid-character, or of text that was never well-formed?
 *
 *  `String.prototype.isWellFormed` is exactly this predicate, but it is ES2024
 *  and this project's `lib` is ES2023. Worth having in one place rather than
 *  per-caller: an ill-formed string is not merely ugly, it does not SURVIVE —
 *  `TextEncoder` and the SQLite text columns both replace a lone surrogate
 *  with U+FFFD, so anything that stores or hashes such text loses it. */
export const hasLoneSurrogate = (value: string): boolean =>
  LONE_SURROGATE_RE.test(value)

const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** Truncate `value` to at most `max` characters, replacing the overflow with a
 *  single ellipsis (`…`). Strings already within `max` are returned unchanged.
 *  The result is always ≤ `max` chars — the ellipsis occupies the last slot. */
export const truncate = (value: string, max: number): string => {
  // `.length` is UTF-16 units, so slicing by it can cut an astral character
  // (emoji, many CJK extensions) in half and render a replacement glyph.
  // Counted in code points instead — but only once the cheap check says
  // truncation is even possible, since unit-length ≤ max implies
  // code-point-length ≤ max and the common case allocates nothing.
  if (value.length <= max) return value
  const chars = [...value]
  if (chars.length <= max) return value
  return `${chars.slice(0, max - 1).join('')}…`
}

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
  // Code points, not UTF-16 units — see {@link truncate}. Both cut points
  // matter here, so an astral character near either one would break.
  const chars = [...value]
  if (chars.length <= max) return value
  if (max <= 1) return '…'
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - (keep - head)).join('')}`
}
