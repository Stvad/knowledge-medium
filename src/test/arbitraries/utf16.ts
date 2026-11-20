import fc from 'fast-check'

/**
 * A single arbitrary UTF-16 CODE UNIT, so a string built from it carries
 * unpaired surrogates at random positions.
 *
 * Reach for this, not {@link codePointUnitArb}, whenever a suite means
 * ill-formed UTF-16: a code point unit draws from a range that excludes the
 * surrogate block, so the surrogates it produces are always correctly PAIRED.
 * The code point unit remains the right one for astral coverage — the two are
 * complementary, and several suites draw from both.
 */
export const utf16UnitArb: fc.Arbitrary<string> =
  fc.integer({min: 0, max: 0xffff}).map(c => String.fromCharCode(c))

const SURROGATE_BLOCK_START = 0xd800
const SURROGATE_BLOCK_SIZE = 0x800

/**
 * A single Unicode CODE POINT outside the surrogate block, astral included:
 * `fc.string({unit: codePointUnitArb})` generates and shrinks exactly what
 * `fc.string({unit: 'binary'})` does, seed for seed. Use it instead of
 * `'binary'`, whose first construction in a test file builds a reverse map of
 * all 1.1M code points; the unmapper below answers the same question by
 * arithmetic. The unmapper is what keeps fast-check's injected
 * dangerous strings (`__proto__`, …) in the generated set.
 */
export const codePointUnitArb: fc.Arbitrary<string> = fc
  .nat({max: 0x10ffff - SURROGATE_BLOCK_SIZE})
  .map(
    index => String.fromCodePoint(index < SURROGATE_BLOCK_START ? index : index + SURROGATE_BLOCK_SIZE),
    value => {
      const codePoint = typeof value === 'string' ? value.codePointAt(0) : undefined
      const isOneCodePoint = codePoint !== undefined && String.fromCodePoint(codePoint) === value
      if (!isOneCodePoint || (codePoint >= SURROGATE_BLOCK_START && codePoint < SURROGATE_BLOCK_START + SURROGATE_BLOCK_SIZE)) {
        throw new Error('not a single non-surrogate code point')
      }
      return codePoint < SURROGATE_BLOCK_START ? codePoint : codePoint - SURROGATE_BLOCK_SIZE
    },
  )
