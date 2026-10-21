// @vitest-environment node
/**
 * Fuzz suite for `searchBlocksAcrossSources` + `freshestCandidatePayload`
 * (`../linkTargetAutocomplete.ts:382-476`, `freshestCandidatePayload` at
 * :328-380) — the `searchSourcesFacet` merge point behind quick-find /
 * wikilink autocomplete, block-ref insertion completion, and the agent
 * `search` command. See `src/test/fuzz.ts` for the smoke/deep tier
 * mechanics and `docs/fuzzing.md` for suite conventions. Complements the
 * example-based coverage in `linkTargetAutocomplete.test.ts`'s
 * "searchBlocksAcrossSources (searchSourcesFacet merge point)" describe
 * block.
 *
 * ──── Algorithm under test (linkTargetAutocomplete.ts:420-476) ────
 *
 * `limit <= 0` short-circuits to `[]` (:424) WITHOUT invoking any source.
 * Otherwise every contributed source's `search` runs concurrently
 * (`Promise.all`, :432-442); a throw is caught, logged, and contributes
 * NOTHING (an empty list) — UNLESS every source throws, in which case the
 * FIRST one by registration order (not settle/catch order — `failures`
 * is sorted by `index` before rethrow, :448-451) is rethrown. Surviving
 * candidates are flattened and grouped by block id in
 * registration-then-within-source order (:453-465); each group's
 * surviving `score` is the MAX across every duplicate in the group, and
 * its surviving `block` payload is picked by `freshestCandidatePayload`
 * evaluated over the WHOLE group at once, per the contract documented on
 * `SearchSourceContribution` (`src/data/facets.ts`, the source of truth
 * this suite models against): candidates carrying a FINITE
 * `userUpdatedAt` outrank every candidate that does not, and among them
 * the newest wins (ties broken by higher score); only when NO candidate
 * in the group carries one does highest score decide. The result is
 * sorted by score descending and sliced to `limit`.
 *
 * The merge point once folded each group PAIRWISE, which is
 * non-associative here — the fold's accumulator carries the running max
 * score, so a comparison could pair one candidate's timestamp with a
 * different, already-eliminated candidate's score. That made payload
 * selection depend on source registration order (issue #450; the final
 * score was always the true max, only the payload pick broke). This suite
 * pins the whole-group rule two ways: permutation-invariance over
 * generated groups, and the deterministic canaries below.
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
 * list), with each group's winner computed via an explicit
 * every()-then-filter()-then-max() shape (rather than production's
 * left-to-right `reduce`) — an independent implementation to
 * differential-test against, not a copy of the code under test.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import type { BlockData } from '@/data/api'
import type { Repo } from '@/data/repo'
import { searchSourcesFacet, type SearchSourceContribution } from '@/data/facets.js'
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
 *  `undefined` and non-finite numbers (via the `as number` cast) to
 *  exercise `freshestCandidatePayload`'s `Number.isFinite` gate — the
 *  typed row shape can't express these, but the gate exists for a reason
 *  (a stale/legacy index copy), so the oracle has to cover it. See
 *  `timestampArb`. */
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

/** Timestamps a stale/legacy index copy can actually carry. The `number |
 *  undefined` type is the HAPPY path only — the values below it are the
 *  reason this generator exists.
 *
 *  `NaN` and `±Infinity` are `typeof 'number'`, so an implementation
 *  gating on typeof admits them: `NaN` then loses every comparison
 *  (`NaN !== NaN`), which makes the group's winner depend on where the
 *  fold started — order-dependence, the exact defect #450 is about — and
 *  `Infinity` wins unconditionally. An earlier revision of this generator
 *  emitted only integers and `undefined`, so it could not reach either;
 *  the NaN branch was found by reading the code, not by running it —
 *  which is what a domain this narrow costs you. */
const timestampArb: fc.Arbitrary<number | undefined> = fc.oneof(
  {arbitrary: fc.integer({min: 0, max: 1000}), weight: 8},
  {arbitrary: fc.constant(undefined), weight: 3},
  {arbitrary: fc.constantFrom(NaN, Infinity, -Infinity), weight: 2},
)

const candidateSpecArb: fc.Arbitrary<CandidateSpec> = fc.record({
  blockId: fc.constantFrom(...BLOCK_IDS),
  score: fc.integer({min: 0, max: 500}),
  userUpdatedAt: timestampArb,
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

/** Answers per FACET, not one map for everything: the merge point also reads
 *  `searchSourceHealthFacet`, and a stub that returned the sources for that
 *  too would hand back `SearchSourceContribution`s as reporters and call their
 *  nonexistent `report`. The merge point isolates reporter throws, so every
 *  case would quietly run the broken-reporter path instead of the one under
 *  test — invisible, since this suite mocks `console.error`. */
const makeRepo = (sources: readonly SearchSourceContribution[]): Repo => {
  const map = new Map(sources.map(s => [s.id, s]))
  return {
    facetRuntime: {
      read: (facet: {id: string}) => (facet.id === searchSourcesFacet.id ? map : new Map()),
    },
  } as unknown as Repo
}

/** Independent re-expression of `freshestCandidatePayload`'s rule
 *  (issue #450) — which itself implements the contract on
 *  `SearchSourceContribution` (`src/data/facets.ts`): candidates carrying
 *  a finite `userUpdatedAt` outrank every candidate that does not; among
 *  them newest wins, ties broken by higher score; only when NO candidate
 *  in the group carries one does highest score decide. A timestamp-less
 *  candidate removes itself from payload contention rather than handing
 *  the whole group's decision to score — it is off-contract
 *  (`BlockData.userUpdatedAt` is required), so it must not be able to
 *  surface another source's stale copy over live data.
 *  Deliberately structured differently from production's left-to-right
 *  `reduce` — an explicit every()-then-filter()-then-max() shape — so
 *  this isn't just a renamed copy of the same expression, while still
 *  being a genuine total order (unlike the old pairwise fold this
 *  replaces, which wasn't — see the module docblock's "FUZZ-FOUND
 *  HISTORY"). A tie on the deciding criterion (both timestamp AND score,
 *  in the all-timed case; score alone, in the any-missing case) between
 *  two distinct candidates is the only case where fold/group order can
 *  legitimately pick either one; `.find` here (like production's
 *  `reduce`) keeps the earliest such candidate in group order, matching
 *  production's stable tie-break. */
const pickFreshestPayload = (candidates: readonly Candidate[]): Candidate => {
  // Model "has a usable timestamp" by NORMALIZING first — a non-finite
  // stamp becomes `undefined` here, so everything downstream reasons about
  // one absent-ness. Production instead keeps the raw value and gates on
  // `Number.isFinite`; same domain, different expression, which is the
  // point of a differential oracle. (`NaN`/`±Infinity` count as missing:
  // `NaN` makes the winner depend on fold position — the very defect #450
  // is about — and `Infinity` wins unconditionally on a corrupt row.)
  const stampOf = (c: Candidate): number | undefined => {
    const raw = c.block.userUpdatedAt as number | undefined
    if (typeof raw !== 'number') return undefined
    return raw - raw === 0 ? raw : undefined
  }
  const timed = candidates.filter(c => stampOf(c) !== undefined)
  if (timed.length === 0) {
    const bestScore = Math.max(...candidates.map(c => c.score))
    return candidates.find(c => c.score === bestScore)!
  }
  const bestTime = Math.max(...timed.map(c => stampOf(c)!))
  const finalists = timed.filter(c => stampOf(c) === bestTime)
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
  // `console.error(...)` log for those (see linkTargetAutocomplete.ts:437)
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
    // `score` values are constrained UNIQUE across the group, which rules
    // out every tie the rule can produce and so leaves the winner uniquely
    // determined — the precondition for asking whether fold order changes
    // it. Both regimes tie-break on score last (timestamped candidates:
    // newest, then score; an all-untimed group: score alone), so globally
    // unique scores make both unambiguous. A weaker "unique (score,
    // timestamp) tuple" constraint would NOT be enough: an all-untimed
    // group decides on score alone, where two candidates differing only in
    // timestamp are a genuine order-dependent tie. The pinned canaries
    // below cover the actual fuzz-found defect with fixed values.
    const uniqueScoreGroupArb = fc.uniqueArray(
      fc.integer({min: 0, max: 500}),
      {minLength: 2, maxLength: 6},
    ).chain((scores) => fc.tuple(
      ...scores.map(() => fc.option(fc.integer({min: 0, max: 1000}), {nil: undefined})),
    ).map((timestamps) => scores.map((score, i) => ({score, userUpdatedAt: timestamps[i]}))))

    await fc.assert(
      fc.asyncProperty(
        uniqueScoreGroupArb.chain((tuples) => fc.tuple(
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

  it('canary: an off-contract candidate cannot decide a 3-way duplicate group, in any fold order (issue #450)', async () => {
    // The fuzz-found counterexample. A and B both carry timestamps; C
    // carries none, which makes it off-contract (`BlockData.userUpdatedAt`
    // is required). B is the freshest well-formed candidate, so B's copy
    // of the block is what the user must see — in all six orders, and
    // whatever C's score is.
    //
    // Verified to FAIL against the original pre-#450 pairwise running
    // fold (spliced back in locally): on order (B,C,A) it answered A,
    // where the rule requires B. So this pins the order-dependence
    // itself, not merely the rule.
    const A = {score: 5, userUpdatedAt: 10}
    const B = {score: 0, userUpdatedAt: 20}
    const C = {score: 3, userUpdatedAt: undefined}
    const orders = [
      [A, B, C], [A, C, B], [B, A, C], [B, C, A], [C, A, B], [C, B, A],
    ]

    for (const order of orders) {
      const result = await runDupGroup(order)
      expect(result, JSON.stringify(order)).toHaveLength(1)
      expect(result[0].userUpdatedAt, JSON.stringify(order)).toBe(B.userUpdatedAt)
      expect(result[0].content, JSON.stringify(order)).toBe(`${B.score}:${B.userUpdatedAt}`)
    }
  })

  it('canary: a high score cannot buy an off-contract candidate the payload (facets.ts contract)', async () => {
    // The minimal shape of the decision this rule turns on, and the one
    // the contract was flipped over twice: X is well-formed but scores 1;
    // Y has no timestamp and scores 50. Y's score still sets the merged
    // rank (asserted below) — but X's copy is what gets displayed, since
    // Y's is a snapshot of unknown age from a source that broke the
    // contract.
    //
    // This pins the rule, not a regression: a 2-element pairwise fold is
    // order-independent absent an exact tie, so it never exhibited #450.
    // It DOES fail against the previous rule (whole-group score fallback),
    // which answered Y.
    const X = {score: 1, userUpdatedAt: 20}
    const Y = {score: 50, userUpdatedAt: undefined}

    for (const order of [[X, Y], [Y, X]]) {
      const result = await runDupGroup(order)
      expect(result, JSON.stringify(order)).toHaveLength(1)
      expect(result[0].content, JSON.stringify(order)).toBe(`${X.score}:${X.userUpdatedAt}`)
    }
  })

  it('an off-contract candidate still contributes its score to the merged rank', async () => {
    // Losing the payload must not also lose the ranking signal: the
    // block should still sort at score 50, not 1. Pinned through the real
    // merge point by giving a second block a score between the two — if
    // the off-contract candidate's score were dropped, `dup-block` would
    // sort below it.
    const sources: SearchSourceContribution[] = [
      {
        id: 'well-formed',
        search: async () => [{score: 1, block: makeBlockData('dup-block', 20, 'live')}],
      },
      {
        id: 'off-contract',
        search: async () => [{score: 50, block: makeBlockData('dup-block', undefined, 'stale')}],
      },
      {
        id: 'other',
        search: async () => [{score: 25, block: makeBlockData('other-block', 5, 'other')}],
      },
    ]
    const result = await searchBlocksAcrossSources(makeRepo(sources), {
      workspaceId: WS,
      query: 'q',
      limit: 10,
    })
    expect(result.map(b => b.id)).toEqual(['dup-block', 'other-block'])
    expect(result[0].content).toBe('live')
  })

  it('canary: a NaN timestamp is MISSING, not newest — it must not reintroduce order-dependence (Codex, PR #449)', async () => {
    // The fix for #450 gated on `typeof === 'number'`, which NaN passes.
    // Every subsequent comparison against it is then false — including
    // `NaN !== NaN` — so `reduce` keeps whatever it was already holding:
    // the winner became a function of fold position again, which is the
    // one property this function exists to provide. Traced on the
    // pre-fix expression: [N, M] → N (score 0 beats score 9), [M, N] → M.
    //
    // Treating non-finite as missing sends the group to score, so M
    // (score 9) wins in both orders. `Infinity` is checked alongside:
    // it is order-INdependent but wins unconditionally, which is not a
    // claim a corrupt row should get to make either.
    const M = {score: 9, userUpdatedAt: 20}
    for (const bad of [NaN, Infinity, -Infinity]) {
      const N = {score: 0, userUpdatedAt: bad}
      for (const order of [[N, M], [M, N]]) {
        const label = `${String(bad)} ${JSON.stringify(order.map(c => c.score))}`
        const result = await runDupGroup(order)
        expect(result, label).toHaveLength(1)
        expect(result[0].content, label).toBe(`${M.score}:${M.userUpdatedAt}`)
      }
    }
  })
})
