import fc from 'fast-check'

/**
 * A single arbitrary UTF-16 CODE UNIT, so a string built from it carries
 * unpaired surrogates at random positions.
 *
 * Reach for this, not `fc.string({unit: 'binary'})`, whenever a suite means
 * ill-formed UTF-16: `'binary'` draws whole code POINTS from a range that
 * excludes the surrogate block, so the surrogates it produces are always
 * correctly PAIRED. `'binary'` remains the right unit for astral coverage —
 * the two are complementary, and several suites draw from both.
 */
export const utf16UnitArb: fc.Arbitrary<string> =
  fc.integer({min: 0, max: 0xffff}).map(c => String.fromCharCode(c))
