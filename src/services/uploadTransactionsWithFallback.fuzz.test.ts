// @vitest-environment node
/**
 * Model-based fuzz suite for the upload-retry/classification state machine in
 * `uploadTransactionsWithFallback` (powersync.ts:626-705, exported as
 * `__uploadTransactionsWithFallbackForTest`). See `src/test/fuzz.ts` for the
 * smoke/deep tier mechanics and `docs/fuzzing.md` for conventions. Sits
 * alongside `powersync.fuzz.test.ts` (which covers the pure transforms
 * `compactBlockCrudEntries`/`orderedBlockUpserts`) — this suite is the
 * orchestrator itself, a large enough concern to warrant its own file.
 *
 * ## Why (issue #434)
 *
 * This state machine has been broken and re-fixed at least six times:
 * 2b18b676c (missing-row RPC rollback → P0002 permanent), 58140b90d
 * (per-tx rejection tolerance — the original batch/per-tx split), 71bd72efe
 * (HTTP-status threading so a codeless permanent 4xx doesn't jam the queue),
 * 267558e29 (atomic + idempotent rejection recording), 9fc1b8729 (oversized
 * apply_block_patches RPC cap — a sink-chunking concern, not this
 * orchestrator's retry logic), 05fe86074 (drain the succeeded prefix on
 * ANY batch error, not just transient, to bound insert-or-TOUCH re-touch
 * amplification). Re-verified against current master (~108 commits after
 * the issue was filed): all six fixes' intended semantics are still exactly
 * what's in the code below — the only changes to powersync.ts since are an
 * eslint-disable comment (d208f5027) and a docblock correction
 * (3625dc3f7), neither touching retry/classification behavior. No drift.
 *
 * ## Harness shape
 *
 * A **scenario** is N synthetic transactions (`blk-0..blk-N-1`, unique
 * block ids so `compactBlockCrudEntries` never fuses across them), each
 * carrying a `Script`: a short prefix of `Step`s (`success` or a REAL
 * error object drawn from the classifier's own buckets — see below) plus a
 * repeating `tail` Step for whatever happens once the prefix is exhausted.
 * A transaction optionally has no `transactionId` (mirrors "recorded
 * without an explicit transaction", CrudTransaction.transactionId?), and
 * optionally has its first `recordRejection` attempt fail once (models the
 * historical bug 267558e29 fixed: a rejection-write failure must not
 * falsely drain the tx), and optionally has its `complete()` call fail once
 * right after its FIRST successful `recordRejection` (the exact window
 * powersync.ts:485-490 documents: the write succeeds, then the separate
 * `complete()` step fails, so the tx stays pending and legitimately
 * re-quarantines — calling the idempotent writer again — on the next pass;
 * PR #448 review comment 3676858232).
 *
 * `runSimulation` drives the REAL `uploadTransactionsWithFallback` across
 * up to `AMBIGUOUS_RETRY_BUDGET + 4` **passes** (mirroring how
 * `runUploadLoop`/PowerSync repeatedly re-invokes it on a throw, feeding
 * back only the still-pending transactions — draining is real
 * `CrudTransaction.complete()` semantics: completing the tail of a
 * successful batch drains every transaction ahead of it too, powersync.ts
 * doc at :622-623). Running out of passes with a tx still undrained is not
 * a failure — "still pending" is a valid terminal fate per property (a).
 *
 * Each pass, an INDEPENDENT reference model (`predictPass`) re-derives —
 * from its own snapshot of the shared `attemptIndex`/`ambiguousAttempts`/
 * `rejectionFailRemaining` state, without touching the real state — exactly
 * what the orchestrator should do this pass: whether the batch call
 * succeeds; if not, the per-tx trace up to whichever tx stops the loop
 * (transient / ambiguous-still-in-budget / a simulated `recordRejection`
 * write failure — permanent and budget-exhausted-ambiguous do NOT stop it,
 * per the code's own `for` loop only breaking via a re-thrown error); which
 * txs get completed/rejected; and whether the pass resolves or throws. The
 * two injected seams (`deps.applyOperations`, `deps.recordRejection`) are
 * deliberately DUMB — they only translate "current script step" into a
 * return/throw, never decide retry/quarantine — so the REAL orchestrator's
 * classification (via the REAL `classifyUploadError`) and retry/budget
 * logic is exercised, not re-implemented by the mock. Errors are drawn from
 * the exact code/status pools `uploadErrorClassifier.ts` and its own test
 * file document, and each pool assigns its own error a `bucket` — the
 * GENERATED ground truth for what that error should classify as.
 * `predictPass` branches on that `bucket` (`expectedClassOf`), never on a
 * call to `classifyUploadError` — so a classification regression can't be
 * silently adopted by the model as the "expected" answer. What actually
 * happened when the REAL classifier saw the same error is recorded
 * separately (`classificationOf`, used only in `runSimulation`'s mock) and
 * diffed against the model's prediction below; the pools themselves are
 * pinned against the real classifier directly by the "generator ground
 * truth" tests earlier in this file.
 *
 * Every pass, `runSimulation` asserts predicted === observed (per-tx trace,
 * completed/rejected sets, throw-vs-resolve, and the real post-call
 * `ambiguousAttempts` map) — this differential check is the load-bearing
 * oracle, and (since predicted is bucket-derived while observed is
 * classifier-derived) it doubles as a classification-regression detector for
 * every error a scenario actually exercises; the five `it`s below each pull
 * a named, issue-aligned slice out of the same verified trace for clear
 * failure diagnostics.
 *
 * ## Contract delta: property (e)
 *
 * The issue frames (e) as "rejection recording idempotent". The DB-level
 * idempotency (DELETE-by-tx_id then INSERT — 267558e29's actual fix) lives
 * entirely inside `recordRejectionToTable`, which this suite mocks away
 * (it's an injected seam, `UploadDeps.recordRejection`) — that write
 * pattern has no unit coverage of its own found in this repo as of this
 * writing and would need a DB-backed test, out of scope for a seam-level
 * orchestrator fuzz. What IS this orchestrator's own responsibility, and
 * what this suite actually pins, is the CALL-ORDER CONTRACT that makes that
 * DB idempotency sufficient: `recordRejection` always precedes `complete()`
 * (powersync.ts:700-702), and if it throws, `complete()` never runs for
 * that attempt — so a tx is never falsely marked drained without a durable
 * rejection record, and a retry (next pass) re-attempts cleanly rather than
 * compounding. That's the property tested below, not literal duplicate-row
 * avoidance.
 *
 * `complete()` itself can ALSO fail, right after a successful
 * `recordRejection` (powersync.ts:485-490's own documented rationale for
 * making the write idempotent in the first place) — a tx's
 * `completionFailsOnceAfterRejection` flag models exactly that. The
 * contract this exercises is the inverse of the write-failure one: repeated
 * `recordRejection` SUCCESSES are legitimate (bounded by `1 +
 * completionFailures`, PR #448 review comment 3676858232), while the tx
 * still only ever drains in exactly one pass.
 *
 * ## Explicit scope exclusion
 *
 * `deps.encryptOps` is never supplied (defaults to identity — powersync.ts
 * :632), so the e2ee preflight-failure branch (:634-642, "batch encryption
 * failed — isolating per tx") is never exercised here. That seam is
 * `encryptUploadOps`, already covered by `__encryptUploadOpsForTest`
 * elsewhere; it's orthogonal to the retry/classification state machine
 * this issue asks for.
 */
import {
  AbstractPowerSyncDatabase,
  CrudEntry,
  CrudTransaction,
  UpdateType,
} from '@powersync/common'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout, statefulFuzzGuard } from '@/test/fuzz'
import { classifyUploadError, type UploadErrorClass } from '@/services/uploadErrorClassifier'

const supabaseRef = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
}))

vi.mock('@/services/supabase.js', () => ({
  supabase: supabaseRef,
  hasSupabaseAuthConfig: true,
}))

import {
  AMBIGUOUS_RETRY_BUDGET,
  __uploadTransactionsWithFallbackForTest as uploadTransactionsWithFallback,
  type UploadDeps,
  type CompactedBlockOperation,
} from './powersync'

const fakeDatabase = {} as unknown as AbstractPowerSyncDatabase

// ──────────────────────────────────────────────────────────────────────
// Real error shapes — mirrors uploadErrorClassifier.ts's own buckets and
// uploadErrorClassifier.test.ts's helpers. Each pool's own membership IS
// the ground truth for what that error should classify as — the model
// below (`predictPass`) branches on that generated bucket, never on a call
// to `classifyUploadError`, so a regression in the classifier can't be
// silently adopted by the oracle as the "expected" answer. The pools are
// pinned against the real classifier directly by the dedicated
// "generator ground truth" tests further down — a mismatch there is a
// FINDING (a mislabeled pool), not a model bug.
// ──────────────────────────────────────────────────────────────────────

const postgrestError = (code: string, message = 'test'): Error => {
  const err = new Error(message)
  ;(err as Error & {code: string}).code = code
  return err
}
const httpError = (status: number, message = 'test'): Error => {
  const err = new Error(message)
  ;(err as Error & {status: number}).status = status
  return err
}

const TRANSIENT_POSTGREST_CODES = ['PGRST301', 'PGRST302', 'PGRST202'] as const
const TRANSIENT_HTTP_STATUSES = [401, 403, 408, 429, 500, 502, 503, 520] as const
const PERMANENT_CODES = [
  '22P02', '22003', '23503', '23505', '23514', '42501', '42703', 'P0002',
  'PGRST100', 'PGRST101', 'PGRST102', 'PGRST103', 'PGRST204', 'PGRST116',
] as const
const AMBIGUOUS_HTTP_STATUSES = [400, 404, 409, 413, 422] as const

// ──────────────────────────────────────────────────────────────────────
// Range contracts (PR #448 review comment 3676858229): the named pools
// above are hand-picked EXAMPLES, but two of the classifier's rules are
// genuine RANGES, not enumerations — `isClientErrorStatus` (400 <= status <
// 500) and `isPermanentSqlState`'s string-prefix match on the 22xxx/23xxx/
// 42xxx SQLSTATE classes (any subclass suffix). A regression narrowing
// either range (e.g. `isClientErrorStatus` stopping at 422) would silently
// misclassify a status/code neither the named pools nor
// uploadErrorClassifier.test.ts ever generates — 423 or 451 would turn
// transient and could jam the queue indefinitely. These arbitraries probe
// the ACTUAL boundaries, biased in explicitly (a uniform range arbitrary
// hits an edge only rarely), and are mixed into the three bucket
// arbitraries below so scenario generation sees this diversity too, not
// just the named handful. Pinned directly by the range-contract property in
// the "generator pools" describe block further down.
// ──────────────────────────────────────────────────────────────────────

const RETRYABLE_HTTP_STATUSES = [401, 403, 408, 429] as const
const isRetryableStatus = (status: number): boolean => (RETRYABLE_HTTP_STATUSES as readonly number[]).includes(status)

/** Every status the classifier treats as a suspected-permanent client error:
 *  [400, 499] minus the four retryable carve-outs. Biased toward the
 *  range's own edges (400, 499) and the immediate neighbours of each
 *  carve-out (e.g. 400/402 flank the 401 carve-out). */
const ambiguousRangeStatusArb: fc.Arbitrary<number> = fc.oneof(
  {arbitrary: fc.integer({min: 400, max: 499}).filter(s => !isRetryableStatus(s)), weight: 4},
  {arbitrary: fc.constantFrom(400, 499), weight: 2},
  {
    arbitrary: fc.constantFrom(
      ...RETRYABLE_HTTP_STATUSES.flatMap(s => [s - 1, s + 1]).filter(s => !isRetryableStatus(s)),
    ),
    weight: 2,
  },
)

/** Every status the classifier treats as transient by being OUTSIDE the
 *  client-error range, or landing exactly on a retryable carve-out. Biased
 *  toward the range's own edges (399, 500) just outside [400, 499]. */
const transientRangeStatusArb: fc.Arbitrary<number> = fc.oneof(
  {arbitrary: fc.integer({min: 100, max: 399}), weight: 2},
  {arbitrary: fc.integer({min: 500, max: 599}), weight: 2},
  {arbitrary: fc.constantFrom(399, 500), weight: 2},
  {arbitrary: fc.constantFrom(...RETRYABLE_HTTP_STATUSES), weight: 2},
)

const SQLSTATE_SUFFIX_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
/** A realistic 3-char SQLSTATE subclass suffix (matches real codes like
 *  22P02's `P02`), biased toward the all-digit/all-letter edges of that
 *  alphabet. */
const sqlstateSuffixArb: fc.Arbitrary<string> = fc.oneof(
  {arbitrary: fc.array(fc.constantFrom(...SQLSTATE_SUFFIX_CHARS), {minLength: 3, maxLength: 3}).map(a => a.join('')), weight: 3},
  {arbitrary: fc.constantFrom('000', '999', 'ZZZ', 'P02'), weight: 2},
)

/** Every SQLSTATE under the classifier's three permanent prefix CLASSES —
 *  `isPermanentSqlState` matches on `code.startsWith('22'|'23'|'42')`, so
 *  ANY subclass suffix under any of the three is permanent regardless of
 *  content. */
const permanentRangeCodeArb: fc.Arbitrary<string> =
  fc.tuple(fc.constantFrom('22', '23', '42'), sqlstateSuffixArb).map(([cls, suffix]) => `${cls}${suffix}`)

/** The classes immediately adjacent to each permanent class (21/24 flank
 *  22/23; 41/43 flank 42) — proves the prefix match doesn't leak past its
 *  own edges. None collide with the small named PGRST/P0002 sets, and a
 *  plain code (no `.status`) that matches nothing falls to the classifier's
 *  own codeless default, transient. */
const nonPermanentRangeCodeArb: fc.Arbitrary<string> =
  fc.tuple(fc.constantFrom('21', '24', '41', '43'), sqlstateSuffixArb).map(([cls, suffix]) => `${cls}${suffix}`)

const transientErrorArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constantFrom(...TRANSIENT_POSTGREST_CODES).map(code => postgrestError(code)),
  fc.constantFrom(...TRANSIENT_HTTP_STATUSES).map(status => httpError(status)),
  fc.constant(new Error('simulated network failure')),
  transientRangeStatusArb.map(status => httpError(status)),
  nonPermanentRangeCodeArb.map(code => postgrestError(code)),
)
const permanentErrorArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constantFrom(...PERMANENT_CODES).map(code => postgrestError(code)),
  permanentRangeCodeArb.map(code => postgrestError(code)),
)
const ambiguousErrorArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constantFrom(...AMBIGUOUS_HTTP_STATUSES).map(status => httpError(status)),
  fc.tuple(fc.constantFrom(...AMBIGUOUS_HTTP_STATUSES), fc.string({minLength: 3, maxLength: 8})).map(
    ([status, suffix]) => Object.assign(new Error('weird'), {code: `ZZUNKNOWN_${suffix}`, status}),
  ),
  ambiguousRangeStatusArb.map(status => httpError(status)),
)

// ──────────────────────────────────────────────────────────────────────
// Generator ground truth: pins each pool against the REAL classifyUploadError
// directly, independent of the scenario model below. `predictPass` trusts a
// generated error's `bucket` without asking the classifier — these tests are
// what makes that trust sound. A failure here means a POOL is mislabeled
// (a finding to report), not that the state-machine model is wrong.
//
// DETERMINISTIC, not fuzzed: every pool here is a small finite constant set
// (`as const` arrays above), so `it.each` over every member is a strictly
// STRONGER pin than sampling it through `fc.assert` (exhaustive vs. sampled)
// and costs ~0ms instead of a full fuzz budget per property in deep/nightly
// runs. `uploadErrorClassifier.test.ts` covers most of these codes already,
// but not all — e.g. PGRST101/PGRST103 (in `PERMANENT_CODES` below) have no
// direct assertion there, only shared `Set` membership with PGRST100/102 that
// happen to be tested — so this stays as the one place that pins every code
// this suite's OWN pools actually draw from.
// ──────────────────────────────────────────────────────────────────────

describe('generator pools — ground truth against the real classifier', () => {
  it.each(TRANSIENT_POSTGREST_CODES)('transient postgrest code %s classifies as transient', code => {
    expect(classifyUploadError(postgrestError(code))).toBe('transient')
  })
  it.each(TRANSIENT_HTTP_STATUSES)('transient HTTP status %d classifies as transient', status => {
    expect(classifyUploadError(httpError(status))).toBe('transient')
  })
  it('a plain network-failure Error classifies as transient', () => {
    expect(classifyUploadError(new Error('simulated network failure'))).toBe('transient')
  })

  it.each(PERMANENT_CODES)('permanent code %s classifies as permanent', code => {
    expect(classifyUploadError(postgrestError(code))).toBe('permanent')
  })

  it.each(AMBIGUOUS_HTTP_STATUSES)('ambiguous HTTP status %d (no code) classifies as ambiguous', status => {
    expect(classifyUploadError(httpError(status))).toBe('ambiguous')
  })
  it.each(AMBIGUOUS_HTTP_STATUSES)('ambiguous HTTP status %d with an unrecognised code still classifies as ambiguous', status => {
    const err = Object.assign(new Error('weird'), {code: 'ZZUNKNOWN_TEST', status})
    expect(classifyUploadError(err)).toBe('ambiguous')
  })

  // FUZZED (not it.each): the two rules below are genuine RANGES — a finite
  // enumeration can't probe them. One property covers both range contracts;
  // deliberately not three separate full-budget properties (see the
  // "Range contracts" comment above `transientErrorArb` for why each
  // arbitrary is shaped the way it is).
  it('range contract: every non-retryable 400-499 status is ambiguous, everything outside is transient, and the 22xxx/23xxx/42xxx SQLSTATE classes are permanent at their own edges', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          ambiguousRangeStatusArb.map(status => ({err: httpError(status), expected: 'ambiguous' as const})),
          transientRangeStatusArb.map(status => ({err: httpError(status), expected: 'transient' as const})),
          permanentRangeCodeArb.map(code => ({err: postgrestError(code), expected: 'permanent' as const})),
          nonPermanentRangeCodeArb.map(code => ({err: postgrestError(code), expected: 'transient' as const})),
        ),
        ({err, expected}) => {
          expect(classifyUploadError(err)).toBe(expected)
        },
      ),
      fuzzParams(200),
    )
  }, fuzzTestTimeout())
})

// ──────────────────────────────────────────────────────────────────────
// Scripts: a per-tx sequence of scripted attempt outcomes.
// ──────────────────────────────────────────────────────────────────────

type Step =
  | {readonly outcome: 'success'}
  | {readonly outcome: 'error'; readonly err: unknown; readonly bucket: UploadErrorClass}
type Script = {readonly steps: readonly Step[]; readonly tail: Step}

const successStep: Step = {outcome: 'success'}
/** `bucket` is the GENERATED ground truth — which pool `err` was drawn from
 *  — carried alongside the error rather than re-derived later. */
const errorStep = (err: unknown, bucket: UploadErrorClass): Step => ({outcome: 'error', err, bucket})

const stepAt = (script: Script, idx: number): Step => (idx < script.steps.length ? script.steps[idx] : script.tail)

/** The step's REAL (observed) classification — calls the actual
 *  `classifyUploadError`. Used only to record what actually happened during
 *  a run, for differencing against `expectedClassOf` below — never to
 *  derive the model's own expectation, which would let a classifier
 *  regression sneak past undetected (the model would adopt the same wrong
 *  answer the code under test produced). */
const classificationOf = (step: Step): 'success' | UploadErrorClass =>
  step.outcome === 'success' ? 'success' : classifyUploadError(step.err)

/** The step's EXPECTED classification, by construction — the generated
 *  `bucket`, never a call to `classifyUploadError`. This is what
 *  `predictPass` branches on, so the oracle's expectation is independent of
 *  the code under test. */
const expectedClassOf = (step: Step): 'success' | UploadErrorClass =>
  step.outcome === 'success' ? 'success' : step.bucket

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  {arbitrary: fc.constant(successStep), weight: 5},
  {arbitrary: transientErrorArb.map(err => errorStep(err, 'transient')), weight: 2},
  {arbitrary: permanentErrorArb.map(err => errorStep(err, 'permanent')), weight: 2},
  {arbitrary: ambiguousErrorArb.map(err => errorStep(err, 'ambiguous')), weight: 2},
)
// Tail is biased toward 'ambiguous' relative to the prefix so budget
// exhaustion (property d) shows up often without needing very long scripts.
const tailArb: fc.Arbitrary<Step> = fc.oneof(
  {arbitrary: fc.constant(successStep), weight: 6},
  {arbitrary: transientErrorArb.map(err => errorStep(err, 'transient')), weight: 2},
  {arbitrary: permanentErrorArb.map(err => errorStep(err, 'permanent')), weight: 1},
  {arbitrary: ambiguousErrorArb.map(err => errorStep(err, 'ambiguous')), weight: 3},
)
const scriptArb: fc.Arbitrary<Script> = fc.record({
  steps: fc.array(stepArb, {maxLength: 3}),
  tail: tailArb,
})

interface TxModel {
  readonly index: number
  readonly blockId: string
  readonly transactionId: number | undefined
  readonly script: Script
  readonly rejectionFailsOnce: boolean
  // Models the exact window powersync.ts:485-490 documents: recordRejection
  // succeeds (a durable, idempotent write), then `transaction.complete()` —
  // a SEPARATE step, not wrapped in its own try/catch (powersync.ts:
  // 700-702) — itself throws. The tx is never marked drained, stays
  // `pending`, and the next pass legitimately calls the idempotent
  // rejection writer again (PR #448 review comment 3676858232). Fires at
  // most once per tx, and only on the FIRST successful recordRejection
  // call for it.
  readonly completionFailsOnceAfterRejection: boolean
}
interface Scenario {
  readonly transactions: readonly TxModel[]
  // Whether pass N's batch `applyOperations` call is forced to fail EVEN
  // WHEN every pending tx's current step is 'success' — cycled by
  // `passIndex % length`, mirroring how `Script.tail` repeats. Models a
  // batch-level failure with a cause independent of any tx's own payload
  // (a network blip, a timeout under load): without this, batch failure and
  // per-tx failure are both derived from the SAME `Step`, so "batch fails,
  // then every isolated per-tx retry succeeds" (05fe86074's own motivating
  // case) could never be generated — see `predictPass` below.
  readonly batchExogenousFailures: readonly boolean[]
}

const txSpecArb = fc.record({
  hasTransactionId: fc.oneof({arbitrary: fc.constant(true), weight: 5}, {arbitrary: fc.constant(false), weight: 1}),
  script: scriptArb,
  rejectionFailsOnce: fc.oneof({arbitrary: fc.constant(false), weight: 4}, {arbitrary: fc.constant(true), weight: 1}),
  completionFailsOnceAfterRejection: fc.oneof({arbitrary: fc.constant(false), weight: 4}, {arbitrary: fc.constant(true), weight: 1}),
})

// Mostly false so the batch behaves as a plain function of the per-tx steps
// most of the time; occasionally true so the exogenous-failure path (see
// `Scenario.batchExogenousFailures` above) actually gets exercised.
const batchExogenousFailureArb = fc.oneof(
  {arbitrary: fc.constant(false), weight: 5},
  {arbitrary: fc.constant(true), weight: 1},
)

const scenarioArb: fc.Arbitrary<Scenario> = fc.integer({min: 1, max: 5}).chain(n =>
  fc.record({
    specs: fc.array(txSpecArb, {minLength: n, maxLength: n}),
    batchExogenousFailures: fc.array(batchExogenousFailureArb, {minLength: 1, maxLength: 3}),
  }).map(({specs, batchExogenousFailures}) => ({
    transactions: specs.map((spec, index): TxModel => ({
      index,
      blockId: `blk-${index}`,
      transactionId: spec.hasTransactionId ? index + 1 : undefined,
      script: spec.script,
      rejectionFailsOnce: spec.rejectionFailsOnce,
      completionFailsOnceAfterRejection: spec.completionFailsOnceAfterRejection,
    })),
    batchExogenousFailures,
  })),
)

// ──────────────────────────────────────────────────────────────────────
// Reference model: an independent re-derivation of one pass of
// uploadTransactionsWithFallback's control flow (powersync.ts:626-705),
// from snapshots only — never mutates the shared state the real call also
// drives, so it can be computed BEFORE that call runs.
// ──────────────────────────────────────────────────────────────────────

interface Prediction {
  readonly perTxTrace: ReadonlyArray<{blockId: string; classification: 'success' | UploadErrorClass}>
  readonly completedBlockIds: readonly string[]
  readonly rejectedBlockIds: readonly string[]
  readonly rejectionFailureBlockId: string | null
  // The tx whose `complete()` call failed AFTER its recordRejection
  // succeeded this pass (PR #448 review comment 3676858232) — a second,
  // independent way the pass can legitimately stop besides a write failure.
  readonly completionFailureBlockId: string | null
  readonly passThrows: boolean
  readonly stoppingBlockId: string | null
  readonly finalAmbiguousAttempts: ReadonlyMap<number, number>
}

const predictPass = (
  pending: readonly TxModel[],
  attemptIndex: ReadonlyMap<string, number>,
  ambiguousAttempts: ReadonlyMap<number, number>,
  rejectionFailRemaining: ReadonlyMap<string, number>,
  // This pass's batch call has its OWN scripted outcome, independent of the
  // per-tx steps below — see `Scenario.batchExogenousFailures`. Only takes
  // effect when every pending tx's current step is already 'success' (if
  // one isn't, the batch fails anyway — this flag can't make it succeed).
  forceExogenousBatchFailure: boolean,
  completionFailRemaining: ReadonlyMap<string, number>,
): Prediction => {
  const localAttempt = new Map(attemptIndex)
  const localAmbiguous = new Map(ambiguousAttempts)
  const localRejectFail = new Map(rejectionFailRemaining)
  const localCompletionFail = new Map(completionFailRemaining)
  const peek = (tx: TxModel) => stepAt(tx.script, localAttempt.get(tx.blockId) ?? 0)

  // Batch path (powersync.ts:637-666): one applyOperations call over every
  // pending tx's compacted ops. Any failure — including transient — drops
  // into the per-tx loop untouched (05fe86074); the mock never tells us
  // WHICH tx would have failed at this granularity, only whether they'd
  // all succeed. `forceExogenousBatchFailure` can additionally fail the
  // batch call even when every per-tx step below is 'success' — the batch
  // attempt is a real, separate call in the product code, so it can fail
  // for a reason that has nothing to do with any individual tx's payload
  // and then have every isolated per-tx retry succeed (the scenario
  // 05fe86074 exists to bound: drain the succeeded prefix on ANY batch
  // error, not just one caused by a specific tx).
  const allStepsSuccess = pending.every(tx => peek(tx).outcome === 'success')
  if (allStepsSuccess && !forceExogenousBatchFailure) {
    for (const tx of pending) {
      localAttempt.set(tx.blockId, (localAttempt.get(tx.blockId) ?? 0) + 1)
      if (tx.transactionId !== undefined) localAmbiguous.delete(tx.transactionId)
    }
    return {
      perTxTrace: [],
      completedBlockIds: pending.map(tx => tx.blockId),
      rejectedBlockIds: [],
      rejectionFailureBlockId: null,
      completionFailureBlockId: null,
      passThrows: false,
      stoppingBlockId: null,
      finalAmbiguousAttempts: localAmbiguous,
    }
  }

  // Per-tx fallback (powersync.ts:672-704): sequential, stops only on a
  // re-thrown error (transient, or ambiguous still inside its budget, a
  // simulated recordRejection write failure, or a simulated complete()
  // failure right after a successful rejection write). permanent and
  // budget-exhausted-ambiguous quarantine and CONTINUE (property c).
  const perTxTrace: Array<{blockId: string; classification: 'success' | UploadErrorClass}> = []
  const completedBlockIds: string[] = []
  const rejectedBlockIds: string[] = []
  let rejectionFailureBlockId: string | null = null
  let completionFailureBlockId: string | null = null
  let stoppingBlockId: string | null = null

  for (const tx of pending) {
    const step = peek(tx)
    localAttempt.set(tx.blockId, (localAttempt.get(tx.blockId) ?? 0) + 1)
    const cls = expectedClassOf(step)
    perTxTrace.push({blockId: tx.blockId, classification: cls})

    if (cls === 'success') {
      completedBlockIds.push(tx.blockId)
      if (tx.transactionId !== undefined) localAmbiguous.delete(tx.transactionId)
      continue
    }

    if (cls === 'transient') {
      stoppingBlockId = tx.blockId
      break
    }

    let quarantine = cls === 'permanent'
    if (cls === 'ambiguous') {
      // ambiguousBudgetExhausted (powersync.ts:569-578): undefined
      // transactionId is treated as already-exhausted; otherwise
      // increment-then-compare against AMBIGUOUS_RETRY_BUDGET.
      if (tx.transactionId === undefined) {
        quarantine = true
      } else {
        const next = (localAmbiguous.get(tx.transactionId) ?? 0) + 1
        localAmbiguous.set(tx.transactionId, next)
        quarantine = next >= AMBIGUOUS_RETRY_BUDGET
      }
    }
    if (!quarantine) {
      stoppingBlockId = tx.blockId
      break
    }

    // Quarantine attempt: recordRejection then complete() (powersync.ts
    // :700-702) — in that order, and a recordRejection throw prevents
    // complete() (and forgetAmbiguousAttempts) from ever running.
    const failRemaining = localRejectFail.get(tx.blockId) ?? 0
    if (failRemaining > 0) {
      localRejectFail.set(tx.blockId, failRemaining - 1)
      rejectionFailureBlockId = tx.blockId
      stoppingBlockId = tx.blockId
      break
    }
    rejectedBlockIds.push(tx.blockId)
    // recordRejection succeeded — complete() runs next, NOT wrapped in its
    // own try/catch (powersync.ts:700-702), so if IT throws the whole pass
    // aborts right here too: the tx stays pending, and the rejection
    // writer's idempotency (267558e29) is exactly what makes a legitimate
    // re-quarantine on the next pass safe (comment 3676858232).
    const completionFailRemainingForTx = localCompletionFail.get(tx.blockId) ?? 0
    if (completionFailRemainingForTx > 0) {
      localCompletionFail.set(tx.blockId, completionFailRemainingForTx - 1)
      completionFailureBlockId = tx.blockId
      stoppingBlockId = tx.blockId
      break
    }
    completedBlockIds.push(tx.blockId)
    if (tx.transactionId !== undefined) localAmbiguous.delete(tx.transactionId)
  }

  return {
    perTxTrace,
    completedBlockIds,
    rejectedBlockIds,
    rejectionFailureBlockId,
    completionFailureBlockId,
    passThrows: stoppingBlockId !== null,
    stoppingBlockId,
    finalAmbiguousAttempts: localAmbiguous,
  }
}

// ──────────────────────────────────────────────────────────────────────
// Simulation runner: drives the REAL orchestrator pass by pass, diffing
// each pass's observable side effects against predictPass.
// ──────────────────────────────────────────────────────────────────────

interface PassRecord {
  readonly passIndex: number
  readonly pendingBlockIds: readonly string[]
  readonly predicted: Prediction
  readonly actualPerTxTrace: ReadonlyArray<{blockId: string; classification: 'success' | UploadErrorClass}>
  readonly actualCompletedBlockIds: readonly string[]
  readonly actualRejectedBlockIds: readonly string[]
  readonly actualRejectionFailureBlockId: string | null
  readonly actualCompletionFailureBlockId: string | null
  readonly threw: boolean
  readonly ambiguousAttemptsAfter: ReadonlyMap<number, number>
}

interface SimulationResult {
  readonly passes: readonly PassRecord[]
  readonly finalStatus: ReadonlyMap<string, 'success' | 'rejected' | 'pending'>
  readonly directCompleteInvocationCounts: ReadonlyMap<string, number>
  readonly recordRejectionSuccessCounts: ReadonlyMap<string, number>
  readonly recordRejectionFailureCounts: ReadonlyMap<string, number>
  readonly completionFailureCounts: ReadonlyMap<string, number>
  readonly applyOperationsTouchLog: ReadonlyArray<{pass: number; blockIds: readonly string[]}>
}

const MAX_PASSES = AMBIGUOUS_RETRY_BUDGET + 4

// Every generated failure (transient / ambiguous / permanent) makes the REAL
// orchestrator log via console.warn/console.error (powersync.ts:660-696) —
// that's expected, not a bug, and in deep/nightly runs it's thousands of
// lines of noise. Suppress exactly these known shapes and nothing else: an
// unrecognised console.warn/error during a run still fails the test (see the
// `unexpectedLogs` assertion in `runSimulationUnspied`) rather than being
// silently absorbed, so a genuinely new log path still surfaces.
const EXPECTED_LOG_PATTERNS: readonly RegExp[] = [
  /^\[powersync\] batch upload failed — isolating \d+ tx\(s\)$/,
  /^\[powersync\] per-tx upload failed \(transient, will retry\)$/,
  /^\[powersync\] tx (?:\d+|undefined) ambiguous upload error — retrying$/,
  /^\[powersync\] tx (?:\d+|undefined) rejected — quarantining$/,
]
const isExpectedLog = (args: readonly unknown[]): boolean =>
  typeof args[0] === 'string' && EXPECTED_LOG_PATTERNS.some(re => re.test(args[0] as string))

// SUITE-scoped, not per-case (PR #448 review comment 3676858226): under
// FUZZ_TIME_MS, fast-check's `interruptAfterTimeLimit` can let `fc.assert`
// return while its final async case is still executing (documented in
// `fuzzTestTimeout`'s own docblock above and `statefulFuzzGuard`'s, both in
// this file's import from `@/test/fuzz`). A per-case install/restore would
// let that abandoned case's `finally` restore the REAL console underneath
// the next property's freshly-installed spy — expected retry logs would
// escape to CI output, and worse, that next simulation's unexpected-log
// oracle would go dead (no spy left to feed it). Installing the spies ONCE
// for this whole describe block's lifetime and only ever swapping which
// buffer the shared mock implementation writes to removes the interleaving
// hazard by construction: there's exactly one spy alive for the block's
// entire run, so there's nothing for a late-arriving abandoned case to
// clobber.
//
// That still leaves the BUFFER itself and teardown exposed (PR #448 review
// comment 3677127994): the buffer swap in `runSimulation` below is a plain
// reassignment, so an abandoned case can append to a buffer a LATER case has
// already checked (and moved past) — a genuinely unexpected log silently
// lost — and an abandoned FINAL case can keep running past `afterAll`'s
// spy restore. `statefulFuzzGuard` (`@/test/fuzz`, docs/fuzzing.md §6) is
// the repo's existing fix for exactly this class of hazard — the same
// mechanism PR #449 adopted — so reuse it rather than inventing a second
// one: `guard.run` serializes every simulation (barrier-before-body, so a
// new case's buffer swap can never happen until the PREVIOUS case, abandoned
// or not, has fully finished appending to its OWN buffer), and `afterAll`
// awaits `guard.barrier()` before restoring the spies, so a truly abandoned
// last case still has a real console to log into while it finishes. `seed:
// null` — nothing here pins `Math.random`, only the barrier ordering is
// needed.
const guard = statefulFuzzGuard()

let currentUnexpectedLogs: unknown[][] = []
const recordIfUnexpected = (...args: unknown[]): void => {
  if (!isExpectedLog(args)) currentUnexpectedLogs.push(args)
}

const runSimulation = (scenario: Scenario): Promise<SimulationResult> =>
  guard.run(null, () => {
    const unexpectedLogs: unknown[][] = []
    currentUnexpectedLogs = unexpectedLogs
    return runSimulationUnspied(scenario, unexpectedLogs)
  })

const runSimulationUnspied = async (
  scenario: Scenario,
  unexpectedLogs: readonly unknown[][],
): Promise<SimulationResult> => {
  const attemptIndex = new Map<string, number>()
  const ambiguousAttempts = new Map<number, number>()
  const rejectionFailRemaining = new Map<string, number>(
    scenario.transactions.filter(tx => tx.rejectionFailsOnce).map(tx => [tx.blockId, 1]),
  )
  const completionFailRemaining = new Map<string, number>(
    scenario.transactions.filter(tx => tx.completionFailsOnceAfterRejection).map(tx => [tx.blockId, 1]),
  )

  let pending = [...scenario.transactions]
  const passes: PassRecord[] = []
  const directCompleteInvocationCounts = new Map<string, number>()
  const recordRejectionSuccessCounts = new Map<string, number>()
  const recordRejectionFailureCounts = new Map<string, number>()
  const completionFailureCounts = new Map<string, number>()
  const applyOperationsTouchLog: Array<{pass: number; blockIds: readonly string[]}> = []
  const drainedBlockIds = new Set<string>()

  for (let passIndex = 0; passIndex < MAX_PASSES && pending.length > 0; passIndex++) {
    const passPending = pending
    const byBlockId = new Map(passPending.map(tx => [tx.blockId, tx]))
    // Same cycling scheme as `Script.tail` (index % length), just at pass
    // granularity instead of per-tx-attempt granularity.
    const forceExogenousBatchFailure =
      scenario.batchExogenousFailures[passIndex % scenario.batchExogenousFailures.length]

    const predicted = predictPass(
      passPending,
      attemptIndex,
      ambiguousAttempts,
      rejectionFailRemaining,
      forceExogenousBatchFailure,
      completionFailRemaining,
    )

    const completedThisPassSet = new Set<string>()
    const completeCallOrderThisPass: string[] = []
    // Armed by a successful `recordRejection` call this pass (below) when
    // that tx's `completionFailsOnceAfterRejection` is still live — the
    // VERY NEXT `complete()` call for that blockId throws once, instead of
    // running the drain logic.
    const pendingCompletionFailure = new Set<string>()
    let completionFailureBlockIdActual: string | null = null
    const crudTxs = passPending.map((tx, idxInPass) => {
      const entry = new CrudEntry(idxInPass, UpdateType.PUT, 'blocks', tx.blockId, tx.transactionId, {v: 1})
      const complete = async (): Promise<void> => {
        if (pendingCompletionFailure.has(tx.blockId)) {
          pendingCompletionFailure.delete(tx.blockId)
          completionFailRemaining.set(tx.blockId, (completionFailRemaining.get(tx.blockId) ?? 0) - 1)
          completionFailureCounts.set(tx.blockId, (completionFailureCounts.get(tx.blockId) ?? 0) + 1)
          completionFailureBlockIdActual = tx.blockId
          throw new Error('simulated CrudTransaction.complete() failure after a successful rejection write')
        }
        directCompleteInvocationCounts.set(tx.blockId, (directCompleteInvocationCounts.get(tx.blockId) ?? 0) + 1)
        // Real CrudTransaction.complete() drains every transaction AHEAD of
        // this one too (powersync.ts:622-623 docblock) — model that prefix
        // drain here rather than only marking the direct target.
        for (let i = 0; i <= idxInPass; i++) {
          const id = passPending[i].blockId
          if (!completedThisPassSet.has(id)) {
            completedThisPassSet.add(id)
            completeCallOrderThisPass.push(id)
          }
        }
      }
      return new CrudTransaction([entry], complete, tx.transactionId)
    })

    let callIndexInPass = 0
    const perTxTraceActual: Array<{blockId: string; classification: 'success' | UploadErrorClass}> = []
    // The exact error object each per-tx applyOperations call threw for a
    // block, THIS pass — captured so we can prove `recordRejection` (below)
    // is handed the SAME error for the SAME tx, not the batch's generic
    // error or another transaction's (powersync.ts:700: `catch (err) { ...
    // deps.recordRejection(database, transaction, err) }` — err is always
    // the error THAT tx's own applyOperations call just threw).
    const thrownErrorByBlockId = new Map<string, unknown>()

    const applyOperations = async (
      _database: AbstractPowerSyncDatabase,
      operations: readonly CompactedBlockOperation[],
    ): Promise<void> => {
      const touchedIds = operations.map(op => op.id)
      if (callIndexInPass === 0) {
        applyOperationsTouchLog.push({pass: passIndex, blockIds: touchedIds})
        callIndexInPass++
        const allSuccess = passPending.every(
          tx => stepAt(tx.script, attemptIndex.get(tx.blockId) ?? 0).outcome === 'success',
        )
        if (allSuccess && !forceExogenousBatchFailure) {
          for (const tx of passPending) attemptIndex.set(tx.blockId, (attemptIndex.get(tx.blockId) ?? 0) + 1)
          return
        }
        throw new Error('simulated batch failure')
      }

      callIndexInPass++
      const blockId = touchedIds[0]
      const tx = byBlockId.get(blockId)!
      const step = stepAt(tx.script, attemptIndex.get(blockId) ?? 0)
      attemptIndex.set(blockId, (attemptIndex.get(blockId) ?? 0) + 1)
      applyOperationsTouchLog.push({pass: passIndex, blockIds: [blockId]})
      const classification = classificationOf(step)
      perTxTraceActual.push({blockId, classification})
      if (step.outcome === 'success') return
      thrownErrorByBlockId.set(blockId, step.err)
      throw step.err
    }

    let rejectionFailureBlockIdActual: string | null = null
    const rejectedBlockIdsActual: string[] = []
    // What `recordRejection` was actually called with, per blockId — diffed
    // against `thrownErrorByBlockId` below so a refactor that forwards the
    // wrong error (the batch's, or another tx's) fails the oracle instead of
    // passing silently (PR #448 review comment 3676698835).
    const recordRejectionErrorByBlockId = new Map<string, unknown>()
    const recordRejection = async (
      _database: AbstractPowerSyncDatabase,
      transaction: CrudTransaction,
      error: unknown,
    ): Promise<void> => {
      const blockId = transaction.crud[0].id
      recordRejectionErrorByBlockId.set(blockId, error)
      const remaining = rejectionFailRemaining.get(blockId) ?? 0
      if (remaining > 0) {
        rejectionFailRemaining.set(blockId, remaining - 1)
        recordRejectionFailureCounts.set(blockId, (recordRejectionFailureCounts.get(blockId) ?? 0) + 1)
        rejectionFailureBlockIdActual = blockId
        throw new Error('simulated recordRejection write failure')
      }
      recordRejectionSuccessCounts.set(blockId, (recordRejectionSuccessCounts.get(blockId) ?? 0) + 1)
      rejectedBlockIdsActual.push(blockId)
      if ((completionFailRemaining.get(blockId) ?? 0) > 0) {
        pendingCompletionFailure.add(blockId)
      }
    }

    const deps: UploadDeps = {applyOperations, recordRejection}

    let threw = false
    try {
      await uploadTransactionsWithFallback(fakeDatabase, crudTxs, deps, ambiguousAttempts)
    } catch {
      threw = true
    }

    for (const id of completedThisPassSet) drainedBlockIds.add(id)

    // ── per-pass differential oracle ──
    expect(threw, `pass ${passIndex}: resolve/throw`).toBe(predicted.passThrows)
    expect(perTxTraceActual, `pass ${passIndex}: per-tx trace`).toEqual(predicted.perTxTrace)
    expect(new Set(completeCallOrderThisPass), `pass ${passIndex}: completed set`)
      .toEqual(new Set(predicted.completedBlockIds))
    expect(rejectedBlockIdsActual, `pass ${passIndex}: rejected`).toEqual(predicted.rejectedBlockIds)
    expect(rejectionFailureBlockIdActual, `pass ${passIndex}: rejection-write failure`)
      .toBe(predicted.rejectionFailureBlockId)
    expect(completionFailureBlockIdActual, `pass ${passIndex}: completion failure`)
      .toBe(predicted.completionFailureBlockId)
    expect(new Map(ambiguousAttempts), `pass ${passIndex}: ambiguousAttempts map`)
      .toEqual(predicted.finalAmbiguousAttempts)
    for (const [blockId, errorPassedToRecordRejection] of recordRejectionErrorByBlockId) {
      expect(errorPassedToRecordRejection, `pass ${passIndex}: recordRejection error for ${blockId}`)
        .toBe(thrownErrorByBlockId.get(blockId))
    }

    passes.push({
      passIndex,
      pendingBlockIds: passPending.map(tx => tx.blockId),
      predicted,
      actualPerTxTrace: perTxTraceActual,
      actualCompletedBlockIds: completeCallOrderThisPass,
      actualRejectedBlockIds: rejectedBlockIdsActual,
      actualRejectionFailureBlockId: rejectionFailureBlockIdActual,
      actualCompletionFailureBlockId: completionFailureBlockIdActual,
      threw,
      ambiguousAttemptsAfter: new Map(ambiguousAttempts),
    })

    pending = passPending.filter(tx => !completedThisPassSet.has(tx.blockId))
  }

  expect(unexpectedLogs, 'unexpected console.warn/console.error output during simulation').toEqual([])

  const finalStatus = new Map<string, 'success' | 'rejected' | 'pending'>()
  for (const tx of scenario.transactions) {
    if (!drainedBlockIds.has(tx.blockId)) {
      finalStatus.set(tx.blockId, 'pending')
    } else if ((recordRejectionSuccessCounts.get(tx.blockId) ?? 0) > 0) {
      finalStatus.set(tx.blockId, 'rejected')
    } else {
      finalStatus.set(tx.blockId, 'success')
    }
  }

  return {
    passes,
    finalStatus,
    directCompleteInvocationCounts,
    recordRejectionSuccessCounts,
    recordRejectionFailureCounts,
    completionFailureCounts,
    applyOperationsTouchLog,
  }
}

// ──────────────────────────────────────────────────────────────────────
// Properties (issue #434)
// ──────────────────────────────────────────────────────────────────────

describe('uploadTransactionsWithFallback — retry/classification state machine', () => {
  // Installed ONCE for this describe block (see the rationale above
  // `runSimulation`) — never per-case — so an abandoned fast-check case from
  // a timed-out property can't restore the real console underneath a later
  // property's spy.
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>
  beforeAll(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(recordIfUnexpected)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(recordIfUnexpected)
  })
  afterAll(async () => {
    // Barrier BEFORE restore: let a genuinely abandoned last case (see
    // `guard` above) finish logging into a real, still-mocked console
    // before we tear the spies down.
    await guard.barrier()
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('(a) every tx reaches exactly one terminal fate — never double-completed, never silently dropped', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async scenario => {
        const result = await runSimulation(scenario)
        for (const tx of scenario.transactions) {
          // Never double-completed: this tx's own complete() closure is the
          // DIRECT target of at most one orchestrator call across the whole
          // run (a tx leaves `pending` — and so can never be handed to the
          // orchestrator again — the moment any drain touches it).
          expect(
            result.directCompleteInvocationCounts.get(tx.blockId) ?? 0,
            `tx ${tx.blockId} complete() invoked more than once`,
          ).toBeLessThanOrEqual(1)

          const status = result.finalStatus.get(tx.blockId)
          expect(status, `tx ${tx.blockId} has no recorded fate`).toBeDefined()
          if (status === 'rejected') {
            // >= 1, not exactly 1: a completion failure after a successful
            // rejection write (property e) forces a legitimate repeat
            // recordRejection call on a later pass — see property (e) for
            // the precise bound (successes <= 1 + completionFailures).
            expect(result.recordRejectionSuccessCounts.get(tx.blockId) ?? 0).toBeGreaterThanOrEqual(1)
          }
          if (status === 'success') {
            expect(result.recordRejectionSuccessCounts.get(tx.blockId) ?? 0).toBe(0)
          }
        }
      }),
      fuzzParams(60),
    )
  }, fuzzTestTimeout())

  it('(b) a completed tx is never touched by a later applyOperations call — succeeded prefix never re-uploaded', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async scenario => {
        const result = await runSimulation(scenario)

        const completedAtPass = new Map<string, number>()
        for (const pass of result.passes) {
          for (const blockId of pass.actualCompletedBlockIds) {
            if (!completedAtPass.has(blockId)) completedAtPass.set(blockId, pass.passIndex)
          }
        }
        for (const touch of result.applyOperationsTouchLog) {
          for (const blockId of touch.blockIds) {
            const completedPass = completedAtPass.get(blockId)
            if (completedPass !== undefined) {
              expect(
                touch.pass,
                `${blockId} touched by applyOperations at pass ${touch.pass} after completing at pass ${completedPass}`,
              ).toBeLessThanOrEqual(completedPass)
            }
          }
        }

        // Sharper form of the same guarantee (powersync.ts:602-607): when a
        // pass throws, every tx BEFORE the stopping tx must have drained in
        // that SAME pass — the prefix drains once, not on every retry.
        for (const pass of result.passes) {
          if (!pass.threw || pass.predicted.stoppingBlockId === null) continue
          const stopIdx = pass.pendingBlockIds.indexOf(pass.predicted.stoppingBlockId)
          for (const blockId of pass.pendingBlockIds.slice(0, stopIdx)) {
            expect(
              pass.actualCompletedBlockIds,
              `pass ${pass.passIndex}: prefix tx ${blockId} (before failing tx ${pass.predicted.stoppingBlockId}) must drain this pass`,
            ).toContain(blockId)
          }
        }
      }),
      fuzzParams(60),
    )
  }, fuzzTestTimeout())

  it('(c) a permanent classification never jams the queue — the next pending tx is still attempted the same pass', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async scenario => {
        const result = await runSimulation(scenario)
        for (const pass of result.passes) {
          const attemptedIds = new Set(pass.actualPerTxTrace.map(e => e.blockId))
          pass.actualPerTxTrace.forEach(entry => {
            if (entry.classification !== 'permanent') return
            // A permanent tx whose OWN recordRejection write fails, or whose
            // OWN complete() fails right after a successful write, is a
            // legitimate (and separately-tested, property e) stop — it's
            // the write or the completion that halts the pass there, not
            // the permanent classification "jamming" anything.
            if (pass.predicted.rejectionFailureBlockId === entry.blockId) return
            if (pass.predicted.completionFailureBlockId === entry.blockId) return
            const posInPending = pass.pendingBlockIds.indexOf(entry.blockId)
            const nextId = pass.pendingBlockIds[posInPending + 1]
            if (nextId === undefined) return
            expect(
              attemptedIds.has(nextId),
              `pass ${pass.passIndex}: permanent tx ${entry.blockId} must not block ${nextId} from being attempted`,
            ).toBe(true)
          })
        }
      }),
      fuzzParams(60),
    )
  }, fuzzTestTimeout())

  it('(d) an ambiguous outcome retries only while inside AMBIGUOUS_RETRY_BUDGET, then quarantine is attempted', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async scenario => {
        const result = await runSimulation(scenario)
        const txByBlockId = new Map(scenario.transactions.map(tx => [tx.blockId, tx]))

        // Independent re-count of the ambiguous streak per transactionId,
        // driven purely from the OBSERVED per-pass outcomes (never from
        // predictPass's own internal map) — deliberately separate from the
        // per-pass differential oracle in runSimulation, which already
        // checks the real `ambiguousAttempts` map matches predictPass's
        // post-pass snapshot. That snapshot is taken AFTER
        // forgetAmbiguousAttempts may have cleared the entry (on a
        // successful quarantine), so it can't answer "was the budget
        // actually respected at the moment of the retry/quarantine
        // decision" — this streak reconstructs that moment instead,
        // mirroring forgetAmbiguousAttempts' own reset conditions
        // (powersync.ts:582-587 for the reset; :700-703 for what has to
        // succeed first — success, or a quarantine whose recordRejection AND
        // subsequent complete() both succeeded — never a bare retry, never a
        // failed recordRejection write, never a failed complete()).
        const streakByTxId = new Map<number, number>()
        for (const pass of result.passes) {
          for (const entry of pass.actualPerTxTrace) {
            const tx = txByBlockId.get(entry.blockId)!
            if (tx.transactionId === undefined) {
              // Untracked id: ambiguousBudgetExhausted treats it as
              // already-exhausted (powersync.ts:574) — an ambiguous hit can
              // only stop THIS pass via a recordRejection write failure or a
              // completion failure, never via "still has budget left".
              if (entry.classification === 'ambiguous' && pass.predicted.stoppingBlockId === entry.blockId) {
                expect(
                  pass.predicted.rejectionFailureBlockId === entry.blockId ||
                    pass.predicted.completionFailureBlockId === entry.blockId,
                  `untracked tx ${entry.blockId} stopped the pass without a rejection-write or completion failure`,
                ).toBe(true)
              }
              continue
            }

            const txId = tx.transactionId
            // forgetAmbiguousAttempts only runs once BOTH recordRejection
            // AND the subsequent complete() succeed (powersync.ts:700-703)
            // — either failing alone is enough to skip it, so the streak
            // must persist through either.
            const quarantineDidNotFullyComplete =
              pass.predicted.rejectionFailureBlockId === entry.blockId ||
              pass.predicted.completionFailureBlockId === entry.blockId

            if (entry.classification === 'success') {
              streakByTxId.delete(txId)
            } else if (entry.classification === 'transient') {
              // forgetAmbiguousAttempts is not reached on a transient
              // re-throw — the streak persists untouched.
            } else if (entry.classification === 'permanent') {
              if (!quarantineDidNotFullyComplete) streakByTxId.delete(txId)
            } else {
              // ambiguous
              const next = (streakByTxId.get(txId) ?? 0) + 1
              streakByTxId.set(txId, next)
              const stillRetrying = pass.predicted.stoppingBlockId === entry.blockId && !quarantineDidNotFullyComplete
              if (stillRetrying) {
                expect(next, `tx ${entry.blockId} retried past its ambiguous budget`).toBeLessThan(AMBIGUOUS_RETRY_BUDGET)
              } else {
                expect(next, `tx ${entry.blockId} quarantined without exhausting its ambiguous budget`)
                  .toBeGreaterThanOrEqual(AMBIGUOUS_RETRY_BUDGET)
                if (!quarantineDidNotFullyComplete) streakByTxId.delete(txId)
              }
            }
          }
        }
      }),
      fuzzParams(60),
    )
  }, fuzzTestTimeout())

  it('(e) recordRejection always precedes complete(); a failed write or a failed completion never falsely drains the tx, and a completion failure legitimately re-quarantines next pass', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async scenario => {
        const result = await runSimulation(scenario)

        for (const pass of result.passes) {
          if (pass.predicted.rejectionFailureBlockId !== null) {
            expect(
              pass.actualCompletedBlockIds,
              `pass ${pass.passIndex}: tx ${pass.predicted.rejectionFailureBlockId} drained despite a recordRejection write failure`,
            ).not.toContain(pass.predicted.rejectionFailureBlockId)
          }
          if (pass.predicted.completionFailureBlockId !== null) {
            expect(
              pass.actualCompletedBlockIds,
              `pass ${pass.passIndex}: tx ${pass.predicted.completionFailureBlockId} drained despite its own completion failure`,
            ).not.toContain(pass.predicted.completionFailureBlockId)
          }
        }

        for (const tx of scenario.transactions) {
          const successes = result.recordRejectionSuccessCounts.get(tx.blockId) ?? 0
          const writeFailures = result.recordRejectionFailureCounts.get(tx.blockId) ?? 0
          const completionFailures = result.completionFailureCounts.get(tx.blockId) ?? 0
          expect(writeFailures, `tx ${tx.blockId}: more recordRejection write failures than injected`)
            .toBeLessThanOrEqual(tx.rejectionFailsOnce ? 1 : 0)
          expect(completionFailures, `tx ${tx.blockId}: more completion failures than injected`)
            .toBeLessThanOrEqual(tx.completionFailsOnceAfterRejection ? 1 : 0)
          // Repeated rejection WRITES are allowed and expected — the DB
          // write is idempotent (267558e29) — but only a completion failure
          // legitimately explains a repeat: the tx never actually drained,
          // so the NEXT pass calls the (idempotent) writer again. Without an
          // injected completion failure, at most one success is possible.
          expect(
            successes,
            `tx ${tx.blockId}: recordRejection succeeded more times than its completion failures explain`,
          ).toBeLessThanOrEqual(1 + completionFailures)
          if (result.finalStatus.get(tx.blockId) === 'rejected') {
            expect(successes, `tx ${tx.blockId}: rejected without a successful recordRejection`).toBeGreaterThanOrEqual(1)
            // ...but the transaction drains in EXACTLY ONE pass no matter how
            // many times recordRejection had to run first — the other half
            // of the contract this property pins. NOT
            // directCompleteInvocationCounts here: that counter only tracks
            // this tx's OWN complete() closure being the DIRECT target of a
            // call (property a) — a tx swept up by a LATER tx's prefix-drain
            // (CrudTransaction.complete() draining everything ahead of it,
            // powersync.ts:622-623) legitimately drains with that counter
            // still at 0. `actualCompletedBlockIds` is the observed
            // per-pass drain trace regardless of which tx's closure carried
            // it, so membership across passes is the right thing to bound.
            const passesWhereDrained =
              result.passes.filter(pass => pass.actualCompletedBlockIds.includes(tx.blockId)).length
            expect(
              passesWhereDrained,
              `tx ${tx.blockId}: rejected tx drained in ${passesWhereDrained} passes, expected exactly 1`,
            ).toBe(1)
          }
        }
      }),
      fuzzParams(60),
    )
  }, fuzzTestTimeout())
})
