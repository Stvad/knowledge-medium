// @vitest-environment node
/**
 * Stateful fuzz suite for `materializeStagingRows` (`../materialize.ts`) —
 * issue #372 Batch 3 item 1. See `src/test/fuzz.ts` for the smoke/deep tier
 * mechanics and `docs/fuzzing.md` §6 for the shared-DB interrupt hazard
 * (`statefulFuzzGuard`, used below).
 *
 * ──── What this drives ────
 *
 * `materializeStagingRows` is exercised directly (never `startBlocksSyncedObserver`
 * — its onChange/throttle timers are nondeterministic and would break fc
 * replay/shrinking). The test's own `doFlush()` calls the shared
 * `drainStagingWindowOnce` helper (`./harness.js`, also used by
 * `twoRepoConvergence.fuzz.test.ts`), which reads the REAL trigger-maintained
 * `blocks_synced_changes` queue, dedups latest-op-per-id, and calls
 * `materializeStagingRows` ONCE per flush (a single window) — mirroring the
 * per-window core of `drainQueueOnce` (`../observer.ts:186-220`: read the queue
 * ordered by seq, `opById.set` per-id dedup at :204-208, `applyWindow` at :210,
 * then `DELETE ... WHERE seq <= maxSeq` at :215). Unlike `drainQueueOnce` this
 * suite does NOT loop over multiple chunk-bounded windows for one flush — that
 * multi-window backlog behavior is `observer.test.ts`'s job, not this file's.
 * `doFlush()` itself layers only the differential-model assertions and the
 * `readChunkSize` passthrough on top of the shared drain (including its
 * `null` empty-queue return).
 * `doDrainWs()` mirrors `drainWorkspace`/`materializeWorkspace` (`../observer.ts:223-244`):
 * re-materialize every currently-staged id of one workspace, `removed: []`.
 *
 * NOT covered here (see the named suites instead):
 *   - multi-window queue draining, throttling, `onChange` wiring — `observer.test.ts`
 *   - cache/handle invalidation fan-out (`applySyncInvalidation`) — `invalidate.test.ts`
 *   - §4.7 cycle-scan telemetry — `observer.test.ts`
 *   - the pure `decideStagingRow` gate's own exhaustive case analysis — `reconcile.fuzz.test.ts`
 *     (this suite REUSES `decideStagingRow` as the model's decision oracle, per the
 *     task brief — it is the pure gate the orchestration is built on, already proven
 *     correct in isolation; what THIS suite tests is `materializeStagingRows`'
 *     orchestration around it: bulk chunked reads, the Phase-1/Phase-2 split, decrypt
 *     vs quarantine, hard-delete-on-`removed` semantics, and idempotent rescans)
 *
 * ──── Universe ────
 *
 * Three workspaces with fixed materializability roles, resolved from a mutable
 * per-case `Map<WsId, Materializability>` (`getMaterializability` just reads it):
 *   - 'ws-copy'   → 'copy'    (plaintext, always materializable)
 *   - 'ws-e2ee'   → 'decrypt' (e2ee, WK always loaded — see `getCek` below)
 *   - 'ws-locked' → starts 'defer', flippable ONCE to 'copy' via the `unlockLocked`
 *     op (latched — models the WK-paste / plaintext-confirm recovery flow)
 *
 * `getCek` returns one `importWorkspaceKey(generateWorkspaceKeyBytes())` key,
 * minted once per fc case — the AES output is never asserted on directly (only
 * round-tripped through `encodeForWire`/decrypt), so the key bytes need not be
 * pinned across cases.
 *
 * Id pool: 3 ids per workspace (`${ws}-b${0,1,2}`, 9 total). Stamp pool: index
 * into `[0, 1, 2, 3, 5, 8, 1_000_000]` — deliberately small so equal-stamp
 * collisions (the I1 skip-stale exemption boundary, reconcile.ts:88-99) actually
 * happen under random generation. Content: a per-case monotonic counter
 * (`c0`, `c1`, ...) so every write is distinguishable. `parent_id` null,
 * `order_key` 'a0', `properties` `{}`, `references` `[]` EVERYWHERE — avoids
 * alias/FTS trigger interactions and cycle concerns; only `content`,
 * `updated_at`, and `deleted` vary.
 *
 * ──── Model (the differential oracle) ────
 *
 * A JS mirror tracks:
 *   - `local: Map<id, {stamp, content, deleted}>` — mirrors `blocks` (absent = no row)
 *   - `pending: Set<id>` — mirrors ids with an unsent upload queued
 *   - `staged: Map<id, {ws, stamp, deleted, content|GARBAGE}>` — mirrors `blocks_synced`
 *   - `delta: Map<id, 'upsert'|'delete'>` — the queue delta since the last flush
 *     (stage → 'upsert', removeStaging → 'delete'; last write wins per id, exactly
 *     like the real `opById` dedup in `drainQueueOnce`, ../observer.ts:204-208).
 *     `blocks_synced_changes_delete` is an AFTER-DELETE trigger on `blocks_synced`
 *     (clientSchema.ts:362-368) — it fires only for rows the DELETE actually
 *     matched, so `removeStaging` on an id with no staging row is a real no-op:
 *     no trigger fire, no queue entry. The model mirrors this (only records
 *     'delete' when `staged` actually had the row) — the smoke tier caught the
 *     naive "always record 'delete'" version of this model within its first
 *     two generated cases during authoring.
 *
 * On `doFlush()`: consume+clear `mirror.delta` (matching the real seq-consume).
 * For each upserted id still present in `staged`, call the REAL `decideStagingRow`
 * with the mirrored local/pending state; `apply` → GARBAGE means quarantine
 * (mirror unchanged), else `mirror.local` takes the staged row's values;
 * `defer`/`skip-stale` → mirror unchanged. For each 'delete' id: if `staged` has
 * no row for it, materialize hard-deletes UNCONDITIONALLY — even with no local
 * row (`../materialize.ts` Phase-2 removed loop, ~L392-399: `deleted.push(id)`
 * runs before checking whether a `beforeRow` existed) — so the model does the
 * same and drops any local entry; if `staged` still has the row, no-op (an
 * INSERT-OR-REPLACE re-delivery artifact per materialize.ts's defense-in-depth
 * comment, ~L384-391 — NOTE this branch is unreachable through this suite's op
 * set: our `removeStaging`/stage ops are always separate SQL statements, so the
 * `delta` map's last-write-wins semantics already collapse a remove-then-restage
 * into a lone 'upsert' before it ever reaches the 'delete' handling, the same way
 * the real `blocks_synced_changes_insert` trigger collapses a single atomic
 * INSERT-OR-REPLACE's delete+insert pair; kept in the model anyway to stay a
 * faithful mirror of materialize.ts's actual branch shape).
 *
 * `doDrainWs(ws)` mirrors the same decision loop over every id currently in
 * `staged` for that workspace, no `removed` side.
 *
 * Asserted after every flush/drainWs: outcome sets (sorted) match the model's
 * `applied`/`skippedStale`/`deferred`/`quarantined`/`deleted` exactly; the raw
 * `blocks` table (id/content/updated_at/deleted) matches the model's `local` map
 * exactly; and (flush only) the queue is fully consumed (`queueLen() === 0`).
 *
 * Final phase per case: flush, then drain every workspace, asserting model
 * agreement throughout; then drain every workspace a SECOND time and assert the
 * raw `blocks` snapshot is byte-identical to the snapshot after the first round
 * — an idempotent-rescan check independent of the model. (Stamp-0 rows legally
 * re-apply on every redelivery per the I2 exemption, reconcile.ts:100-105, but
 * with identical content each time, so byte-identical equality still holds.)
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout, statefulFuzzGuard } from '@/test/fuzz'
import { resetTestDb } from '@/data/test/createTestDb'
import { materializeStagingRows, type MaterializeDeps } from '../materialize.js'
import { decideStagingRow } from '../reconcile.js'
import {
  encodeForWire,
  type GetMaterializability,
  type Materializability,
} from '@/sync/transform.js'
import { generateWorkspaceKeyBytes, importWorkspaceKey } from '@/sync/crypto/workspaceKey.js'
import { BLOCKS_TABLE_COLUMN_NAMES, blockToRowParams } from '@/data/blockSchema.js'
import { drainStagingWindowOnce, setupObserverTestDb, stagingCiphertextParams } from './harness.js'
import type { BlockData } from '@/data/api'

type WsId = 'ws-copy' | 'ws-e2ee' | 'ws-locked'
const WORKSPACES: readonly WsId[] = ['ws-copy', 'ws-e2ee', 'ws-locked']
const STAMPS = [0, 1, 2, 3, 5, 8, 1_000_000] as const
/** Sentinel for a staged e2ee row that was staged with garbage ciphertext
 *  (well-formed `enc:v1:` envelope prefix, undecryptable) — never a value
 *  `nextContent()` can produce, so equality is safe. */
const GARBAGE_MARKER = '\0GARBAGE\0'

const blockId = (ws: WsId, idIdx: number): string => `${ws}-b${idIdx}`

const blockData = (overrides: Partial<BlockData> = {}): BlockData => ({
  id: 'seed',
  workspaceId: 'ws-copy',
  parentId: null,
  orderKey: 'a0',
  content: '',
  properties: {},
  references: [],
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
  userUpdatedAt: 1700000000000,
  createdBy: 'user-1',
  updatedBy: 'user-1',
  deleted: false,
  ...overrides,
})

// Storage + local columns: this is a LOCAL `blocks` write (not staging), and
// `blockToRowParams` produces params for the full set including the local
// `reference_target_id` (PR #288 slice A). Building the INSERT from the
// storage-only set would under-count the placeholders vs. the 14 params.
const BLOCKS_COLUMN_NAMES = BLOCKS_TABLE_COLUMN_NAMES
const INSERT_OR_REPLACE_BLOCKS_SQL =
  `INSERT OR REPLACE INTO blocks (${BLOCKS_COLUMN_NAMES.join(', ')}) ` +
  `VALUES (${BLOCKS_COLUMN_NAMES.map(() => '?').join(', ')})`

// ──── Op universe ────

type FuzzOp =
  | { kind: 'stagePlain'; ws: 'ws-copy' | 'ws-locked'; idIdx: number; stampIdx: number }
  | { kind: 'stageE2ee'; idIdx: number; stampIdx: number; valid: boolean }
  | { kind: 'stageTombstone'; ws: WsId; idIdx: number; stampIdx: number }
  | { kind: 'removeStaging'; ws: WsId; idIdx: number }
  | { kind: 'localWrite'; ws: WsId; idIdx: number; stampIdx: number; queuePending: boolean }
  | { kind: 'ackPending'; ws: WsId; idIdx: number }
  | { kind: 'flush' }
  | { kind: 'drainWs'; ws: WsId }
  | { kind: 'unlockLocked' }

const idIdxArb = fc.integer({ min: 0, max: 2 })
const stampIdxArb = fc.integer({ min: 0, max: STAMPS.length - 1 })
const wsAnyArb = fc.constantFrom(...WORKSPACES)
const wsCopyOrLockedArb = fc.constantFrom<'ws-copy' | 'ws-locked'>('ws-copy', 'ws-locked')

// stageE2ee weighted low: encodeForWire is real WebCrypto per op.
const opArb: fc.Arbitrary<FuzzOp> = fc.oneof(
  { weight: 4, arbitrary: fc.record({
    kind: fc.constant('stagePlain' as const), ws: wsCopyOrLockedArb, idIdx: idIdxArb, stampIdx: stampIdxArb,
  }) },
  { weight: 1, arbitrary: fc.record({
    kind: fc.constant('stageE2ee' as const), idIdx: idIdxArb, stampIdx: stampIdxArb, valid: fc.boolean(),
  }) },
  { weight: 2, arbitrary: fc.record({
    kind: fc.constant('stageTombstone' as const), ws: wsAnyArb, idIdx: idIdxArb, stampIdx: stampIdxArb,
  }) },
  { weight: 2, arbitrary: fc.record({
    kind: fc.constant('removeStaging' as const), ws: wsAnyArb, idIdx: idIdxArb,
  }) },
  { weight: 3, arbitrary: fc.record({
    kind: fc.constant('localWrite' as const), ws: wsAnyArb, idIdx: idIdxArb, stampIdx: stampIdxArb, queuePending: fc.boolean(),
  }) },
  { weight: 2, arbitrary: fc.record({
    kind: fc.constant('ackPending' as const), ws: wsAnyArb, idIdx: idIdxArb,
  }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('flush' as const) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('drainWs' as const), ws: wsAnyArb }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('unlockLocked' as const) }) },
)

const caseArb = fc.record({
  ops: fc.array(opArb, { minLength: 0, maxLength: 25 }),
  readChunkSize: fc.constantFrom(2, 500),
})

// ──── Mirror types ────

interface LocalMirrorRow { readonly stamp: number; readonly content: string; readonly deleted: boolean }
interface StagedMirrorRow { readonly ws: WsId; readonly stamp: number; readonly deleted: boolean; readonly content: string }

interface Mirror {
  local: Map<string, LocalMirrorRow>
  pending: Set<string>
  staged: Map<string, StagedMirrorRow>
  delta: Map<string, 'upsert' | 'delete'>
}

const { env, stageRow, deleteStagingRow, queuePendingUpload, queueLen } = setupObserverTestDb()

/** Mocked for the whole suite: quarantine (garbage e2ee) logs one `console.warn`
 *  per row (../materialize.ts:324) — expected noise, not a test failure signal. */
let warnSpy: ReturnType<typeof vi.spyOn>
beforeAll(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterAll(() => { warnSpy.mockRestore() })

/** Interrupt-barrier — see `statefulFuzzGuard` (`@/test/fuzz`, docs/fuzzing.md §6).
 *  `seed: null` below: nothing in this target consults `Math.random` (no
 *  order-key jitter — materializeStagingRows never places blocks), but the
 *  barrier still matters because the DB is shared across fc cases. Registered
 *  AFTER `setupObserverTestDb()` so it runs BEFORE that harness's `afterAll`
 *  cleanup — vitest runs same-level `afterAll` hooks in reverse registration
 *  order, so the later-registered `guard.barrier` fires first. */
const guard = statefulFuzzGuard()
afterAll(guard.barrier)

const runCase = async ({ ops, readChunkSize }: {
  ops: readonly FuzzOp[]; readChunkSize: 2 | 500
}): Promise<void> => {
  await resetTestDb(env.db)

  const key = await importWorkspaceKey(generateWorkspaceKeyBytes())
  const materializabilityState = new Map<WsId, Materializability>([
    ['ws-copy', 'copy'], ['ws-e2ee', 'decrypt'], ['ws-locked', 'defer'],
  ])
  const getMaterializability: GetMaterializability = (workspaceId: string) =>
    materializabilityState.get(workspaceId as WsId) ?? 'defer'
  const deps: MaterializeDeps = { getMaterializability, getCek: async () => key }

  const mirror: Mirror = { local: new Map(), pending: new Set(), staged: new Map(), delta: new Map() }
  let contentCounter = 0
  const nextContent = (): string => `c${contentCounter++}`

  const rawBlocksSnapshot = () =>
    env.db.getAll<{ id: string; content: string; updated_at: number; deleted: 0 | 1 }>(
      'SELECT id, content, updated_at, deleted FROM blocks ORDER BY id',
    )

  const assertBlocksSnapshot = async (): Promise<void> => {
    const rows = await rawBlocksSnapshot()
    const expected = [...mirror.local.entries()]
      .map(([id, row]) => ({
        id, content: row.content, updated_at: row.stamp, deleted: (row.deleted ? 1 : 0) as 0 | 1,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    expect(rows).toEqual(expected)
  }

  const sortedEq = (actual: readonly string[], expected: readonly string[]): void => {
    expect([...actual].sort()).toEqual([...expected].sort())
  }

  const decideFor = (id: string, staged: StagedMirrorRow) =>
    decideStagingRow(materializabilityState.get(staged.ws)!, staged.stamp, {
      localUpdatedAt: mirror.local.get(id)?.stamp ?? null,
      hasPendingUpload: mirror.pending.has(id),
    })

  const applyStagedToLocal = (
    id: string, staged: StagedMirrorRow, applied: string[], quarantined: string[],
  ): void => {
    if (staged.content === GARBAGE_MARKER) {
      quarantined.push(id)
      return
    }
    applied.push(id)
    mirror.local.set(id, { stamp: staged.stamp, content: staged.content, deleted: staged.deleted })
  }

  const doFlush = async (): Promise<void> => {
    const outcome = await drainStagingWindowOnce(env.db, deps, { readChunkSize })
    if (outcome === null) {
      expect(mirror.delta.size, 'no queued db changes ⟹ mirror delta must also be empty').toBe(0)
      await assertBlocksSnapshot()
      expect(await queueLen()).toBe(0)
      return
    }

    const applied: string[] = []
    const deferred: string[] = []
    const skippedStale: string[] = []
    const quarantined: string[] = []
    const deleted: string[] = []
    for (const [id, op] of mirror.delta) {
      if (op === 'delete') {
        if (!mirror.staged.has(id)) {
          deleted.push(id)
          mirror.local.delete(id)
        }
        // else: staging row still present — INSERT-OR-REPLACE artifact, no-op
        // (see docblock: unreachable via this suite's op set, kept for fidelity).
        continue
      }
      const staged = mirror.staged.get(id)
      if (!staged) continue // defensive; see docblock — delta 'upsert' implies staged is present
      const action = decideFor(id, staged)
      if (action.kind === 'defer') { deferred.push(id); continue }
      if (action.kind === 'skip-stale') { skippedStale.push(id); continue }
      applyStagedToLocal(id, staged, applied, quarantined)
    }
    mirror.delta.clear()

    sortedEq(outcome.applied, applied)
    sortedEq(outcome.deferred, deferred)
    sortedEq(outcome.skippedStale, skippedStale)
    sortedEq(outcome.quarantined, quarantined)
    sortedEq(outcome.deleted, deleted)
    await assertBlocksSnapshot()
    expect(await queueLen()).toBe(0)
  }

  const doDrainWs = async (ws: WsId): Promise<void> => {
    const idsRows = await env.db.getAll<{ id: string }>(
      'SELECT id FROM blocks_synced WHERE workspace_id = ? ORDER BY id', [ws],
    )
    const outcome = await materializeStagingRows(
      env.db, { upserted: idsRows.map(r => r.id), removed: [] }, deps, { readChunkSize },
    )

    const applied: string[] = []
    const deferred: string[] = []
    const skippedStale: string[] = []
    const quarantined: string[] = []
    for (const [id, staged] of mirror.staged) {
      if (staged.ws !== ws) continue
      const action = decideFor(id, staged)
      if (action.kind === 'defer') { deferred.push(id); continue }
      if (action.kind === 'skip-stale') { skippedStale.push(id); continue }
      applyStagedToLocal(id, staged, applied, quarantined)
    }

    sortedEq(outcome.applied, applied)
    sortedEq(outcome.deferred, deferred)
    sortedEq(outcome.skippedStale, skippedStale)
    sortedEq(outcome.quarantined, quarantined)
    expect(outcome.deleted, 'drainWs never removes (removed: [])').toEqual([])
    await assertBlocksSnapshot()
  }

  const doStage = async (
    ws: WsId, idIdx: number, stampIdx: number, deleted: boolean, garbage: boolean,
  ): Promise<void> => {
    const id = blockId(ws, idIdx)
    const stamp = STAMPS[stampIdx]!
    const content = nextContent()
    const data = blockData({ id, workspaceId: ws, content, updatedAt: stamp, deleted })
    if (ws === 'ws-e2ee') {
      if (garbage) {
        await stageRow(data, stagingCiphertextParams(data, {
          content: 'enc:v1:not-real-ciphertext',
          properties_json: 'enc:v1:not-real-ciphertext',
          references_json: 'enc:v1:not-real-ciphertext',
        }))
        mirror.staged.set(id, { ws, stamp, deleted, content: GARBAGE_MARKER })
      } else {
        const wire = await encodeForWire(
          {
            id: data.id, workspace_id: data.workspaceId, content: data.content,
            properties_json: JSON.stringify(data.properties), references_json: JSON.stringify(data.references),
          },
          'e2ee', async () => key,
        )
        await stageRow(data, stagingCiphertextParams(data, wire))
        mirror.staged.set(id, { ws, stamp, deleted, content })
      }
    } else {
      await stageRow(data)
      mirror.staged.set(id, { ws, stamp, deleted, content })
    }
    mirror.delta.set(id, 'upsert')
  }

  for (const op of ops) {
    switch (op.kind) {
      case 'stagePlain':
        await doStage(op.ws, op.idIdx, op.stampIdx, false, false)
        break
      case 'stageE2ee':
        await doStage('ws-e2ee', op.idIdx, op.stampIdx, false, !op.valid)
        break
      case 'stageTombstone':
        await doStage(op.ws, op.idIdx, op.stampIdx, true, false)
        break
      case 'removeStaging': {
        // `blocks_synced_changes_delete` is an AFTER-DELETE-ON-blocks_synced
        // trigger (clientSchema.ts:362-368) — it only fires for rows the
        // DELETE actually matched. Deleting an id with no staging row is a
        // real no-op: no trigger fire, no queue entry, no staged-state change.
        const id = blockId(op.ws, op.idIdx)
        const wasStaged = mirror.staged.has(id)
        await deleteStagingRow(id)
        if (wasStaged) {
          mirror.staged.delete(id)
          mirror.delta.set(id, 'delete')
        }
        break
      }
      case 'localWrite': {
        const id = blockId(op.ws, op.idIdx)
        const stamp = STAMPS[op.stampIdx]!
        const content = nextContent()
        const data = blockData({ id, workspaceId: op.ws, content, updatedAt: stamp, deleted: false })
        await env.db.execute(INSERT_OR_REPLACE_BLOCKS_SQL, blockToRowParams(data))
        mirror.local.set(id, { stamp, content, deleted: false })
        if (op.queuePending) {
          await queuePendingUpload(id)
          mirror.pending.add(id)
        }
        break
      }
      case 'ackPending': {
        const id = blockId(op.ws, op.idIdx)
        await env.db.execute("DELETE FROM ps_crud WHERE json_extract(data,'$.id') = ?", [id])
        mirror.pending.delete(id)
        break
      }
      case 'flush':
        await doFlush()
        break
      case 'drainWs':
        await doDrainWs(op.ws)
        break
      case 'unlockLocked':
        materializabilityState.set('ws-locked', 'copy')
        break
    }
  }

  // ── Final phase ──
  await doFlush()
  for (const ws of WORKSPACES) await doDrainWs(ws)

  const beforeIdempotencyCheck = await rawBlocksSnapshot()
  for (const ws of WORKSPACES) await doDrainWs(ws)
  const afterIdempotencyCheck = await rawBlocksSnapshot()
  expect(
    afterIdempotencyCheck,
    'idempotent rescan: a second drainWs pass over every workspace changes nothing ' +
      '— stamp-0 rows legally re-apply (I2 exemption, reconcile.ts:100-105) but with ' +
      'identical content each time, so the raw snapshot is unchanged',
  ).toEqual(beforeIdempotencyCheck)
}

describe('materializeStagingRows — stateful fuzz (issue #372 Batch 3)', () => {
  it('every flush/drainWs converges to the decideStagingRow model prediction', async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, caseValue => guard.run(null, () => runCase(caseValue))),
      fuzzParams(15),
    )
  }, fuzzTestTimeout())
})
