/** `3 blocks` / `1 block`. The plural defaults to `${singular}s`; pass it for
 *  the words that do not (`match` → `matches`).
 *
 *  Counted-noun labels only. For agreement WITHIN a sentence — "1 property has"
 *  vs "2 properties have" — reach for {@link agree}, which is the half that
 *  otherwise gets hand-written as a ternary per clause. */
export const pluralize = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`

/** The verb or pronoun that agrees with `count` — `agree(n, 'has', 'have')`. */
export const agree = (count: number, singular: string, plural: string): string =>
  count === 1 ? singular : plural
