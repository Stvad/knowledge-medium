// @vitest-environment node
/**
 * Fuzz suite for two independent LIKE-pattern properties in
 * `kernelQueries.ts` — see `src/test/fuzz.ts` for the smoke/deep tier
 * mechanics and `docs/fuzzing.md` for suite conventions.
 *
 * ──── Suite 1: `buildFuzzyAliasMatchesSql` exact/prefix match survives
 * the pre-filter LIMIT ────
 *
 * The alias-autocomplete pre-filter over-fetches with a permissive 3-char
 * trigram LIKE, then ranks in JS (`fuzzyRank.ts`). Its `LIMIT` must stay
 * behind an exact-then-prefix `ORDER BY`; unordered, a busy trigram can
 * evict the alias the user typed verbatim before the ranker ever sees it.
 *
 * Ground truth by CONSTRUCTION, which is what makes the property sound
 * without a second implementation to diff against: every decoy suffix is
 * generated with a reserved leading char ('d') a true-match suffix ('t')
 * can never share. A decoy therefore can never equal the query nor have
 * it as a prefix, so its ORDER BY tier is unconditionally 2 — strictly
 * below the true match's 0 (exact) or 1 (prefix) — whatever its content,
 * count, alphabetical order or creation order. The true match survives
 * any `limit >= 1`.
 *
 * ──── Suite 2: `escapeLikePattern` vs real SQLite ────
 *
 * Differential against the engine itself: each call site's actual
 * LIKE/ESCAPE fragment — copied verbatim, not re-derived, since a
 * re-derivation would test this suite's reading of the call site rather
 * than the call site — runs on a real connection and is checked against a
 * plain JS containment oracle, case-folded the way that site folds.
 *
 * Unicode scoping (deliberate): SQLite's built-in `LOWER()` and
 * case-insensitive `LIKE` fold ASCII `A-Z` only, so `'Émile' LIKE '%émi%'`
 * does not match. That is a pre-existing limitation of every one of these
 * call sites alike, not something `escapeLikePattern` causes or could fix,
 * and it would otherwise fail this property for an unrelated reason. The
 * generator's unicode bias therefore sticks to CASE-INVARIANT code points
 * (CJK, emoji, NBSP/ideographic space) plus ASCII, so a failure here
 * always points at escaping mechanics.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout, statefulFuzzGuard } from '@/test/fuzz'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { ChangeScope } from '@/data/api'
import { aliasesProp } from '@/data/properties'
import { buildFilterPrefixes } from '@/utils/fuzzyRank.js'
import { escapeLikePattern } from './kernelQueries'

const WS = 'ws-1'

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => {
  await guard.barrier()
  await sharedDb.cleanup()
})

/** Interrupt-barrier shared by both suites below — they both read/write
 *  the same `sharedDb`, so both must wrap every case in `guard.run` (see
 *  `statefulFuzzGuard`, `@/test/fuzz`, docs/fuzzing.md §6: "Adding a
 *  suite" point 6), not just the one with the per-case `resetTestDb`.
 *  Without it, an abandoned case from either suite (left running past a
 *  deep-tier `interruptAfterTimeLimit` interrupt) could still be
 *  querying `sharedDb.db` when the other suite's cases start, or when
 *  `afterAll` closes it. No `Math.random` pin is needed for either
 *  suite — suite 1's block `orderKey`s are explicit, non-jittered
 *  literals (`k${n}`) and suite 2 has no randomness to pin — so
 *  `seed: null` below skips the pin and keeps only the barrier. */
const guard = statefulFuzzGuard()

// ──── Suite 1: fuzzy-alias exact/prefix match survives the LIMIT ────

const LOWER_ALPHA = 'abcdefghijklmnopqrstuvwxyz'.split('')
const wordArb = (minLength: number, maxLength: number): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...LOWER_ALPHA), {minLength, maxLength}).map(a => a.join(''))

/** Reserved leading char keeps a true-match suffix structurally distinct
 *  from every decoy suffix (which reserves 'd') — see the module
 *  docblock's "ground truth by construction" note. */
const trueSuffixArb = wordArb(0, 6).map(s => `t${s}`)
const decoySuffixArb = wordArb(1, 6).map(s => `d${s}`)

const aliasFuzzyCaseArb = fc.record({
  prefix3: wordArb(3, 3),
  trueSuffix: trueSuffixArb,
  matchKind: fc.constantFrom('exact' as const, 'prefix' as const),
  extraSuffix: wordArb(1, 6),
  // Unique, not just arbitrary — a real workspace enforces one-claimant-
  // per-alias, so two decoys generated with the SAME suffix would collide
  // on a real alias-uniqueness rejection (a test-harness artifact, not
  // the property under test). `trueSuffix`'s reserved 't' already keeps
  // it out of this pool (which reserves 'd'), so uniqueness here is only
  // about decoy-vs-decoy collisions.
  decoySuffixes: fc.uniqueArray(decoySuffixArb, {minLength: 0, maxLength: 25}),
  truePosition: fc.nat(),
  limit: fc.integer({min: 1, max: 5}),
})

describe('buildFuzzyAliasMatchesSql — exact/prefix alias match survives the pre-filter LIMIT', () => {
  it('keeps the true match inside any limit>=1 window regardless of same-trigram decoy count/alphabetical/creation order', async () => {
    await fc.assert(
      fc.asyncProperty(aliasFuzzyCaseArb, async (c) => {
        await guard.run(null, async () => {
          await resetTestDb(sharedDb.db)
          const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})

          const query = `${c.prefix3}${c.trueSuffix}`
          const trueAlias = c.matchKind === 'exact' ? query : `${query}${c.extraSuffix}`

          const insertAt = c.decoySuffixes.length === 0
            ? 0
            : c.truePosition % (c.decoySuffixes.length + 1)

          let seq = 0
          const createAlias = async (id: string, alias: string) => {
            seq += 1
            await repo.tx(async tx => {
              await tx.create({
                id,
                workspaceId: WS,
                parentId: null,
                orderKey: `k${seq}`,
                content: '',
                properties: {[aliasesProp.name]: aliasesProp.codec.encode([alias])},
              })
            }, {scope: ChangeScope.BlockDefault})
          }

          for (let i = 0; i < c.decoySuffixes.length; i++) {
            if (i === insertAt) await createAlias('true-block', trueAlias)
            await createAlias(`decoy-${i}`, `${c.prefix3}${c.decoySuffixes[i]}`)
          }
          if (insertAt === c.decoySuffixes.length) await createAlias('true-block', trueAlias)

          const prefixes = buildFilterPrefixes(query)
          const rows = await repo.query.aliasMatchesFuzzy({
            workspaceId: WS,
            prefixes,
            query,
            limit: c.limit,
          }).load()

          expect(
            rows.some(r => r.blockId === 'true-block'),
            JSON.stringify({query, trueAlias, matchKind: c.matchKind, limit: c.limit, decoyCount: c.decoySuffixes.length, rows}),
          ).toBe(true)
        })
      }),
      fuzzParams(20),
    )
  }, fuzzTestTimeout())
})

// ──── Suite 2: escapeLikePattern vs real SQLite ────

const META_CHARS = ['%', '_', '\\']
const ASCII_LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
const DIGITS = '0123456789'.split('')
const SAFE_SYMBOLS = ' .,-!?()[]{}:;\'"@#$^&*+=/<>|~`'.split('')
// Deliberately case-INVARIANT unicode — see the module docblock's
// "Unicode scoping" note for why cased non-ASCII code points are
// excluded.
const CASE_INVARIANT_UNICODE = ['漢', '字', '🙂', '🚀', '日', '本', '中', '文', ' ', '　']

const charArb: fc.Arbitrary<string> = fc.oneof(
  {weight: 4, arbitrary: fc.constantFrom(...ASCII_LETTERS)},
  {weight: 3, arbitrary: fc.constantFrom(...META_CHARS)},
  {weight: 2, arbitrary: fc.constantFrom(...DIGITS)},
  {weight: 2, arbitrary: fc.constantFrom(...SAFE_SYMBOLS)},
  {weight: 1, arbitrary: fc.constantFrom(...CASE_INVARIANT_UNICODE)},
)
const likeStringArb = (maxLength: number): fc.Arbitrary<string> =>
  fc.array(charArb, {maxLength}).map(a => a.join(''))

/** Sometimes construct `needle` as a genuine substring of `haystack`
 *  (so the LIKE actually matches and the escaping of any embedded
 *  metacharacter is exercised on the "should match" side too);
 *  otherwise generate an unrelated random pair (usually "should not
 *  match", including a metachar in `needle` that ISN'T literally present
 *  in `haystack`). */
const needleHaystackArb: fc.Arbitrary<{haystack: string; needle: string}> = fc.oneof(
  fc.tuple(likeStringArb(8), likeStringArb(6), likeStringArb(8)).map(([pre, mid, post]) => ({
    haystack: pre + mid + post,
    needle: mid,
  })),
  fc.tuple(likeStringArb(20), likeStringArb(8)).map(([haystack, needle]) => ({haystack, needle})),
)

const jsLower = (s: string): string => s.toLowerCase()

interface Shape {
  name: string
  /** Bare scalar expression — no FROM clause needed. */
  sql: string
  params: (h: string, n: string) => unknown[]
  expected: (h: string, n: string) => boolean
}

/** Every shape below is the LIKE/ESCAPE fragment an actual kernelQueries.ts
 *  call site uses, verbatim, with the column/derived-value swapped for a
 *  bound literal. Kept case-fold-safe (see "Unicode scoping" above) by
 *  applying the SAME `jsLower` on both the SQL-bound values and the JS
 *  oracle — sound because the generator never produces a code point where
 *  SQLite's ASCII-only `LOWER()` and JS's `toLowerCase()` disagree. */
const SHAPES: readonly Shape[] = [
  {
    name: "content rank tiebreaker — LOWER(h) LIKE LOWER(escaped n) || '%' (kernelQueries.ts:287, searchByContentQuery)",
    sql: `SELECT (LOWER(?) LIKE LOWER(?) || '%' ESCAPE '\\') AS m`,
    params: (h, n) => [h, escapeLikePattern(n)],
    expected: (h, n) => jsLower(h).startsWith(jsLower(n)),
  },
  {
    name: "alias substring filter — alias_lower LIKE '%' || LOWER(escaped n) || '%' (kernelQueries.ts:319,428)",
    sql: `SELECT (? LIKE '%' || LOWER(?) || '%' ESCAPE '\\') AS m`,
    params: (h, n) => [jsLower(h), escapeLikePattern(n)],
    expected: (h, n) => jsLower(h).includes(jsLower(n)),
  },
  {
    name: "alias prefix rank — alias_lower LIKE LOWER(escaped n) || '%' (kernelQueries.ts:324,432)",
    sql: `SELECT (? LIKE LOWER(?) || '%' ESCAPE '\\') AS m`,
    params: (h, n) => [jsLower(h), escapeLikePattern(n)],
    expected: (h, n) => jsLower(h).startsWith(jsLower(n)),
  },
  {
    name: "fuzzy-alias prefilter substring — alias_lower LIKE '%' || escaped(lower n) || '%' (kernelQueries.ts:391)",
    sql: `SELECT (? LIKE '%' || ? || '%' ESCAPE '\\') AS m`,
    params: (h, n) => [jsLower(h), escapeLikePattern(jsLower(n))],
    expected: (h, n) => jsLower(h).includes(jsLower(n)),
  },
  {
    name: "fuzzy-alias exact/prefix rank — alias_lower LIKE escaped(lower n) || '%' (kernelQueries.ts:407)",
    sql: `SELECT (? LIKE ? || '%' ESCAPE '\\') AS m`,
    params: (h, n) => [jsLower(h), escapeLikePattern(jsLower(n))],
    expected: (h, n) => jsLower(h).startsWith(jsLower(n)),
  },
]

describe('escapeLikePattern — differential vs real SQLite for every call-site LIKE/ESCAPE shape', () => {
  it('matches a case-folded JS containment check for arbitrary needle/haystack, including % _ \\ and case-invariant unicode', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...SHAPES), needleHaystackArb, async (shape, {haystack, needle}) =>
        guard.run(null, async () => {
          const row = await sharedDb.db.get<{m: number}>(shape.sql, shape.params(haystack, needle))
          expect(row.m === 1, JSON.stringify({shape: shape.name, haystack, needle}))
            .toBe(shape.expected(haystack, needle))
        })),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())
})
