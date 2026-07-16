// @vitest-environment node
/**
 * Fuzz suite for the fuzzy + recency ranker in `src/utils/fuzzyRank.ts`. See
 * `src/test/fuzz.ts` for smoke/deep tier mechanics and `docs/fuzzing.md` for
 * conventions. Example-based coverage lives in `./fuzzyRank.test.ts`.
 *
 * `now` is always injected explicitly (never `Date.now()`), matching the
 * `RankInputs.now` contract at fuzzyRank.ts:51.
 *
 * ──── Properties ────
 * P1 totality — `tokenize` / `buildFilterPrefixes` / `scoreCandidate` /
 *    `rankCandidates` never throw on arbitrary unicode (incl. unpaired
 *    surrogates), empty, or long labels/queries.
 * P2 subset-soundness — `rankCandidates` output blockIds are a subset of the
 *    input blockIds (fuzzyRank.ts:208-230: one `push` per surviving
 *    candidate, `blockId` carried through unchanged from the input object),
 *    with no duplicates given a unique-blockId input.
 * P3 determinism + idempotence with injected `now` — identical inputs
 *    produce identical output, and re-ranking the ranked candidates with the
 *    same query/now/recentBlockIds reproduces the same order (the function
 *    is pure over the candidate *set*, not sensitive to input order —
 *    fuzzyRank.ts:213-239).
 * P4 comparator consistency — an independent reimplementation of the
 *    documented tie-break (score desc, then label length asc, then
 *    `localeCompare` — fuzzyRank.ts:232-238) orders the real output
 *    (adjacent-pair check against a valid total preorder).
 * P5 exact-match dominance (`SCORE_FULL_EXACT`, fuzzyRank.ts:21,195) —
 *    `lowerLabel === lowerQuery` outranks a same-token, equal-recency
 *    non-exact (prefix) rival.
 * P6 `editDistanceAtMostOne` symmetry (fuzzyRank.ts:85-117). Not exported,
 *    and every real call site invokes it with a fixed argument order
 *    (`editDistanceAtMostOne(textSlice, token)` inside `hasTypoSubstring`,
 *    fuzzyRank.ts:125) — so pure symmetry isn't observable through the
 *    public API by itself. P6a first anchors a verbatim mirror of
 *    `editDistanceAtMostOne` + `hasTypoSubstring` (fuzzyRank.ts:85-129)
 *    against the REAL `scoreCandidate`'s observable typo-match decision, so
 *    the mirror is checked to behave like the shipped code in the same
 *    suite run, not just internally consistent. P6b then tests the
 *    now-anchored mirror's symmetry as a pure algebraic law.
 * P7 literal-substring tokens never score null (`scoreToken`'s `indexOf`
 *    branch, fuzzyRank.ts:133-146) — a token literally present in the label
 *    always contributes a non-null score.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams } from '@/test/fuzz'
import {
  buildFilterPrefixes,
  rankCandidates,
  scoreCandidate,
  tokenize,
  type RankableCandidate,
  type RankedCandidate,
} from '../fuzzyRank'

const NOW = 1_700_000_000_000

// ──── P1: totality ────

/** Arbitrary UTF-16 content incl. unpaired surrogates, mirrors the soup
 *  style in routing.fuzz.test.ts. */
const wildStringArb = (maxLength: number) => fc.string({unit: 'binary', maxLength})

describe('totality: tokenize / buildFilterPrefixes / scoreCandidate / rankCandidates never throw', () => {
  it('on arbitrary unicode/empty/long labels and queries', () => {
    fc.assert(
      fc.property(wildStringArb(60), wildStringArb(30), (label, query) => {
        let tokens: string[] = []
        expect(() => {
          tokens = tokenize(query)
        }).not.toThrow()
        expect(Array.isArray(tokens)).toBe(true)

        expect(() => buildFilterPrefixes(query)).not.toThrow()

        let scored: number | null = null
        expect(() => {
          scored = scoreCandidate(label, query, tokens)
        }).not.toThrow()
        expect(scored === null || typeof scored === 'number').toBe(true)

        let ranked: RankedCandidate<RankableCandidate>[] = []
        expect(() => {
          ranked = rankCandidates({
            candidates: [{blockId: 'x', label}],
            query,
            now: NOW,
          })
        }).not.toThrow()
        expect(Array.isArray(ranked)).toBe(true)
      }),
      fuzzParams(300),
    )
  })
})

// ──── Shared candidate-set generator (P2, P3, P4) ────

const candidateSeedArb = fc.record({
  label: fc.string({unit: 'grapheme', maxLength: 20}),
  updatedAt: fc.option(fc.integer({min: 0, max: 2_000_000_000_000}), {nil: undefined}),
})

/** Unique blockIds by construction (index-derived) — the property under
 *  test (subset-soundness) needs an unambiguous input identity set to check
 *  against; `rankCandidates` itself performs no de-duplication. */
const candidatesArb: fc.Arbitrary<RankableCandidate[]> = fc
  .array(candidateSeedArb, {maxLength: 15})
  .map(seeds => seeds.map((s, i) => ({blockId: `c${i}`, ...s})))

const rankInputsArb = candidatesArb.chain(candidates => {
  const ids = candidates.map(c => c.blockId)
  return fc.record({
    candidates: fc.constant(candidates),
    query: fc.string({unit: 'grapheme', maxLength: 15}),
    recentBlockIds: fc.option(
      fc.oneof(
        fc.shuffledSubarray(ids),
        fc.array(fc.string({maxLength: 5}), {maxLength: 5}),
      ),
      {nil: undefined},
    ),
    now: fc.integer({min: 0, max: 3_000_000_000_000}),
  })
})

// ──── P2: subset-soundness ────

describe('rankCandidates: subset-soundness', () => {
  it('output blockIds are a subset of the input, with no duplicates (fuzzyRank.ts:208-230)', () => {
    fc.assert(
      fc.property(rankInputsArb, ({candidates, query, recentBlockIds, now}) => {
        const result = rankCandidates({candidates, query, recentBlockIds, now})
        const inputIds = new Set(candidates.map(c => c.blockId))
        const outputIds = result.map(r => r.candidate.blockId)
        for (const id of outputIds) expect(inputIds.has(id)).toBe(true)
        expect(new Set(outputIds).size).toBe(outputIds.length)
      }),
      fuzzParams(200),
    )
  })
})

// ──── P3: determinism + idempotence ────

describe('rankCandidates: determinism + idempotence', () => {
  it('identical inputs (incl. injected now) produce identical output', () => {
    fc.assert(
      fc.property(rankInputsArb, ({candidates, query, recentBlockIds, now}) => {
        const once = rankCandidates({candidates, query, recentBlockIds, now})
        const twice = rankCandidates({candidates, query, recentBlockIds, now})
        expect(twice).toEqual(once)
      }),
      fuzzParams(200),
    )
  })

  it('re-ranking the ranked candidate set (same query/now/recentBlockIds) reproduces the same order', () => {
    fc.assert(
      fc.property(rankInputsArb, ({candidates, query, recentBlockIds, now}) => {
        const ranked = rankCandidates({candidates, query, recentBlockIds, now})
        const rerankedCandidates = ranked.map(r => r.candidate)
        const reranked = rankCandidates({candidates: rerankedCandidates, query, recentBlockIds, now})
        // rankCandidates is a pure function of the candidate SET plus
        // query/now/recentBlockIds (fuzzyRank.ts:213-239) — reordering the
        // input (as ranking already did) must not change the output order.
        expect(reranked.map(r => r.candidate.blockId)).toEqual(ranked.map(r => r.candidate.blockId))
        expect(reranked.map(r => r.score)).toEqual(ranked.map(r => r.score))
      }),
      fuzzParams(200),
    )
  })
})

// ──── P4: comparator consistency ────

/** Independent reimplementation of the documented tie-break
 *  (fuzzyRank.ts:232-238): score desc, then label length asc, then
 *  `localeCompare` — using the same `String.prototype.localeCompare` call
 *  (no re-derivation of locale semantics, only the ordering LAW is
 *  reimplemented). */
const documentedComparator = <C extends RankableCandidate>(a: RankedCandidate<C>, b: RankedCandidate<C>): number => {
  if (b.score !== a.score) return b.score - a.score
  const la = a.candidate.label.length
  const lb = b.candidate.label.length
  if (la !== lb) return la - lb
  return a.candidate.label.localeCompare(b.candidate.label)
}

describe('rankCandidates: comparator consistency', () => {
  it('output is sorted under the documented tie-break law (fuzzyRank.ts:232-238)', () => {
    fc.assert(
      fc.property(rankInputsArb, ({candidates, query, recentBlockIds, now}) => {
        const result = rankCandidates({candidates, query, recentBlockIds, now})
        for (let i = 0; i + 1 < result.length; i++) {
          // Every adjacent pair must already be in non-decreasing order
          // under the documented comparator law — i.e. the output is a
          // valid sort under that law, not merely "some order".
          expect(documentedComparator(result[i], result[i + 1])).toBeLessThanOrEqual(0)
        }
      }),
      fuzzParams(200),
    )
  })
})

// ──── P5: exact-match dominance ────

const asciiWordArb = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {minLength: 1, maxLength: 10})
  .map(cs => cs.join(''))

describe('scoreCandidate / rankCandidates: exact-match dominance (SCORE_FULL_EXACT, fuzzyRank.ts:21,195)', () => {
  it('an exact lowerLabel===lowerQuery candidate outranks a same-token prefix rival at equal (zero) recency', () => {
    fc.assert(
      fc.property(asciiWordArb, asciiWordArb, fc.boolean(), (word, suffix, upperCase) => {
        const exactLabel = upperCase ? word.toUpperCase() : word
        const nonExactLabel = word + suffix // startsWith(word), never equal to word
        const query = word

        const exactScore = scoreCandidate(exactLabel, query, tokenize(query))
        const nonExactScore = scoreCandidate(nonExactLabel, query, tokenize(query))
        expect(exactScore).not.toBeNull()
        expect(nonExactScore).not.toBeNull()
        expect(exactScore!).toBeGreaterThan(nonExactScore!)

        // Integration check: the same dominance holds through the full
        // ranking pipeline, with explicit equal (absent) recency inputs for
        // both candidates.
        const ranked = rankCandidates({
          candidates: [
            {blockId: 'nonexact', label: nonExactLabel},
            {blockId: 'exact', label: exactLabel},
          ],
          query,
          now: NOW,
        })
        expect(ranked[0].candidate.blockId).toBe('exact')
      }),
      fuzzParams(150),
    )
  })
})

// ──── P6: editDistanceAtMostOne symmetry, anchored against real scoreCandidate ────

// Mirrors fuzzyRank.ts:19 (not exported by the source).
const TYPO_MIN_TOKEN_LEN = 4
// Mirrors fuzzyRank.ts:26 (not exported by the source).
const SCORE_TOKEN_TYPO = 4

// Verbatim port of fuzzyRank.ts:85-117 (not exported by the source) — see
// suite docblock P6 for why this is anchored against the real exported
// surface rather than trusted as a standalone reimplementation.
const mirrorEditDistanceAtMostOne = (a: string, b: string): boolean => {
  if (a === b) return true
  const diff = a.length - b.length
  if (diff > 1 || diff < -1) return false

  if (a.length === b.length) {
    let mismatches = 0
    for (let i = 0; i < a.length; i++) {
      if (a.charCodeAt(i) !== b.charCodeAt(i)) {
        mismatches++
        if (mismatches > 1) return false
      }
    }
    return true
  }

  const shorter = a.length < b.length ? a : b
  const longer = a.length < b.length ? b : a
  let i = 0
  let j = 0
  let edits = 0
  while (i < shorter.length && j < longer.length) {
    if (shorter.charCodeAt(i) === longer.charCodeAt(j)) {
      i++
      j++
    } else {
      edits++
      if (edits > 1) return false
      j++
    }
  }
  return true
}

// Verbatim port of fuzzyRank.ts:119-129 (not exported by the source).
const mirrorHasTypoSubstring = (text: string, token: string): boolean => {
  if (token.length < TYPO_MIN_TOKEN_LEN) return false
  for (let i = 0; i <= text.length; i++) {
    for (const delta of [-1, 0, 1]) {
      const subLen = token.length + delta
      if (subLen <= 0 || i + subLen > text.length) continue
      if (mirrorEditDistanceAtMostOne(text.slice(i, i + subLen), token)) return true
    }
  }
  return false
}

const tokenArb = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), {minLength: TYPO_MIN_TOKEN_LEN, maxLength: 9})
  .map(cs => cs.join(''))

/** Ascii soup surrounding an embedded token/near-miss — see call sites for
 *  how prefix/suffix are combined with a token to bias generation toward
 *  both the literal-substring and typo-match branches. */
const typoNoiseArb = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {maxLength: 10})
  .map(cs => cs.join(''))

/** A single-character insertion/deletion/substitution applied to `word` —
 *  by construction at edit distance <= 1 from `word` itself, so embedding
 *  it (rather than raw noise) biases generation toward actually exercising
 *  `hasTypoSubstring`'s true branch instead of almost always missing. */
const singleEditArb = (word: string): fc.Arbitrary<string> => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz'.split('')
  const deletion = fc.integer({min: 0, max: word.length - 1}).map(i => word.slice(0, i) + word.slice(i + 1))
  const insertion = fc
    .tuple(fc.integer({min: 0, max: word.length}), fc.constantFrom(...alphabet))
    .map(([i, c]) => word.slice(0, i) + c + word.slice(i))
  const substitution = fc
    .tuple(fc.integer({min: 0, max: word.length - 1}), fc.constantFrom(...alphabet))
    .map(([i, c]) => word.slice(0, i) + c + word.slice(i + 1))
  return fc.oneof(deletion, insertion, substitution)
}

const p6aCaseArb = tokenArb.chain(token =>
  fc.record({
    token: fc.constant(token),
    prefix: typoNoiseArb,
    suffix: typoNoiseArb,
    // Half the time a near-miss of the token (likely hits the typo-match
    // true branch), half the time unrelated noise (likely the false
    // branch) — covers both sides of hasTypoSubstring's decision.
    core: fc.oneof(singleEditArb(token), typoNoiseArb),
  }),
)

describe("editDistanceAtMostOne / hasTypoSubstring mirror (fuzzyRank.ts:85-129, not exported)", () => {
  it('P6a: mirror agrees with the REAL scoreCandidate typo-match decision', () => {
    fc.assert(
      fc.property(p6aCaseArb, ({token, prefix, suffix, core}) => {
        const label = prefix + core + suffix
        const lowerLabel = label.toLowerCase()
        // Isolate the typo-only branch: when the token is NOT a literal
        // substring of the label, scoreToken (fuzzyRank.ts:133-146) falls
        // through past both indexOf branches to hasTypoSubstring, and — for
        // a single-token query equal to the token — the whole-query
        // exact/prefix/substring bonus (fuzzyRank.ts:194-198) is
        // structurally 0 too (exact/prefix/substring all imply the same
        // `indexOf !== -1` fact this `fc.pre` excludes). So scoreCandidate
        // reduces exactly to `hasTypoSubstring(lowerLabel, token) ? 4 : null`.
        fc.pre(lowerLabel.indexOf(token) === -1)

        const real = scoreCandidate(label, token, [token])
        const mirrored = mirrorHasTypoSubstring(lowerLabel, token)
        if (mirrored) expect(real).toBe(SCORE_TOKEN_TYPO)
        else expect(real).toBeNull()
      }),
      fuzzParams(150),
    )
  })

  it('P6b: editDistanceAtMostOne mirror is symmetric — editDistanceAtMostOne(a,b) === editDistanceAtMostOne(b,a)', () => {
    fc.assert(
      fc.property(wildStringArb(12), wildStringArb(12), (a, b) => {
        expect(mirrorEditDistanceAtMostOne(a, b)).toBe(mirrorEditDistanceAtMostOne(b, a))
      }),
      fuzzParams(300),
    )
  })
})

// ──── P7: literal-substring tokens never score null ────

describe("scoreCandidate: literal-substring tokens never score null (scoreToken's indexOf branch, fuzzyRank.ts:133-146)", () => {
  it('a token literally present in the label always contributes a non-null score', () => {
    fc.assert(
      fc.property(tokenArb, typoNoiseArb, typoNoiseArb, (token, prefix, suffix) => {
        const label = prefix + token + suffix
        const result = scoreCandidate(label, token, [token])
        // scoreToken can only return null via the hasTypoSubstring/no-match
        // path (fuzzyRank.ts:144-145), which is unreachable once
        // `lowerText.indexOf(token)` is >= 0 — one of the two `idx`
        // branches (133-142) always fires instead.
        expect(result).not.toBeNull()
      }),
      fuzzParams(150),
    )
  })
})
