// @vitest-environment node
/**
 * Fuzz suite for `searchBlocksAcrossSources` + `freshestCandidatePayload`
 * (`../linkTargetAutocomplete.ts:367-457`, `freshestCandidatePayload` at
 * :328-365) — the `searchSourcesFacet` merge point behind quick-find /
 * wikilink autocomplete, block-ref insertion completion, and the agent
 * `search` command. See `src/test/fuzz.ts` for the smoke/deep tier
 * mechanics and `docs/fuzzing.md` for suite conventions. Complements the
 * example-based coverage in `linkTargetAutocomplete.test.ts`'s
 * "searchBlocksAcrossSources (searchSourcesFacet merge point)" describe
 * block.
 *
 * ──── Algorithm under test (linkTargetAutocomplete.ts:401-457) ────
 *
 * `limit <= 0` short-circuits to `[]` (:405) WITHOUT invoking any source.
 * Otherwise every contributed source's `search` runs concurrently
 * (`Promise.all`, :413-423); a throw is caught, logged, and contributes
 * NOTHING (an empty list) — UNLESS every source throws, in which case the
 * FIRST one by registration order (not settle/catch order — `failures`
 * is sorted by `index` before rethrow, :429-432) is rethrown. Surviving
 * candidates are flattened and grouped by block id in
 * registration-then-within-source order (:434-446); each group's
 * surviving `score` is the MAX across every duplicate in the group, and
 * its surviving `block` payload is picked by `freshestCandidatePayload`
 * (:328-365) evaluated over the WHOLE group at once — newest
 * `userUpdatedAt` wins among candidates that have one (ties broken by
 * higher score), else the higher-scored candidate wins. The result is
 * sorted by score descending and sliced to `limit` (:453-456).
 *
 * FUZZ-FOUND HISTORY (issue #450): an earlier version of the merge point
 * built each group's winner via a SINGLE-PASS pairwise fold instead of
 * operating on the whole group at once, so the "existing" side of each
 * payload comparison already carried the running MAX score across every
 * prior duplicate rather than that specific candidate's own original
 * score — decoupling payload selection from the (timestamp, score) pair
 * actually being compared. For a 3+-way duplicate-id group with
 * mixed/missing timestamps this made PAYLOAD selection order-dependent
 * (the final `score` was always the true max regardless of order — only
 * the payload pick broke). A fuzz run caught it; the counterexample is
 * pinned as the deterministic canary below and the fold was replaced with
 * the whole-group selection this suite now models and additionally
 * checks for permutation-invariance (below) — see
 * `freshestCandidatePayload`'s docblock in the product file for the fixed
 * algorithm and the counterexample.
 *
 * ──── Generator design ────
 *
 * No DB: `repo` is a hand-built stub whose `facetRuntime.read(...)`
 * returns a `ReadonlyMap` of generated `SearchSourceContribution`s (per
 * the issue's "generated Maps of async fixtures" framing) — each one's
 * `search` resolves (with generated candidates) or rejects (with a
 * per-source-identified `Error`) after a random number of microtask
 * ticks, so settle order is randomized independently of registration
 * order on every case. The reference model
 * (`referenceMergeAndRank`/`pickFreshestPayload` below) is a SEPARATE,
 * differently-structured re-expression of the documented algorithm:
 * group-then-fold over a `Map<id, candidates[]>` (rather than production's
 * single flat `Map` mutated in one pass over the un-grouped, flattened
 * list), with each group's winner computed via max-then-filter-then-find
 * (rather than production's left-to-right `reduce`) — an independent
 * implementation to differential-test against, not a copy of the code
 * under test.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import type { BlockData } from '@/data/api'
import type { Repo } from '@/data/repo'
import type { SearchSourceContribution } from '@/data/facets.js'
import { searchBlocksAcrossSources } from '../linkTargetAutocomplete.ts'

const WS = 'ws-1'

// ──── shared fixtures ────

/** Microtask-only delay (no real timers) so settle order can be randomized
 *  across a fast-check case without adding wall-clock cost. */
const tick = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

/** A minimal-but-valid `BlockData`. `content` carries a per-occurrence tag
 *  (`sourceId#candidateIndex`) so payload survival can be asserted by
 *  more than just `id`. `userUpdatedAt` is deliberately allowed to carry
 *  a non-number (via the `as number` cast) to exercise
 *  `freshestCandidatePayload`'s defensive `typeof aTime === 'number'`
 *  branch — real rows can't have this, but the check exists for a
 *  reason (a stale/legacy index copy), so the oracle has to cover it. */
const makeBlockData = (id: string, userUpdatedAt: number | undefined, tag: string): BlockData => ({
  id,
  workspaceId: WS,
  parentId: null,
  orderKey: `key-${id}`,
  content: tag,
  properties: {},
  references: [],
  createdAt: 1,
  updatedAt: 1,
  userUpdatedAt: userUpdatedAt as number,
  createdBy: 'u',
  updatedBy: 'u',
  deleted: false,
})

interface Candidate {
  block: BlockData
  score: number
}

interface Plan {
  id: string
  ticks: number
  ok: boolean
  candidates: Candidate[] | undefined
  error: Error
}

const BLOCK_IDS = ['b0', 'b1', 'b2', 'b3', 'b4', 'b5'] as const

interface CandidateSpec {
  blockId: typeof BLOCK_IDS[number]
  score: number
  userUpdatedAt: number | undefined
}

const candidateSpecArb: fc.Arbitrary<CandidateSpec> = fc.record({
  blockId: fc.constantFrom(...BLOCK_IDS),
  score: fc.integer({min: 0, max: 500}),
  userUpdatedAt: fc.option(fc.integer({min: 0, max: 1000}), {nil: undefined}),
})

interface SourceSpec {
  ticks: number
  ok: boolean
  candidates: CandidateSpec[]
}

/** `alwaysOk`: when true, `ok` is pinned to `true` (used by the pure-merge
 *  property below, which isolates dedup/rank from failure handling). */
const sourceSpecArb = (alwaysOk: boolean): fc.Arbitrary<SourceSpec> => fc.record({
  ticks: fc.integer({min: 0, max: 4}),
  ok: alwaysOk ? fc.constant(true) : fc.boolean(),
  candidates: fc.array(candidateSpecArb, {maxLength: 4}),
})

/** Materializes generated specs into `Plan`s: real `BlockData`/`Error`
 *  object identities, assigned ONCE, shared between the production-facing
 *  source (built by {@link buildSource}) and the reference model — so a
 *  payload-identity assertion (`toEqual`, or `toBe` on the error) is
 *  meaningful rather than tautologically comparing freshly-constructed
 *  duplicates. */
const specsToPlans = (specs: readonly SourceSpec[]): Plan[] =>
  specs.map((spec, i) => {
    const id = `s${i}`
    return {
      id,
      ticks: spec.ticks,
      ok: spec.ok,
      candidates: spec.ok
        ? spec.candidates.map((c, ci): Candidate => ({
            score: c.score,
            block: makeBlockData(c.blockId, c.userUpdatedAt, `${id}#${ci}`),
          }))
        : undefined,
      error: new Error(`boom:${id}`),
    }
  })

const buildSource = (plan: Plan): SearchSourceContribution => ({
  id: plan.id,
  search: async () => {
    await tick(plan.ticks)
    if (!plan.ok) throw plan.error
    return plan.candidates!.map(c => ({block: c.block, score: c.score}))
  },
})

const makeRepo = (sources: readonly SearchSourceContribution[]): Repo => {
  const map = new Map(sources.map(s => [s.id, s]))
  return {
    facetRuntime: {
      read: () => map,
    },
  } as unknown as Repo
}

/** Independent re-expression of `freshestCandidatePayload`'s FIXED,
 *  order-independent rule (linkTargetAutocomplete.ts:328-365, issue
 *  #450): among candidates that carry a numeric `userUpdatedAt`, the one
 *  with the newest timestamp wins (ties broken by higher score); only
 *  when NONE of the group's candidates has a numeric timestamp does the
 *  highest-scored candidate win. Deliberately structured differently
 *  from production's left-to-right `reduce` — max-then-filter-then-find
 *  over the whole group at once — so this isn't just a renamed copy of
 *  the same expression, while still being a genuine total order (unlike
 *  the old pairwise fold this replaces, which wasn't — see the module
 *  docblock's "FUZZ-FOUND HISTORY"). A tie on BOTH timestamp and score
 *  between two distinct candidates is the only case where fold/group
 *  order can legitimately pick either one; `.find` here (like
 *  production's `reduce`) keeps the earliest such candidate in group
 *  order, matching production's stable tie-break. */
const pickFreshestPayload = (candidates: readonly Candidate[]): Candidate => {
  const timed = candidates.filter(c => typeof c.block.userUpdatedAt === 'number')
  const pool = timed.length > 0 ? timed : candidates
  const bestTime = timed.length > 0
    ? Math.max(...timed.map(c => c.block.userUpdatedAt as number))
    : undefined
  const finalists = bestTime === undefined ? pool : pool.filter(c => c.block.userUpdatedAt === bestTime)
  const bestScore = Math.max(...finalists.map(c => c.score))
  return finalists.find(c => c.score === bestScore)!
}

/** Folds one duplicate-id group into its surviving `{block, score}`:
 *  payload from `pickFreshestPayload` (order-independent, whole group at
 *  once), score as the max across every candidate in the group — both
 *  computed from the group as a whole, not a running accumulator, so
 *  this can't reintroduce the order-dependence `pickFreshestPayload`
 *  fixes. */
const foldGroup = (candidates: readonly Candidate[]): Candidate => ({
  block: pickFreshestPayload(candidates).block,
  score: Math.max(...candidates.map(c => c.score)),
})

type ModelResult =
  | {mode: 'ok'; blocks: BlockData[]}
  | {mode: 'error'; error: Error}

/** Reference model: group-then-fold over a `Map<blockId, Candidate[]>`
 *  built from every SUCCEEDING plan's candidates in registration order,
 *  rather than production's single flat `Map` mutated in one pass over
 *  the un-grouped, flattened candidate list. */
const referenceMergeAndRank = (plans: readonly Plan[], limit: number): ModelResult => {
  if (limit <= 0) return {mode: 'ok', blocks: []}
  const succeeded = plans.filter(p => p.ok)
  if (succeeded.length === 0) return {mode: 'error', error: plans[0]!.error}

  const groups = new Map<string, Candidate[]>()
  for (const plan of succeeded) {
    for (const candidate of plan.candidates!) {
      const bucket = groups.get(candidate.block.id) ?? []
      bucket.push(candidate)
      groups.set(candidate.block.id, bucket)
    }
  }

  const merged = [...groups.values()].map(group => foldGroup(group))
  merged.sort((x, y) => y.score - x.score)
  return {mode: 'ok', blocks: merged.slice(0, limit).map(m => m.block)}
}

describe('searchBlocksAcrossSources — model differential over generated async searchSourcesFacet fixtures', () => {
  // The suite deliberately makes sources throw; silence the production
  // `console.error(...)` log for those (see linkTargetAutocomplete.ts:418)
  // so the fuzz run's output isn't dominated by expected noise.
  beforeAll(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterAll(() => {
    vi.restoreAllMocks()
  })

  it('merges/dedupes/ranks candidates from N always-succeeding async sources exactly like an independent reference model — exact ids/order/payload, no dup ids', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(sourceSpecArb(true), {minLength: 1, maxLength: 4}),
        fc.integer({min: 1, max: 8}),
        async (specs, limit) => {
          const plans = specsToPlans(specs)
          const repo = makeRepo(plans.map(buildSource))

          const result = await searchBlocksAcrossSources(repo, {workspaceId: WS, query: 'q', limit})
          const model = referenceMergeAndRank(plans, limit)

          expect(model.mode).toBe('ok')
          if (model.mode !== 'ok') return
          expect(result, JSON.stringify({specs, limit})).toEqual(model.blocks)
          const ids = result.map(b => b.id)
          expect(new Set(ids).size).toBe(ids.length)
        },
      ),
      fuzzParams(200),
    )
  }, fuzzTestTimeout())

  it('returns [] for limit<=0 without invoking any source', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(sourceSpecArb(true), {minLength: 1, maxLength: 4}),
        fc.integer({min: -5, max: 0}),
        async (specs, limit) => {
          const plans = specsToPlans(specs)
          let invoked = false
          const sources = plans.map((plan): SearchSourceContribution => ({
            id: plan.id,
            search: async () => {
              invoked = true
              return []
            },
          }))
          const repo = makeRepo(sources)

          const result = await searchBlocksAcrossSources(repo, {workspaceId: WS, query: 'q', limit})
          expect(result).toEqual([])
          expect(invoked).toBe(false)
        },
      ),
      fuzzParams(30),
    )
  }, fuzzTestTimeout())

  it('drops a mix of throwing sources and merges only the succeeding ones — no exception escapes while >=1 source succeeds', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(sourceSpecArb(false), {minLength: 1, maxLength: 4}).map(specs => {
          // Force at least one success — this property isolates partial
          // failure from the all-fail case (covered separately below).
          if (!specs.some(s => s.ok)) specs[0]!.ok = true
          return specs
        }),
        fc.integer({min: 1, max: 8}),
        async (specs, limit) => {
          const plans = specsToPlans(specs)
          const repo = makeRepo(plans.map(buildSource))

          const result = await searchBlocksAcrossSources(repo, {workspaceId: WS, query: 'q', limit})
          const model = referenceMergeAndRank(plans, limit)

          expect(model.mode).toBe('ok')
          if (model.mode !== 'ok') return
          expect(result, JSON.stringify({specs, limit})).toEqual(model.blocks)
        },
      ),
      fuzzParams(150),
    )
  }, fuzzTestTimeout())

  it('rethrows the FIRST contribution\'s error by registration order when every source fails, regardless of randomized settle order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({ticks: fc.integer({min: 0, max: 6})}),
          {minLength: 1, maxLength: 5},
        ),
        async (failSpecs) => {
          const plans = specsToPlans(failSpecs.map(({ticks}) => ({ticks, ok: false, candidates: []})))
          const repo = makeRepo(plans.map(buildSource))

          await expect(
            searchBlocksAcrossSources(repo, {workspaceId: WS, query: 'q', limit: 10}),
          ).rejects.toBe(plans[0]!.error)
        },
      ),
      fuzzParams(100),
    )
  }, fuzzTestTimeout())

  // ──── issue #450: duplicate-group payload selection must be order-independent ────

  /** One shared block id, one single-candidate source per tuple — so
   *  permuting the tuple array is a genuine permutation of
   *  registration-then-within-source fold order through the REAL merge
   *  point (`searchBlocksAcrossSources`), not just this suite's model. */
  const runDupGroup = async (
    order: readonly {score: number; userUpdatedAt: number | undefined}[],
  ): Promise<BlockData[]> => {
    const sources = order.map((t, i): SearchSourceContribution => ({
      id: `s${i}`,
      search: async () => [{
        score: t.score,
        block: makeBlockData('dup-block', t.userUpdatedAt, `${t.score}:${t.userUpdatedAt}`),
      }],
    }))
    return searchBlocksAcrossSources(makeRepo(sources), {workspaceId: WS, query: 'q', limit: 1})
  }

  it('the surviving payload for a duplicate-id group is invariant under permutation of source order', async () => {
    // `userUpdatedAt`/`score` pairs are constrained UNIQUE (as a whole
    // tuple) so the winner is never ambiguous: a (timestamp, score) tie
    // between two DISTINCT candidates is the only case where a
    // different-but-equally-ranked candidate could legitimately survive
    // under a different order, which isn't what this property targets —
    // the pinned canary below covers the actual fuzz-found defect.
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(
          fc.record({
            score: fc.integer({min: 0, max: 500}),
            userUpdatedAt: fc.option(fc.integer({min: 0, max: 1000}), {nil: undefined}),
          }),
          {minLength: 2, maxLength: 6, selector: (t) => JSON.stringify(t)},
        ).chain((tuples) => fc.tuple(
          fc.constant(tuples),
          fc.shuffledSubarray(tuples, {minLength: tuples.length, maxLength: tuples.length}),
        )),
        async ([tuples, shuffled]) => {
          const original = await runDupGroup(tuples)
          const permuted = await runDupGroup(shuffled)
          expect(permuted, JSON.stringify({tuples, shuffled})).toEqual(original)
        },
      ),
      fuzzParams(80),
    )
  }, fuzzTestTimeout())

  it('canary: newest-timestamp candidate survives a 3-way duplicate group in every fold order (issue #450)', async () => {
    // Pinned fuzz-found counterexample. A has an OLDER timestamp than B
    // but a HIGHER score; C has no timestamp at all. Hand-traced against
    // the pre-fix single-pass fold: order (C, B, A) first picks C over B
    // (C's score 3 beats B's score 0, and C has no timestamp to compare),
    // discarding B's timestamp from the running accumulator — the next
    // comparison (accumulator-so-far vs A) then falls back to score
    // (since the accumulator's payload, C, still has no timestamp) and
    // picks A, so the fold surfaces A(t=10) despite B(t=20) being the
    // true newest candidate in the group. (B, C, A) fails the same way.
    // Confirmed by temporarily reverting the `freshestCandidatePayload`
    // fix locally: this test failed on exactly those two orderings
    // before the fix, and passes on all six after it.
    const A = {score: 5, userUpdatedAt: 10}
    const B = {score: 0, userUpdatedAt: 20}
    const C = {score: 3, userUpdatedAt: undefined}
    const orders = [
      [A, B, C], [A, C, B], [B, A, C], [B, C, A], [C, A, B], [C, B, A],
    ]

    for (const order of orders) {
      const result = await runDupGroup(order)
      expect(result, JSON.stringify(order)).toHaveLength(1)
      // B is the true newest (t=20) regardless of fold order.
      expect(result[0].userUpdatedAt, JSON.stringify(order)).toBe(B.userUpdatedAt)
      expect(result[0].content, JSON.stringify(order)).toBe(`${B.score}:${B.userUpdatedAt}`)
    }
  })
})
