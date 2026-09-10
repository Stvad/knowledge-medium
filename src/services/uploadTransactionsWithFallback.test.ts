/**
 * Deterministic regression suite for `uploadTransactionsWithFallback`
 * (powersync.ts:626-705, exported as `__uploadTransactionsWithFallbackForTest`)
 * — pins the two `complete()` failure sites the model-based fuzz suite
 * (`uploadTransactionsWithFallback.fuzz.test.ts`) surfaced but that
 * suite doesn't itself assert against a fixed, hand-readable expectation.
 * See issue #459.
 *
 * ## Scope history — why this file is small
 *
 * #459 originally asked for one test per HISTORICAL failure mode (six fixing
 * commits) plus these two `complete()` sites. Before writing those six, an
 * audit re-ran each mutation against ONLY the pre-existing suites
 * (`powersync.test.ts`, `uploadErrorClassifier.test.ts`) with none of this
 * file's tests present, to check whether deterministic coverage already
 * existed. It did, for all six — see the PR body for the full mutation
 * table. Duplicating six already-pinned tests here would have been six
 * tests to gain a commit-hash citation on each; instead, each pre-existing
 * test got a one-line comment citing its fixing commit (`git show <hash>` to
 * check it against the commit's own description), and only the two
 * `complete()`-site tests — which nothing else in the repo covers — live
 * here.
 *
 * Why these two matter alongside the fuzz suite: the fuzz suite's
 * differential oracle (`predictPass` vs. the real orchestrator) is checked
 * by nothing else in that file — in particular its fixed-point pass-loop
 * detector is a hand-written monotonicity argument, not independently
 * verified. If that detector's state signature ever omits a component, a
 * resolvable scenario silently becomes "still pending" (a valid terminal
 * fate) and no property fails. These two tests don't go through the model
 * or the detector at all: each is a minimal, hand-built scenario a reviewer
 * can check by reading.
 *
 * Each test mocks `UploadDeps` directly (no real Supabase/DB) and drives the
 * exported orchestrator for one pass. Error shapes are minimal local
 * fixtures (not imported from the fuzz suite — its scope is deliberately
 * frozen per #459, and extracting a shared fixtures module would mean
 * editing that file).
 */
import { CrudEntry, UpdateType, type AbstractPowerSyncDatabase, type CrudTransaction } from '@powersync/common'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/services/supabase.js', () => ({
  supabase: {rpc: vi.fn(), from: vi.fn()},
  hasSupabaseAuthConfig: true,
}))

import { __uploadTransactionsWithFallbackForTest, type UploadDeps } from './powersync'

// ──────────────────────────────────────────────────────────────────────
// Minimal local fixtures — deliberately not shared with the fuzz suite
// (see file docblock).
// ──────────────────────────────────────────────────────────────────────

const put = (clientId: number, id: string, data: Record<string, unknown>, txId = 1) =>
  new CrudEntry(clientId, UpdateType.PUT, 'blocks', id, txId, data)

interface FakeTx {
  transactionId: number
  crud: CrudEntry[]
  completed: boolean
  complete: () => Promise<void>
}

const fakeTx = (transactionId: number, crud: CrudEntry[]): FakeTx => {
  const tx = {transactionId, crud, completed: false} as FakeTx
  tx.complete = async () => { tx.completed = true }
  return tx
}

/** Makes `tx.complete()` throw `err` on its first call, then succeed —
 *  models `CrudTransaction.complete()` being re-invoked on a later pass
 *  after failing once. */
const flakyOnComplete = (tx: FakeTx, err: unknown): void => {
  let calls = 0
  tx.complete = async () => {
    calls += 1
    if (calls === 1) throw err
    tx.completed = true
  }
}

const fakeDb = {} as AbstractPowerSyncDatabase

const fkError = (): Error =>
  Object.assign(new Error('violates foreign key constraint'), {code: '23503'})
const networkError = (): Error => new Error('fetch failed')

const collectCalls = () => ({
  applyOperations: vi.fn<UploadDeps['applyOperations']>().mockResolvedValue(undefined),
  recordRejection: vi.fn<UploadDeps['recordRejection']>().mockResolvedValue(undefined),
})

describe('uploadTransactionsWithFallback — complete() failure sites (issue #459, PR #448)', () => {
  it("complete() failing right after a successful BATCH upload falls through to per-tx retry instead of silently dropping the tail tx (powersync.ts:647, #448)", async () => {
    // The batch upload succeeding and its complete() call failing are two
    // separate steps sharing one try/catch: a complete() failure lands in
    // the SAME catch as an upload failure and falls through to the per-tx
    // loop, which re-applies every tx individually — a "prefix re-upload"
    // of transactions the server already accepted, but the alternative
    // (silently treating the batch as done) would leave the tail tx stuck
    // in ps_crud forever.
    const tx1 = fakeTx(1, [put(1, 'block-a', {content: 'A'})])
    const tx2 = fakeTx(2, [put(2, 'block-b', {content: 'B'})])
    flakyOnComplete(tx2, new Error('simulated batch complete() failure'))
    const {applyOperations, recordRejection} = collectCalls()

    await __uploadTransactionsWithFallbackForTest(fakeDb, [tx1, tx2] as unknown as CrudTransaction[], {applyOperations, recordRejection})

    expect(applyOperations).toHaveBeenCalledTimes(3) // batch + tx1 + tx2 (re-applied)
    expect(tx1.completed).toBe(true)
    expect(tx2.completed).toBe(true) // second complete() attempt succeeds
    expect(recordRejection).not.toHaveBeenCalled()
  })

  it('complete() failing right after a successful PER-TX upload is reclassified like an upload error — a permanent shape gets quarantined despite the write landing (powersync.ts:676, #448)', async () => {
    // Unlike the batch-level site, a per-tx complete() failure is NOT
    // wrapped separately: it shares the try with deps.applyOperations, so
    // whatever it throws goes through the SAME classifyUploadError +
    // transient/ambiguous/permanent decision tree an upload error would.
    // A permanent-shaped completion error therefore quarantines the tx even
    // though the upload itself fully succeeded.
    const tx1 = fakeTx(1, [put(1, 'block-a', {content: 'A'})])
    const completeErr = fkError() // permanent-shaped
    flakyOnComplete(tx1, completeErr)
    const {applyOperations, recordRejection} = collectCalls()
    applyOperations
      .mockRejectedValueOnce(networkError()) // batch: transient → per-tx loop
      .mockResolvedValueOnce(undefined)      // tx1's own per-tx upload: succeeds

    await __uploadTransactionsWithFallbackForTest(fakeDb, [tx1] as unknown as CrudTransaction[], {applyOperations, recordRejection})

    expect(recordRejection).toHaveBeenCalledTimes(1)
    expect(recordRejection.mock.calls[0]?.[1]).toBe(tx1)
    expect(recordRejection.mock.calls[0]?.[2]).toBe(completeErr)
    expect(tx1.completed).toBe(true) // quarantine's own complete() call (2nd attempt) succeeds
    expect(applyOperations).toHaveBeenCalledTimes(2) // batch + one per-tx upload; no further re-upload
  })
})
