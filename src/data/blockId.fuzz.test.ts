// @vitest-environment node
/**
 * Fuzz suite for `assertCanonicalBlockId` (issue #456) — see
 * `src/test/fuzz.ts` for the smoke/deep tier mechanics.
 *
 * Oracle: an INDEPENDENT reference implementation of "is this a canonical
 * lowercase UUID" — character-by-character index math, not
 * `CANONICAL_BLOCK_ID_RE` itself. A property that just re-ran the same
 * regex and asserted agreement with itself would be tautological (this
 * repo's stated dominant review finding on the previous fuzz batch); this
 * one can catch a REAL divergence — e.g. an off-by-one in a hyphen
 * position, or a stray `i` flag reappearing — because the two
 * implementations don't share code.
 *
 * A second property checks the two structural invariants the arbitrary
 * random-string property is too sparse to hit on its own (fast-check
 * essentially never generates a 36-character string by chance): flipping
 * any single hex letter to uppercase must flip acceptance to rejection
 * (case IS the contract), and every id `uuidv4()`/`uuidv5()` can actually
 * produce is always accepted (both mint through the same `uuid` package
 * production code minting uses, so this is an integration check against
 * the real generators, not a synthetic one).
 */
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import { assertCanonicalBlockId, InvalidBlockIdError } from './blockId.ts'

/** Independent reference model — deliberately NOT built from
 *  CANONICAL_BLOCK_ID_RE or its source. Walks the string by index and
 *  checks each position against the 8-4-4-4-12 grouping by hand. */
const isCanonicalUuidReference = (s: string): boolean => {
  const groupLengths = [8, 4, 4, 4, 12]
  const isLowerHex = (c: string): boolean =>
    (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')

  let i = 0
  for (let g = 0; g < groupLengths.length; g++) {
    for (let j = 0; j < groupLengths[g]; j++) {
      if (i >= s.length || !isLowerHex(s[i])) return false
      i++
    }
    const isLastGroup = g === groupLengths.length - 1
    if (!isLastGroup) {
      if (i >= s.length || s[i] !== '-') return false
      i++
    }
  }
  return i === s.length
}

describe('assertCanonicalBlockId (fuzz)', () => {
  it('agrees with an independent reference model over arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({maxLength: 60}), s => {
        const accepted = isCanonicalUuidReference(s)
        if (accepted) {
          expect(() => assertCanonicalBlockId(s, 'test')).not.toThrow()
        } else {
          expect(() => assertCanonicalBlockId(s, 'test')).toThrow(InvalidBlockIdError)
        }
      }),
      fuzzParams(500),
    )
  }, fuzzTestTimeout())

  it('accepts every id the real minters can actually produce', () => {
    fc.assert(
      fc.property(fc.string(), name => {
        // uuidv4() exercises the same random minting repo.ts's default
        // newId() uses; uuidv5 with an arbitrary name+namespace covers the
        // deterministic-minting family (journalBlockId/dailyNoteBlockId/...
        // are all uuidv5 under a fixed namespace with a varying name).
        expect(() => assertCanonicalBlockId(uuidv4(), 'test')).not.toThrow()
        const namespace = uuidv4()
        expect(() => assertCanonicalBlockId(uuidv5(name, namespace), 'test')).not.toThrow()
      }),
      fuzzParams(200),
    )
  }, fuzzTestTimeout())

  it('flipping any single hex letter to uppercase turns acceptance into rejection', () => {
    fc.assert(
      fc.property(fc.uuid(), fc.nat(), (id, seed) => {
        const letterIndices = [...id].reduce<number[]>((acc, c, idx) => {
          if (c >= 'a' && c <= 'f') acc.push(idx)
          return acc
        }, [])
        // Every real UUID has at least one hex letter with overwhelming
        // probability (16 hex positions minus the 4 fixed version/variant
        // nibbles), but skip the astronomically rare all-digit case rather
        // than assume it can't happen.
        if (letterIndices.length === 0) return
        const idx = letterIndices[seed % letterIndices.length]
        const flipped = id.slice(0, idx) + id[idx].toUpperCase() + id.slice(idx + 1)
        expect(() => assertCanonicalBlockId(id, 'test')).not.toThrow()
        expect(() => assertCanonicalBlockId(flipped, 'test')).toThrow(InvalidBlockIdError)
      }),
      fuzzParams(200),
    )
  }, fuzzTestTimeout())
})
