/** Pure per-text counters behind the built-in count profiles. */

export const countCharacters = (text: string): number => text.length

const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u

/** Whitespace-separated tokens that contain a letter or digit, so markdown
 *  markers (`-`, `**`, `[ ]`) and bare punctuation don't count while a link or
 *  a `[[Page name]]` counts like the words it shows. */
export const countWords = (text: string): number => {
  let words = 0
  for (const token of text.split(/\s+/)) {
    if (HAS_LETTER_OR_DIGIT.test(token)) words++
  }
  return words
}
