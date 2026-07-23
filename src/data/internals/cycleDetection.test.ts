// @vitest-environment node
/**
 * Phase 5 acceptance — sync-induced cycle detection (§4.7).
 *
 * Two assertions per the spec's Phase 5 acceptance bullet:
 *   1. `repo.query.subtree(rootId)` over a 2-cycle returns each member
 *      exactly once (no UNION-ALL duplicate explosion). The CTE-level
 *      guard does the work; CTE-level coverage lives in
 *      treeQueries.test.ts. Repeated here against the public surface
 *      because that's the consumer-facing contract.
 *   2. Cycle detection fires per drain pass with non-empty results,
 *      surfaces a `console.warn` (the operator-facing channel), and
 *      hands the same payload to a test `onCycleDetected` callback so
 *      tests can assert shape without grepping log output.
 *
 * Sync writes are modeled the Layout B way: stage the row into
 * `blocks_synced` and let the observer materialize it into `blocks` with
 * source=NULL — bypassing the workspace-invariant trigger exactly as
 * PowerSync's CRUD-apply does, so a cross-block parent cycle can form.
 *
 * Why test against `onCycleDetected` rather than a `repo.events` pub/
 * sub: there are no in-product subscribers in v1 — the alpha policy is
 * "console.warn for operators; manual fix via the §4.7 SQL runbook" —
 * so a pub/sub surface on `Repo` would be plumbing for nobody. The
 * callback option exists on the observer for tests + future telemetry
 * hooks; if a third caller needs it, that's the right time to build a
 * subscriber surface.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CycleDetectedEvent } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { BLOCKS_SYNCED_RAW_TABLE, blockToSyncedRowParams } from '@/data/blockSchema'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '../repo'

interface Harness { h: TestDb; cache: BlockCache; repo: Repo }

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const cache = new BlockCache()
  const repo = new Repo({
    db: h.db,
    cache,
    user: { id: 'u1' },
    startSyncObserver: false, // tests start it explicitly with throttleMs: 0
  })
  env = { h, cache, repo }
})
afterEach(() => {
  if (env) env.repo.stopSyncObserver()
})

// "Newer than the seeded rows" (which carry updated_at = 0), so a sync-applied
// move wins the materialize LWW gate over the seed it replaces.
const NEWER = 9_000_000_000_000

/** Stage a plaintext row into `blocks_synced` (the sync landing zone). The
 *  observer materializes it into `blocks` on the next flush, with source=NULL —
 *  no `ps_crud` entry is created, so these rows behave like genuine downloaded
 *  rows (no pending-upload gate to clear). */
const stage = (o: {
  id: string
  workspaceId?: string
  parentId?: string | null
  orderKey?: string
  content?: string
  updatedAt?: number
}): Promise<unknown> =>
  env.h.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToSyncedRowParams({
    id: o.id,
    workspaceId: o.workspaceId ?? 'ws-1',
    parentId: o.parentId ?? null,
    orderKey: o.orderKey ?? 'a0',
    content: o.content ?? '',
    properties: {},
    references: [],
    createdAt: 0,
    updatedAt: o.updatedAt ?? 0,
    userUpdatedAt: o.updatedAt ?? 0,
    createdBy: 'remote',
    updatedBy: 'remote',
    deleted: false,
  }))

/** Seed a non-cyclic row via the sync path (an insert — never a cycle
 *  candidate, even once materialized). Caller flushes the observer. */
const seedSync = (args: { id: string; workspaceId?: string; parentId?: string | null; orderKey?: string }) =>
  stage(args)

/** Re-parent an existing row via a sync-applied UPSERT — a concurrent client's
 *  move arriving over sync. NEWER stamp so it wins the LWW gate over the seed. */
const movePartySync = (id: string, parentId: string | null) =>
  stage({ id, parentId, updatedAt: NEWER })

describe('cycle detection (§4.7)', () => {
  it('emits cycleDetected with startIds covering both members of a sync-induced 2-cycle', async () => {
    const events: CycleDetectedEvent[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    env.repo.startSyncObserver({ throttleMs: 0, onCycleDetected: e => events.push(e) })

    // Seed A and B (inserts — never cycle candidates, even once materialized).
    await seedSync({ id: 'A', parentId: null, orderKey: 'a0' })
    await seedSync({ id: 'B', parentId: null, orderKey: 'a1' })
    await env.repo.flushSyncObserver()

    // Two concurrent sync-applied moves close the loop:
    //   client X moved A under B; client Y moved B under A.
    await movePartySync('A', 'B')
    await movePartySync('B', 'A')
    await env.repo.flushSyncObserver()

    // Coalesced into one drain pass → one event whose startIds cover both
    // moved rows. Contract: (a) at least one event, (b) every event names
    // ws-1, (c) txIdsInvolved empty (sync writes carry no tx_id), (d) the
    // union of startIds is {A,B}, (e) console.warn fires alongside.
    expect(events.length).toBeGreaterThanOrEqual(1)
    const allStartIds = new Set<string>()
    for (const ev of events) {
      expect(ev.workspaceId).toBe('ws-1')
      // sync-applied materialize writes carry no tx_id; assert empty so a
      // future change that starts tagging them has to update the test.
      expect(ev.txIdsInvolved).toEqual([])
      for (const id of ev.startIds) allStartIds.add(id)
    }
    expect(Array.from(allStartIds).sort()).toEqual(['A', 'B'])
    // Operator-facing channel — fires the same number of times as
    // onCycleDetected, with the workspace + startIds in the message.
    expect(warn.mock.calls.length).toBe(events.length)
    for (const call of warn.mock.calls) {
      expect(String(call[0])).toMatch(/cycleDetected ws=ws-1/)
    }
    warn.mockRestore()
  })

  it('repo.query.subtree on a cyclic root returns each member exactly once', async () => {
    env.repo.startSyncObserver({ throttleMs: 0 })
    await seedSync({ id: 'A', parentId: null, orderKey: 'a0' })
    await seedSync({ id: 'B', parentId: null, orderKey: 'a1' })
    await movePartySync('A', 'B')
    await movePartySync('B', 'A')
    await env.repo.flushSyncObserver()

    const fromA = await env.repo.query.subtree({ id: 'A' }).load()
    const fromB = await env.repo.query.subtree({ id: 'B' }).load()
    expect(fromA.map(b => b.id).sort()).toEqual(['A', 'B'])
    expect(fromB.map(b => b.id).sort()).toEqual(['A', 'B'])
  })

  it('does not fire when sync-applied parent_id changes do not close a loop', async () => {
    const events: CycleDetectedEvent[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    env.repo.startSyncObserver({ throttleMs: 0, onCycleDetected: e => events.push(e) })

    await seedSync({ id: 'A', parentId: null, orderKey: 'a0' })
    await seedSync({ id: 'B', parentId: null, orderKey: 'a1' })
    await env.repo.flushSyncObserver()

    await movePartySync('B', 'A') // one move, no loop
    await env.repo.flushSyncObserver()

    expect(events).toEqual([])
    // Filter for our cycle channel — other warnings (e.g. drain diagnostics)
    // shouldn't make this test flaky.
    const cycleWarns = warn.mock.calls.filter(c => String(c[0]).includes('cycleDetected'))
    expect(cycleWarns).toEqual([])
    warn.mockRestore()
  })

  it('does not fire on pure content edits', async () => {
    const events: CycleDetectedEvent[] = []
    env.repo.startSyncObserver({ throttleMs: 0, onCycleDetected: e => events.push(e) })

    await seedSync({ id: 'A', parentId: null, orderKey: 'a0' })
    await env.repo.flushSyncObserver()

    // A content edit (same parent_id) is not a cycle candidate.
    await stage({ id: 'A', parentId: null, orderKey: 'a0', content: 'remote-edit', updatedAt: NEWER })
    await env.repo.flushSyncObserver()

    expect(events).toEqual([])
  })
})
