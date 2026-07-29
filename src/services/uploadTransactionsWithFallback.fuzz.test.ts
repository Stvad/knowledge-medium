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
 * falsely drain the tx).
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
import { describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
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

const transientErrorArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constantFrom(...TRANSIENT_POSTGREST_CODES).map(code => postgrestError(code)),
  fc.constantFrom(...TRANSIENT_HTTP_STATUSES).map(status => httpError(status)),
  fc.constant(new Error('simulated network failure')),
)
const permanentErrorArb: fc.Arbitrary<unknown> = fc.constantFrom(...PERMANENT_CODES).map(code => postgrestError(code))
const ambiguousErrorArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constantFrom(...AMBIGUOUS_HTTP_STATUSES).map(status => httpError(status)),
  fc.tuple(fc.constantFrom(...AMBIGUOUS_HTTP_STATUSES), fc.string({minLength: 3, maxLength: 8})).map(
    ([status, suffix]) => Object.assign(new Error('weird'), {code: `ZZUNKNOWN_${suffix}`, status}),
  ),
)

// ──────────────────────────────────────────────────────────────────────
// Generator ground truth: pins each pool against the REAL classifyUploadError
// directly, independent of the scenario model below. `predictPass` trusts a
// generated error's `bucket` without asking the classifier — these tests are
// what makes that trust sound. A failure here means a POOL is mislabeled
// (a finding to report), not that the state-machine model is wrong.
// ──────────────────────────────────────────────────────────────────────

describe('generator pools — ground truth against the real classifier', () => {
  it('every transient-pool error classifies as transient', () => {
    fc.assert(
      fc.property(transientErrorArb, err => {
        expect(classifyUploadError(err)).toBe('transient')
      }),
      fuzzParams(60),
    )
  }, fuzzTestTimeout())

  it('every permanent-pool error classifies as permanent', () => {
    fc.assert(
      fc.property(permanentErrorArb, err => {
        expect(classifyUploadError(err)).toBe('permanent')
      }),
      fuzzParams(60),
    )
  }, fuzzTestTimeout())

  it('every ambiguous-pool error classifies as ambiguous', () => {
    fc.assert(
      fc.property(ambiguousErrorArb, err => {
        expect(classifyUploadError(err)).toBe('ambiguous')
      }),
      fuzzParams(60),
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
}
interface Scenario {
  readonly transactions: readonly TxModel[]
}

const txSpecArb = fc.record({
  hasTransactionId: fc.oneof({arbitrary: fc.constant(true), weight: 5}, {arbitrary: fc.constant(false), weight: 1}),
  script: scriptArb,
  rejectionFailsOnce: fc.oneof({arbitrary: fc.constant(false), weight: 4}, {arbitrary: fc.constant(true), weight: 1}),
})

const scenarioArb: fc.Arbitrary<Scenario> = fc.integer({min: 1, max: 5}).chain(n =>
  fc.array(txSpecArb, {minLength: n, maxLength: n}).map(specs => ({
    transactions: specs.map((spec, index): TxModel => ({
      index,
      blockId: `blk-${index}`,
      transactionId: spec.hasTransactionId ? index + 1 : undefined,
      script: spec.script,
      rejectionFailsOnce: spec.rejectionFailsOnce,
    })),
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
  readonly passThrows: boolean
  readonly stoppingBlockId: string | null
  readonly finalAmbiguousAttempts: ReadonlyMap<number, number>
}

const predictPass = (
  pending: readonly TxModel[],
  attemptIndex: ReadonlyMap<string, number>,
  ambiguousAttempts: ReadonlyMap<number, number>,
  rejectionFailRemaining: ReadonlyMap<string, number>,
): Prediction => {
  const localAttempt = new Map(attemptIndex)
  const localAmbiguous = new Map(ambiguousAttempts)
  const localRejectFail = new Map(rejectionFailRemaining)
  const peek = (tx: TxModel) => stepAt(tx.script, localAttempt.get(tx.blockId) ?? 0)

  // Batch path (powersync.ts:637-666): one applyOperations call over every
  // pending tx's compacted ops. Any failure — including transient — drops
  // into the per-tx loop untouched (05fe86074); the mock never tells us
  // WHICH tx would have failed at this granularity, only whether they'd
  // all succeed.
  if (pending.every(tx => peek(tx).outcome === 'success')) {
    for (const tx of pending) {
      localAttempt.set(tx.blockId, (localAttempt.get(tx.blockId) ?? 0) + 1)
      if (tx.transactionId !== undefined) localAmbiguous.delete(tx.transactionId)
    }
    return {
      perTxTrace: [],
      completedBlockIds: pending.map(tx => tx.blockId),
      rejectedBlockIds: [],
      rejectionFailureBlockId: null,
      passThrows: false,
      stoppingBlockId: null,
      finalAmbiguousAttempts: localAmbiguous,
    }
  }

  // Per-tx fallback (powersync.ts:672-704): sequential, stops only on a
  // re-thrown error (transient, or ambiguous still inside its budget, or a
  // simulated recordRejection write failure). permanent and
  // budget-exhausted-ambiguous quarantine and CONTINUE (property c).
  const perTxTrace: Array<{blockId: string; classification: 'success' | UploadErrorClass}> = []
  const completedBlockIds: string[] = []
  const rejectedBlockIds: string[] = []
  let rejectionFailureBlockId: string | null = null
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
    completedBlockIds.push(tx.blockId)
    if (tx.transactionId !== undefined) localAmbiguous.delete(tx.transactionId)
  }

  return {
    perTxTrace,
    completedBlockIds,
    rejectedBlockIds,
    rejectionFailureBlockId,
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
  readonly threw: boolean
  readonly ambiguousAttemptsAfter: ReadonlyMap<number, number>
}

interface SimulationResult {
  readonly passes: readonly PassRecord[]
  readonly finalStatus: ReadonlyMap<string, 'success' | 'rejected' | 'pending'>
  readonly directCompleteInvocationCounts: ReadonlyMap<string, number>
  readonly recordRejectionSuccessCounts: ReadonlyMap<string, number>
  readonly recordRejectionFailureCounts: ReadonlyMap<string, number>
  readonly applyOperationsTouchLog: ReadonlyArray<{pass: number; blockIds: readonly string[]}>
}

const MAX_PASSES = AMBIGUOUS_RETRY_BUDGET + 4

const runSimulation = async (scenario: Scenario): Promise<SimulationResult> => {
  const attemptIndex = new Map<string, number>()
  const ambiguousAttempts = new Map<number, number>()
  const rejectionFailRemaining = new Map<string, number>(
    scenario.transactions.filter(tx => tx.rejectionFailsOnce).map(tx => [tx.blockId, 1]),
  )

  let pending = [...scenario.transactions]
  const passes: PassRecord[] = []
  const directCompleteInvocationCounts = new Map<string, number>()
  const recordRejectionSuccessCounts = new Map<string, number>()
  const recordRejectionFailureCounts = new Map<string, number>()
  const applyOperationsTouchLog: Array<{pass: number; blockIds: readonly string[]}> = []
  const drainedBlockIds = new Set<string>()

  for (let passIndex = 0; passIndex < MAX_PASSES && pending.length > 0; passIndex++) {
    const passPending = pending
    const byBlockId = new Map(passPending.map(tx => [tx.blockId, tx]))

    const predicted = predictPass(passPending, attemptIndex, ambiguousAttempts, rejectionFailRemaining)

    const completedThisPassSet = new Set<string>()
    const completeCallOrderThisPass: string[] = []
    const crudTxs = passPending.map((tx, idxInPass) => {
      const entry = new CrudEntry(idxInPass, UpdateType.PUT, 'blocks', tx.blockId, tx.transactionId, {v: 1})
      const complete = async (): Promise<void> => {
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
        if (allSuccess) {
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
      throw step.err
    }

    let rejectionFailureBlockIdActual: string | null = null
    const rejectedBlockIdsActual: string[] = []
    const recordRejection = async (
      _database: AbstractPowerSyncDatabase,
      transaction: CrudTransaction,
    ): Promise<void> => {
      const blockId = transaction.crud[0].id
      const remaining = rejectionFailRemaining.get(blockId) ?? 0
      if (remaining > 0) {
        rejectionFailRemaining.set(blockId, remaining - 1)
        recordRejectionFailureCounts.set(blockId, (recordRejectionFailureCounts.get(blockId) ?? 0) + 1)
        rejectionFailureBlockIdActual = blockId
        throw new Error('simulated recordRejection write failure')
      }
      recordRejectionSuccessCounts.set(blockId, (recordRejectionSuccessCounts.get(blockId) ?? 0) + 1)
      rejectedBlockIdsActual.push(blockId)
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
    expect(new Map(ambiguousAttempts), `pass ${passIndex}: ambiguousAttempts map`)
      .toEqual(predicted.finalAmbiguousAttempts)

    passes.push({
      passIndex,
      pendingBlockIds: passPending.map(tx => tx.blockId),
      predicted,
      actualPerTxTrace: perTxTraceActual,
      actualCompletedBlockIds: completeCallOrderThisPass,
      actualRejectedBlockIds: rejectedBlockIdsActual,
      actualRejectionFailureBlockId: rejectionFailureBlockIdActual,
      threw,
      ambiguousAttemptsAfter: new Map(ambiguousAttempts),
    })

    pending = passPending.filter(tx => !completedThisPassSet.has(tx.blockId))
  }

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
    applyOperationsTouchLog,
  }
}

// ──────────────────────────────────────────────────────────────────────
// Properties (issue #434)
// ──────────────────────────────────────────────────────────────────────

describe('uploadTransactionsWithFallback — retry/classification state machine', () => {
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
            expect(result.recordRejectionSuccessCounts.get(tx.blockId) ?? 0).toBe(1)
          }
          if (status === 'success') {
            expect(result.recordRejectionSuccessCounts.get(tx.blockId) ?? 0).toBe(0)
          }
        }
      }),
      fuzzParams(60),
    )
  })

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
  })

  it('(c) a permanent classification never jams the queue — the next pending tx is still attempted the same pass', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async scenario => {
        const result = await runSimulation(scenario)
        for (const pass of result.passes) {
          const attemptedIds = new Set(pass.actualPerTxTrace.map(e => e.blockId))
          pass.actualPerTxTrace.forEach(entry => {
            if (entry.classification !== 'permanent') return
            // A permanent tx whose OWN recordRejection write fails is a
            // legitimate (and separately-tested, property e) stop — it's
            // the rejection WRITE that halts the pass there, not the
            // permanent classification "jamming" anything.
            if (pass.predicted.rejectionFailureBlockId === entry.blockId) return
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
  })

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
        // (powersync.ts:582-587: success, or a quarantine whose
        // recordRejection succeeded — never a bare retry, never a failed
        // recordRejection write).
        const streakByTxId = new Map<number, number>()
        for (const pass of result.passes) {
          for (const entry of pass.actualPerTxTrace) {
            const tx = txByBlockId.get(entry.blockId)!
            if (tx.transactionId === undefined) {
              // Untracked id: ambiguousBudgetExhausted treats it as
              // already-exhausted (powersync.ts:574) — an ambiguous hit can
              // only stop THIS pass via a recordRejection write failure,
              // never via "still has budget left".
              if (entry.classification === 'ambiguous' && pass.predicted.stoppingBlockId === entry.blockId) {
                expect(
                  pass.predicted.rejectionFailureBlockId,
                  `untracked tx ${entry.blockId} stopped the pass without a rejection-write failure`,
                ).toBe(entry.blockId)
              }
              continue
            }

            const txId = tx.transactionId
            const recordRejectionFailedHere = pass.predicted.rejectionFailureBlockId === entry.blockId

            if (entry.classification === 'success') {
              streakByTxId.delete(txId)
            } else if (entry.classification === 'transient') {
              // forgetAmbiguousAttempts is not reached on a transient
              // re-throw — the streak persists untouched.
            } else if (entry.classification === 'permanent') {
              if (!recordRejectionFailedHere) streakByTxId.delete(txId)
            } else {
              // ambiguous
              const next = (streakByTxId.get(txId) ?? 0) + 1
              streakByTxId.set(txId, next)
              const stillRetrying = pass.predicted.stoppingBlockId === entry.blockId && !recordRejectionFailedHere
              if (stillRetrying) {
                expect(next, `tx ${entry.blockId} retried past its ambiguous budget`).toBeLessThan(AMBIGUOUS_RETRY_BUDGET)
              } else {
                expect(next, `tx ${entry.blockId} quarantined without exhausting its ambiguous budget`)
                  .toBeGreaterThanOrEqual(AMBIGUOUS_RETRY_BUDGET)
                if (!recordRejectionFailedHere) streakByTxId.delete(txId)
              }
            }
          }
        }
      }),
      fuzzParams(60),
    )
  })

  it('(e) recordRejection always precedes complete(); a failed rejection write never falsely drains the tx', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async scenario => {
        const result = await runSimulation(scenario)

        for (const pass of result.passes) {
          if (pass.predicted.rejectionFailureBlockId !== null) {
            expect(
              pass.actualCompletedBlockIds,
              `pass ${pass.passIndex}: tx ${pass.predicted.rejectionFailureBlockId} drained despite a recordRejection failure`,
            ).not.toContain(pass.predicted.rejectionFailureBlockId)
          }
        }

        for (const tx of scenario.transactions) {
          const successes = result.recordRejectionSuccessCounts.get(tx.blockId) ?? 0
          const failures = result.recordRejectionFailureCounts.get(tx.blockId) ?? 0
          expect(successes, `tx ${tx.blockId}: recordRejection succeeded more than once`).toBeLessThanOrEqual(1)
          expect(failures, `tx ${tx.blockId}: more recordRejection failures than injected`)
            .toBeLessThanOrEqual(tx.rejectionFailsOnce ? 1 : 0)
          if (result.finalStatus.get(tx.blockId) === 'rejected') {
            expect(successes, `tx ${tx.blockId}: rejected without a successful recordRejection`).toBe(1)
          }
        }
      }),
      fuzzParams(60),
    )
  })
})
