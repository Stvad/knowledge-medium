//
// Naming a few members of a counted set, in a sentence a person reads.
//
// The rule that is easy to get wrong: "and N more" must be derived from the
// set's own count, never from the list handed around. Lists reaching a sentence
// are usually already capped by whatever produced them, so counting off the
// array under-reports by exactly what the cap dropped — and does it silently.

/** Names shown before the rest is summarised. Past three, a toast line or a
 *  consent paragraph stops being read, and the count beside it is what carries
 *  the scale. */
export const NAMES_IN_A_SENTENCE = 3

/** The members to name, and how many exist beyond them.
 *
 *  `total` is separate from `items.length` because `items` may already be
 *  capped; pass the exact count whenever one is known. */
export const firstFew = <T,>(
  items: readonly T[],
  total: number = items.length,
): {shown: readonly T[]; more: number} => {
  const shown = items.slice(0, NAMES_IN_A_SENTENCE)
  return {shown, more: Math.max(0, total - shown.length)}
}

/** `"a", "b" and 4 more`, for plain text. Quoted because a name may contain a
 *  comma, and an unquoted join then reads as two names. */
export const describeNames = (
  names: readonly string[],
  total: number = names.length,
): string => {
  const {shown, more} = firstFew(names, total)
  const named = shown.map(name => JSON.stringify(name)).join(', ')
  return more > 0 ? `${named} and ${more} more` : named
}
