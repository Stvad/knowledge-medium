import fc from 'fast-check'

/**
 * Shared markdown line-fragment arbitraries, used by both
 * `src/utils/test/markdownParser.fuzz.test.ts` (fuzzing `parseMarkdownToBlocks`
 * directly) and `src/paste/test/operations.fuzz.test.ts` (fuzzing the paste
 * planners, which call the same parser on pasted text).
 *
 * These generate single-line *fragments* biased toward the parser's meta
 * tokens (indentation, bullet/header/fence markers) plus unconstrained
 * strings. Suite-specific top-level composition — how fragments are joined
 * into a document, line-ending handling, whitespace-only/empty special
 * cases, etc. — stays local to each fuzz suite; only the fragment-level
 * pieces live here.
 *
 * Sharing this corpus is a coverage feature, not just dedup: both parsers
 * get fuzzed on the *same* fragment family, so a case that shrinks small
 * against one is directly reproducible against the other, and improving the
 * corpus (e.g. adding a new meta-token shape) benefits both suites at once.
 *
 * Where the two original copies had drifted (fence marker set, tabs in
 * indentation, grapheme-composite words), this module exports the *union* of
 * their capabilities, so neither suite loses coverage it previously had.
 */

/** Leading whitespace: 0-8 spaces or 0-3 tabs (union of both suites' ranges — the wider still covers the narrower). */
const indentSpacesArb = fc.integer({min: 0, max: 8}).map(n => ' '.repeat(n))
const indentTabsArb = fc.integer({min: 0, max: 3}).map(n => '\t'.repeat(n))
export const indentArb = fc.oneof(indentSpacesArb, indentTabsArb)

export const bulletMarkerArb = fc.constantFrom('- ', '* ', '+ ')
export const headerMarkerArb = fc.integer({min: 1, max: 6}).map(n => '#'.repeat(n) + ' ')

/** Union of both suites' fence marker sets (markdownParser also probed the 5-tilde variant). */
export const fenceMarkerArb = fc.constantFrom('```', '~~~', '````', '~~~~~')

/** Union of both suites' word generators: plain strings plus grapheme-composite strings (operations added the latter). */
export const wordArb = fc.oneof(
  fc.string({maxLength: 8}),
  fc.string({maxLength: 8, unit: 'grapheme-composite'}),
)

/**
 * Line fragments biased toward the grammar's meta tokens (indentation,
 * bullets, headers, fences), plus a slice of totally unconstrained strings
 * (may themselves embed \n / control chars / tabs) so the corpus isn't
 * limited to "one arbitrary token per line".
 */
export const lineFragmentArb = fc.oneof(
  {arbitrary: fc.constant(''), weight: 2}, // empty/blank line
  {
    arbitrary: fc.tuple(indentArb, bulletMarkerArb, wordArb).map(([i, m, w]) => i + m + w),
    weight: 3,
  },
  {
    arbitrary: fc.tuple(indentArb, headerMarkerArb, wordArb).map(([i, m, w]) => i + m + w),
    weight: 2,
  },
  {
    arbitrary: fc.tuple(indentArb, fenceMarkerArb, wordArb).map(([i, f, w]) => i + f + w),
    weight: 2,
  },
  {arbitrary: fc.tuple(indentArb, wordArb).map(([i, w]) => i + w), weight: 3},
  {arbitrary: fc.string({maxLength: 15}), weight: 2}, // totally random string
)
