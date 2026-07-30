/**
 * Deterministic regression suite for `uploadTransactionsWithFallback`
 * (powersync.ts:626-705, exported as `__uploadTransactionsWithFallbackForTest`)
 * — one small, legible test per HISTORICAL failure mode, plus the two
 * `complete()` failure sites `uploadTransactionsWithFallback.fuzz.test.ts`
 * (PR #448) surfaced but doesn't itself assert against a fixed expectation.
 * See issue #459.
 *
 * Why this exists alongside the fuzz suite: the fuzz suite's differential
 * oracle (`predictPass` vs. the real orchestrator) is checked by nothing else
 * in that file — in particular its fixed-point pass-loop detector is a
 * hand-written monotonicity argument, not independently verified. If that
 * detector's state signature ever omits a component, a resolvable scenario
 * silently becomes "still pending" (a valid terminal fate) and no property
 * fails. These tests don't go through the model or the detector at all: each
 * one is a minimal, hand-built scenario tied to a specific commit, so a
 * reviewer can `git show <hash>` and check the test against the commit's own
 * description without trusting any shared machinery.
 *
 * Each test mocks `UploadDeps` directly (no real Supabase/DB) and drives the
 * exported orchestrator for one pass. Error shapes are minimal local
 * fixtures (not imported from the fuzz suite — see #459: the fuzz model's
 * scope is deliberately frozen, and extracting a shared fixtures module
 * would mean editing that file).
 */
import { CrudEntry, UpdateType, type AbstractPowerSyncDatabase, type CrudTransaction } from '@powersync/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  MAX_PATCHES_PER_SUPABASE_RPC,
  __applyBlockPatchesRpcForTest,
  __recordRejectionToTableForTest,
  __uploadTransactionsWithFallbackForTest,
  type UploadDeps,
} from './powersync'

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
 *  after failing once (used by the two complete()-failure-site tests). */
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

describe('uploadTransactionsWithFallback — historical failure modes (issue #459)', () => {
  it('a P0002 SQLSTATE (apply_block_patches rolled back a missing-row patch) quarantines the tx instead of retrying forever (2b18b676c)', async () => {
    // apply_block_patches now RAISEs P0002 and rolls back the whole RPC when
    // a patch's target row is missing (2b18b676c added P0002 to the
    // classifier's permanent set). This pins the orchestrator's side: a
    // P0002-coded error must be classified permanent and quarantined, not
    // fall through to the codeless default 'transient' and jam the queue.
    const tx = fakeTx(1, [put(1, 'block-a', {content: 'A'})])
    const missingRowError = Object.assign(new Error('no_data_found'), {code: 'P0002'})
    const {applyOperations, recordRejection} = collectCalls()
    applyOperations.mockRejectedValue(missingRowError)

    await __uploadTransactionsWithFallbackForTest(fakeDb, [tx] as unknown as CrudTransaction[], {applyOperations, recordRejection})

    expect(recordRejection).toHaveBeenCalledTimes(1)
    expect(recordRejection.mock.calls[0]?.[2]).toBe(missingRowError)
    expect(tx.completed).toBe(true)
  })

  it('a permanent failure on the batch upload isolates per tx instead of jamming the whole queue (58140b90d)', async () => {
    // Before this commit, ANY batch failure just re-threw — one bad tx (an
    // FK violation, the original incident class) blocked the whole bucket
    // forever. The fix drops into a per-tx fallback so the rest of the
    // batch still drains around the one bad tx.
    const tx1 = fakeTx(1, [put(1, 'block-a', {content: 'A'})])
    const tx2 = fakeTx(2, [put(2, 'block-b', {content: 'B'})])
    const tx3 = fakeTx(3, [put(3, 'block-c', {content: 'C'})])
    const {applyOperations, recordRejection} = collectCalls()
    applyOperations
      .mockRejectedValueOnce(fkError())  // batch fails
      .mockResolvedValueOnce(undefined)  // tx1 per-tx: ok
      .mockRejectedValueOnce(fkError())  // tx2 per-tx: still bad
      .mockResolvedValueOnce(undefined)  // tx3 per-tx: ok

    await __uploadTransactionsWithFallbackForTest(fakeDb, [tx1, tx2, tx3] as unknown as CrudTransaction[], {applyOperations, recordRejection})

    expect(recordRejection).toHaveBeenCalledTimes(1)
    expect(recordRejection.mock.calls[0]?.[1]).toBe(tx2)
    expect(tx1.completed).toBe(true)
    expect(tx2.completed).toBe(true) // quarantined, but still drained from ps_crud
    expect(tx3.completed).toBe(true)
  })

  it('a codeless 4xx that only carries the threaded HTTP status classifies ambiguous, not transient, so it can be quarantined instead of retrying forever (71bd72efe, #190)', async () => {
    // Mirrors throwWithHttpStatus's output: a PostgREST error with NO
    // `.code` (a generic 400, a malformed body) but a `.status` attached by
    // the sink. Before this fix the status was dropped, so this exact shape
    // fell through to the codeless default 'transient' and retried forever.
    const tx = fakeTx(1, [put(1, 'block-a', {content: 'A'})])
    const statusOnlyError = Object.assign(new Error('Bad Request'), {status: 400})
    const {applyOperations, recordRejection} = collectCalls()
    applyOperations.mockRejectedValue(statusOnlyError)
    // Pre-seed the ambiguous budget so this single pass exhausts it —
    // isolates the classification question from the multi-pass retry loop.
    const ambiguousAttempts = new Map([[1, AMBIGUOUS_RETRY_BUDGET - 1]])

    await __uploadTransactionsWithFallbackForTest(
      fakeDb, [tx] as unknown as CrudTransaction[], {applyOperations, recordRejection}, ambiguousAttempts,
    )

    expect(recordRejection).toHaveBeenCalledTimes(1) // quarantined, not retried forever
    expect(tx.completed).toBe(true)
  })

  it('rejection recording runs in one atomic writeTransaction, led by an idempotent DELETE-by-tx_id (267558e29)', async () => {
    // Before this fix, recordRejectionToTable ran N bare database.execute()
    // INSERTs with no enclosing transaction and no idempotency: a mid-loop
    // failure left partial rows, and — since complete() is a separate step
    // that might also fail — a re-run duplicated rows instead of cleanly
    // replacing them.
    const calls: {sql: string}[] = []
    const directExecute = vi.fn()
    const database = {
      execute: directExecute,
      writeTransaction: vi.fn(async (cb: (tx: {execute: (sql: string) => Promise<void>}) => Promise<void>) => {
        await cb({execute: async sql => { calls.push({sql}) }})
      }),
    } as unknown as AbstractPowerSyncDatabase
    const tx = fakeTx(7, [put(1, 'block-a', {content: 'A'})])

    await __recordRejectionToTableForTest(database, tx as unknown as CrudTransaction, fkError())

    expect(directExecute).not.toHaveBeenCalled() // no bare execute() outside the transaction
    expect(database.writeTransaction).toHaveBeenCalledTimes(1)
    expect(calls[0]?.sql).toMatch(/DELETE FROM ps_crud_rejected WHERE tx_id/)
    expect(calls[1]?.sql).toMatch(/INSERT INTO ps_crud_rejected/)
  })

  describe('applyBlockPatchesRpc chunking (9fc1b8729)', () => {
    beforeEach(() => { supabaseRef.rpc.mockReset() })

    it('caps each apply_block_patches RPC at MAX_PATCHES_PER_SUPABASE_RPC so an oversized batch cannot trip the statement timeout', async () => {
      // A schema-swap reprojection or bulk import can land thousands of
      // patches in one repo.tx; shipping them all in one RPC runs that many
      // server-side UPDATEs in a single statement and trips Postgres'
      // statement_timeout — classified transient, so PowerSync retried the
      // same oversized batch forever and the queue never drained.
      supabaseRef.rpc.mockResolvedValue({data: null, error: null})
      const total = MAX_PATCHES_PER_SUPABASE_RPC + 1
      const patches = Array.from({length: total}, (_, i) => ({id: `block-${i}`, payload: {content: 'x'}}))

      await __applyBlockPatchesRpcForTest(patches)

      expect(supabaseRef.rpc).toHaveBeenCalledTimes(2)
      for (const call of supabaseRef.rpc.mock.calls) {
        expect((call[1] as {patches: unknown[]}).patches.length).toBeLessThanOrEqual(MAX_PATCHES_PER_SUPABASE_RPC)
      }
    })
  })

  it('a transient batch error drains the succeeded prefix instead of re-throwing the whole batch (05fe86074)', async () => {
    // Before this fix, a transient batch error re-threw the WHOLE batch —
    // fine when creates were ON CONFLICT DO NOTHING, but once they became
    // insert-or-TOUCH, every already-landed create got re-touched (a real
    // WAL write + fleet echo) on every ~5s retry for the life of the
    // transient. The fix routes transient batch errors through the same
    // per-tx loop so the succeeded prefix drains once.
    const tx1 = fakeTx(1, [put(1, 'block-a', {content: 'A'})])
    const tx2 = fakeTx(2, [put(2, 'block-b', {content: 'B'})])
    const {applyOperations, recordRejection} = collectCalls()
    applyOperations
      .mockRejectedValueOnce(networkError()) // batch: transient
      .mockResolvedValueOnce(undefined)      // tx1 per-tx: drains
      .mockRejectedValueOnce(networkError()) // tx2 per-tx: still transient

    await expect(
      __uploadTransactionsWithFallbackForTest(fakeDb, [tx1, tx2] as unknown as CrudTransaction[], {applyOperations, recordRejection}),
    ).rejects.toThrow('fetch failed')

    expect(tx1.completed).toBe(true)  // succeeded prefix drained — no re-touch on retry
    expect(tx2.completed).toBe(false) // still-failing tx stays queued
    expect(recordRejection).not.toHaveBeenCalled()
  })

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
