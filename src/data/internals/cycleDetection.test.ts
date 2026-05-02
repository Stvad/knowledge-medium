// @vitest-environment node
/**
 * Phase 5 acceptance — sync-induced cycle detection (§4.7).
 *
 * Two assertions per the spec's §13.5 acceptance bullet:
 *   1. `repo.subtree(rootId)` over a 2-cycle returns each member exactly
 *      once (no UNION-ALL duplicate explosion). The CTE-level guard is
 *      what does the work; tests around it live in treeQueries.test.ts.
 *      Repeated here against the public surface (`repo.query.subtree`)
 *      because that's the consumer-facing contract.
 *   2. `repo.events.cycleDetected` fires once per affected workspace
 *      with the right shape — `startIds` enumerates each affected id
 *      that closes back on itself.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CycleDetectedEvent } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from './repo'

interface Harness { h: TestDb; cache: BlockCache; repo: Repo }

let env: Harness
beforeEach(async () => {
  const h = await createTestDb()
  const cache = new BlockCache()
  const repo = new Repo({
    db: h.db,
    cache,
    user: { id: 'u1' },
    startRowEventsTail: false, // tests start it explicitly with throttleMs: 0
  })
  env = { h, cache, repo }
})
afterEach(async () => {
  if (env) {
    env.repo.stopRowEventsTail()
    await env.h.cleanup()
  }
})

/** Insert a row directly via SQL with `tx_context.source = NULL`, so the
 *  row_events trigger COALESCEs to 'sync' — closest in-test approximation
 *  to PowerSync's CRUD-apply path. Same shape as the helpers in
 *  invalidation.test.ts. */
const seedSync = async (
  args: { id: string; workspaceId?: string; parentId?: string | null; orderKey?: string },
): Promise<void> => {
  await env.h.db.execute(
    `UPDATE tx_context SET source = NULL, tx_id = NULL, tx_seq = NULL WHERE id = 1`,
  )
  await env.h.db.execute(
    `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
                          properties_json, references_json, created_at,
                          updated_at, created_by, updated_by, deleted)
     VALUES (?, ?, ?, ?, '', '{}', '[]', 0, 0, 'remote', 'remote', 0)`,
    [
      args.id,
      args.workspaceId ?? 'ws-1',
      args.parentId ?? null,
      args.orderKey ?? 'a0',
    ],
  )
}

/** Repoint an existing block's parent via direct SQL (sync-applied). The
 *  workspace-invariant trigger is gated on `source IS NOT NULL`, so this
 *  bypasses parent-existence checks the same way PowerSync's CRUD-apply
 *  path does. */
const movePartySync = async (id: string, parentId: string | null): Promise<void> => {
  await env.h.db.execute(
    `UPDATE tx_context SET source = NULL, tx_id = NULL, tx_seq = NULL WHERE id = 1`,
  )
  await env.h.db.execute(
    `UPDATE blocks SET parent_id = ? WHERE id = ?`,
    [parentId, id],
  )
}

describe('cycle detection (§4.7)', () => {
  it('emits cycleDetected with startIds covering both members of a sync-induced 2-cycle', async () => {
    // Initial seed: A and B in the same workspace, neither cyclic.
    await seedSync({ id: 'A', parentId: null, orderKey: 'a0' })
    await seedSync({ id: 'B', parentId: null, orderKey: 'a1' })

    const events: CycleDetectedEvent[] = []
    env.repo.events.cycleDetected.subscribe(e => events.push(e))

    // Start the tail consuming from the highest existing id so the
    // initial seed inserts (which DO write row_events with source=sync,
    // but with no parent_id transitions) don't appear as cycle
    // candidates. We want exactly the upcoming UPDATE rows in the scan.
    env.repo.startRowEventsTail({ throttleMs: 0 })
    await env.repo.flushRowEventsTail() // settle the catch-up read

    // Two concurrent sync-applied moves close the loop:
    //   client X moved A under B
    //   client Y moved B under A
    // Both land via PowerSync's CRUD-apply path → source=NULL → tagged
    // 'sync' by the row_events trigger.
    await movePartySync('A', 'B')
    await movePartySync('B', 'A')

    await env.repo.flushRowEventsTail()

    // Under throttleMs=0 the tail may drain once (coalesced — both
    // moves visible in one pass) or twice (move 2 lands after move 1's
    // throttled drain fired). Either is correct per §4.7 ("an event
    // per drain pass that finds a cycle"). The contract callers care
    // about: (a) at least one event fired, (b) every event names
    // ws-1, (c) txIdsInvolved is empty (the trigger writes tx_id =
    // NULL on sync writes), (d) the union of startIds covers both
    // affected rows.
    expect(events.length).toBeGreaterThanOrEqual(1)
    const allStartIds = new Set<string>()
    for (const ev of events) {
      expect(ev.workspaceId).toBe('ws-1')
      // sync-applied row_events have tx_id = NULL by trigger logic;
      // assert empty here so a future implementation change that
      // starts tagging sync tx_ids has to update the test.
      expect(ev.txIdsInvolved).toEqual([])
      for (const id of ev.startIds) allStartIds.add(id)
    }
    expect(Array.from(allStartIds).sort()).toEqual(['A', 'B'])
  })

  it('repo.query.subtree on a cyclic root returns each member exactly once', async () => {
    await seedSync({ id: 'A', parentId: null, orderKey: 'a0' })
    await seedSync({ id: 'B', parentId: null, orderKey: 'a1' })
    await movePartySync('A', 'B')
    await movePartySync('B', 'A')

    const fromA = await env.repo.query.subtree({ id: 'A' }).load()
    const fromB = await env.repo.query.subtree({ id: 'B' }).load()
    expect(fromA.map(b => b.id).sort()).toEqual(['A', 'B'])
    expect(fromB.map(b => b.id).sort()).toEqual(['A', 'B'])
  })

  it('does not fire when sync-applied parent_id changes do not close a loop', async () => {
    // A live, non-cyclic re-parent: B under A. No cycle should be
    // reported.
    await seedSync({ id: 'A', parentId: null, orderKey: 'a0' })
    await seedSync({ id: 'B', parentId: null, orderKey: 'a1' })

    const events: CycleDetectedEvent[] = []
    env.repo.events.cycleDetected.subscribe(e => events.push(e))

    env.repo.startRowEventsTail({ throttleMs: 0 })
    await env.repo.flushRowEventsTail()

    await movePartySync('B', 'A')
    await env.repo.flushRowEventsTail()

    expect(events).toEqual([])
  })

  it('does not fire on pure content edits', async () => {
    await seedSync({ id: 'A', parentId: null, orderKey: 'a0' })

    const events: CycleDetectedEvent[] = []
    env.repo.events.cycleDetected.subscribe(e => events.push(e))

    env.repo.startRowEventsTail({ throttleMs: 0 })
    await env.repo.flushRowEventsTail()

    await env.h.db.execute(
      `UPDATE tx_context SET source = NULL, tx_id = NULL, tx_seq = NULL WHERE id = 1`,
    )
    await env.h.db.execute(`UPDATE blocks SET content = 'remote-edit' WHERE id = 'A'`)

    await env.repo.flushRowEventsTail()
    expect(events).toEqual([])
  })

  it('subscriber that throws does not break subsequent listeners', async () => {
    await seedSync({ id: 'A', parentId: null, orderKey: 'a0' })
    await seedSync({ id: 'B', parentId: null, orderKey: 'a1' })

    const seen: string[] = []
    env.repo.events.cycleDetected.subscribe(() => { throw new Error('boom') })
    env.repo.events.cycleDetected.subscribe(e => { seen.push(e.workspaceId) })

    env.repo.startRowEventsTail({ throttleMs: 0 })
    await env.repo.flushRowEventsTail()
    await movePartySync('A', 'B')
    await movePartySync('B', 'A')
    await env.repo.flushRowEventsTail()

    // Drain pass count varies (see the same-test-suite note above);
    // contract: the working listener fires every time the cycle scan
    // emits, regardless of what the throwing listener does, and every
    // event is for ws-1.
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen.every(ws => ws === 'ws-1')).toBe(true)
  })
})
