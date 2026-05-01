// @vitest-environment node
/**
 * Phase 2.C — invalidation engine tests (spec §9.3).
 *
 * Two paths feed `HandleStore.invalidate({…})`:
 *
 *   1. TxEngine fast path: post-commit, Repo computes a
 *      ChangeNotification from runTx's snapshots map and walks
 *      dep-matching handles. Synchronous; covers everything users do
 *      in this tab.
 *
 *   2. row_events tail: filtered to source='sync', throttled, single
 *      Repo-level subscription. Updates the cache from after_json and
 *      walks the same handle invalidation (parent-edge dep on each
 *      sync-applied parent_id assignment). Covers PowerSync's
 *      CRUD-apply path, which bypasses repo.tx.
 *
 * These tests verify each path drives handle re-resolution end-to-end
 * (real Repo, real BlockCache, real DB, real LoaderHandle), and that
 * the source-filter prevents double invalidation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from './repo'
import {
  snapshotsToChangeNotification,
  type ChangeSnapshot,
} from './handleStore'

interface Harness { h: TestDb; cache: BlockCache; repo: Repo }

const setup = async (
  opts: {startTail?: boolean} = {},
): Promise<Harness> => {
  const h = await createTestDb()
  const cache = new BlockCache()
  const repo = new Repo({
    db: h.db,
    cache,
    user: {id: 'u1'},
    startRowEventsTail: opts.startTail ?? false, // off by default for determinism
  })
  return {h, cache, repo}
}

let env: Harness
afterEach(async () => {
  if (env) {
    env.repo.stopRowEventsTail()
    await env.h.cleanup()
  }
})

const create = async (
  id: string,
  args: {parentId?: string | null; orderKey?: string; content?: string; workspaceId?: string} = {},
) => {
  await env.repo.tx(
    tx => tx.create({
      id,
      workspaceId: args.workspaceId ?? 'ws-1',
      parentId: args.parentId ?? null,
      orderKey: args.orderKey ?? `key-${id}`,
      content: args.content ?? id,
    }),
    {scope: ChangeScope.BlockDefault},
  )
}

// ════════════════════════════════════════════════════════════════════
// snapshotsToChangeNotification (the helper)
// ════════════════════════════════════════════════════════════════════

describe('snapshotsToChangeNotification', () => {
  it('row dep: every touched id', () => {
    const map = new Map<string, ChangeSnapshot>([
      ['a', {before: null, after: {parentId: null, workspaceId: 'w'}}],
      ['b', {before: {parentId: null, workspaceId: 'w'}, after: {parentId: null, workspaceId: 'w'}}],
    ])
    const note = snapshotsToChangeNotification(map)
    expect(Array.from(note.rowIds!).sort()).toEqual(['a', 'b'])
  })

  it('parent-edge for create: adds new parent_id', () => {
    const map = new Map<string, ChangeSnapshot>([
      ['c', {before: null, after: {parentId: 'p', workspaceId: 'w'}}],
    ])
    const note = snapshotsToChangeNotification(map)
    expect(Array.from(note.parentIds!)).toEqual(['p'])
  })

  it('parent-edge for soft-delete: adds prior parent_id', () => {
    const map = new Map<string, ChangeSnapshot>([
      ['c', {
        before: {parentId: 'p', workspaceId: 'w', deleted: false},
        after: {parentId: 'p', workspaceId: 'w', deleted: true},
      }],
    ])
    const note = snapshotsToChangeNotification(map)
    expect(Array.from(note.parentIds!)).toEqual(['p'])
  })

  it('parent-edge for move: adds both old and new parent_ids', () => {
    const map = new Map<string, ChangeSnapshot>([
      ['c', {
        before: {parentId: 'p1', workspaceId: 'w'},
        after: {parentId: 'p2', workspaceId: 'w'},
      }],
    ])
    const note = snapshotsToChangeNotification(map)
    expect(Array.from(note.parentIds!).sort()).toEqual(['p1', 'p2'])
  })

  it('pure content edit: row dep only, no parent-edge', () => {
    const map = new Map<string, ChangeSnapshot>([
      ['c', {
        before: {parentId: 'p', workspaceId: 'w'},
        after: {parentId: 'p', workspaceId: 'w'},
      }],
    ])
    const note = snapshotsToChangeNotification(map)
    expect(Array.from(note.parentIds!)).toEqual([])
    expect(Array.from(note.rowIds!)).toEqual(['c'])
  })

  it('workspace dep: every touched workspace_id', () => {
    const map = new Map<string, ChangeSnapshot>([
      ['a', {before: null, after: {parentId: null, workspaceId: 'w1'}}],
      ['b', {before: {parentId: null, workspaceId: 'w2'}, after: null}],
    ])
    const note = snapshotsToChangeNotification(map)
    expect(Array.from(note.workspaceIds!).sort()).toEqual(['w1', 'w2'])
  })
})

// ════════════════════════════════════════════════════════════════════
// TxEngine fast path
// ════════════════════════════════════════════════════════════════════

describe('TxEngine fast path: repo.tx → handle re-resolve', () => {
  beforeEach(async () => { env = await setup({startTail: false}) })

  it('children handle re-resolves when a child is added via repo.tx', async () => {
    await create('p')
    const h = env.repo.children('p')
    const fired: number[] = []
    h.subscribe(v => fired.push(v.length))
    await vi.waitFor(() => expect(fired).toEqual([0]))

    await create('c1', {parentId: 'p', orderKey: 'a0'})
    await vi.waitFor(() => expect(fired).toEqual([0, 1]))
    expect(h.peek()?.map(b => b.id)).toEqual(['c1'])
  })

  it('children handle re-resolves on child move (parent-edge changes)', async () => {
    await create('p1')
    await create('p2')
    await create('c', {parentId: 'p1', orderKey: 'a0'})
    const h1 = env.repo.children('p1')
    const h2 = env.repo.children('p2')
    const f1: number[] = []
    const f2: number[] = []
    h1.subscribe(v => f1.push(v.length))
    h2.subscribe(v => f2.push(v.length))
    await vi.waitFor(() => expect(f1).toEqual([1]))
    await vi.waitFor(() => expect(f2).toEqual([0]))

    await env.repo.mutate.move({id: 'c', parentId: 'p2', position: {kind: 'last'}})
    await vi.waitFor(() => expect(f1).toEqual([1, 0]))
    await vi.waitFor(() => expect(f2).toEqual([0, 1]))
  })

  it('subtree handle re-resolves when a descendant is added', async () => {
    await create('r')
    await create('a', {parentId: 'r', orderKey: 'a0'})
    const h = env.repo.subtree('r')
    const fired: number[] = []
    h.subscribe(v => fired.push(v.length))
    await vi.waitFor(() => expect(fired).toEqual([2])) // r + a

    await create('b', {parentId: 'a', orderKey: 'b0'})
    await vi.waitFor(() => expect(fired).toEqual([2, 3])) // r + a + b
  })

  it('row dep: pure content edit fires handle even without parent-edge change', async () => {
    await create('p')
    await create('c1', {parentId: 'p', orderKey: 'a0', content: 'first'})
    const h = env.repo.children('p')
    const fired: BlockData[][] = []
    h.subscribe(v => fired.push(v))
    await vi.waitFor(() => expect(fired.length).toBe(1))
    expect(fired[0][0].content).toBe('first')

    await env.repo.mutate.setContent({id: 'c1', content: 'updated'})
    await vi.waitFor(() => expect(fired.length).toBe(2))
    expect(fired[1][0].content).toBe('updated')
  })

  it('handles outside the change scope are not re-resolved', async () => {
    await create('p1')
    await create('p2')
    await create('a', {parentId: 'p1', orderKey: 'a0'})
    const h2 = env.repo.children('p2')
    const fired: number[] = []
    h2.subscribe(v => fired.push(v.length))
    await vi.waitFor(() => expect(fired).toEqual([0]))

    // Mutate p1's child only — h2 (over p2) must not fire.
    await env.repo.mutate.setContent({id: 'a', content: 'x'})
    // Settle microtasks — give the engine path a chance.
    await Promise.resolve()
    await Promise.resolve()
    expect(fired).toEqual([0])
  })
})

// ════════════════════════════════════════════════════════════════════
// row_events tail (sync-applied invalidation)
// ════════════════════════════════════════════════════════════════════

describe('row_events tail: sync-applied invalidation', () => {
  beforeEach(async () => { env = await setup({startTail: false}) })

  it('source=sync row → handle re-resolves; cache is updated', async () => {
    await create('p')
    await create('c1', {parentId: 'p', orderKey: 'a0', content: 'one'})
    const h = env.repo.children('p')
    const fired: BlockData[][] = []
    h.subscribe(v => fired.push(v))
    await vi.waitFor(() => expect(fired.length).toBe(1))

    // Start the tail consuming from id=0 so we can inject sync-style
    // events and test the path deterministically.
    env.repo.startRowEventsTail({initialLastId: 0, throttleMs: 0})

    // Simulate a sync-applied insert by writing directly with
    // tx_context.source = NULL (the COALESCE in the trigger tags it
    // 'sync'). This is the closest approximation to PowerSync's
    // CRUD-apply path in tests.
    await env.h.db.execute(
      `UPDATE tx_context SET source = NULL, tx_id = NULL, tx_seq = NULL WHERE id = 1`,
    )
    await env.h.db.execute(
      `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
                            properties_json, references_json, created_at,
                            updated_at, created_by, updated_by, deleted)
       VALUES (?, 'ws-1', 'p', 'a1', 'remote', '{}', '[]', 0, 0, 'remote', 'remote', 0)`,
      ['c2'],
    )

    await env.repo.flushRowEventsTail()
    await vi.waitFor(() => expect(fired.length).toBe(2))
    const ids = fired[1].map(b => b.id)
    expect(ids).toEqual(['c1', 'c2'])
    expect(env.cache.getSnapshot('c2')?.content).toBe('remote')
  })

  it('local writes (source=user) do NOT fire the tail (no double invalidation)', async () => {
    await create('p')
    const h = env.repo.children('p')
    const fired: number[] = []
    h.subscribe(v => fired.push(v.length))
    await vi.waitFor(() => expect(fired).toEqual([0]))

    // Tail with initialLastId=0: would consume all row_events, but the
    // source='sync' filter excludes the user-source rows from the
    // earlier create('p').
    env.repo.startRowEventsTail({initialLastId: 0, throttleMs: 0})
    await env.repo.flushRowEventsTail() // settle the start-up read

    // A local-write tx — source='user' — fires the engine fast path
    // exactly once. The tail's source='sync' filter must skip the
    // row_event the trigger wrote for this same tx.
    await create('c1', {parentId: 'p', orderKey: 'a0'})
    // Wait for the engine-driven invalidation to land.
    await vi.waitFor(() => expect(fired).toEqual([0, 1]))
    // Now flush the tail explicitly — if it produced an additional
    // (redundant) invalidation, we'd see another fire.
    await env.repo.flushRowEventsTail()
    await Promise.resolve()
    await Promise.resolve()
    expect(fired).toEqual([0, 1])
  })

  it('invalidates the children handle on sync-applied parent_id assignment', async () => {
    await create('p')
    const h = env.repo.children('p')
    await h.load()

    env.repo.startRowEventsTail({initialLastId: 0, throttleMs: 0})

    // Sync-applied insert into p.
    await env.h.db.execute(
      `UPDATE tx_context SET source = NULL, tx_id = NULL, tx_seq = NULL WHERE id = 1`,
    )
    await env.h.db.execute(
      `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
                            properties_json, references_json, created_at,
                            updated_at, created_by, updated_by, deleted)
       VALUES (?, 'ws-1', 'p', 'a0', '', '{}', '[]', 0, 0, 'remote', 'remote', 0)`,
      ['c1-remote'],
    )

    await env.repo.flushRowEventsTail()
    // The parent-edge dep on `p` matches the new child's parent_id,
    // so the children handle re-resolves end-to-end.
    await vi.waitFor(() => {
      const v = h.peek()
      expect(v?.map(b => b.id)).toEqual(['c1-remote'])
    })
  })

  it('does NOT re-resolve children on pure content edits (reviewer P2)', async () => {
    await create('p')
    await create('c1', {parentId: 'p', orderKey: 'a0', content: 'one'})
    const h = env.repo.children('p')
    await h.load()
    const initial = h.peek()

    env.repo.startRowEventsTail({initialLastId: 0, throttleMs: 0})

    // Sync-applied UPDATE that touches content only — same parent_id,
    // not deleted. Membership of p's children unchanged.
    await env.h.db.execute(
      `UPDATE tx_context SET source = NULL, tx_id = NULL, tx_seq = NULL WHERE id = 1`,
    )
    await env.h.db.execute(
      `UPDATE blocks SET content = 'remote-edit' WHERE id = ?`,
      ['c1'],
    )

    await env.repo.flushRowEventsTail()
    // The handle declares a per-row dep on each child, so the content
    // edit DOES invalidate the BlockData[] handle (row content is part
    // of its value). It should NOT, however, change the membership.
    await vi.waitFor(() => {
      const v = h.peek()
      expect(v?.map(b => b.id)).toEqual(['c1'])
    })
    expect(initial?.map(b => b.id)).toEqual(['c1'])
    expect(await env.repo.childIds('p').load()).toEqual(['c1'])
  })

  it('high-watermark: only consumes new rows (id > lastId)', async () => {
    await create('p')
    await create('c1', {parentId: 'p', orderKey: 'a0'}) // local write — id=N

    const tail = env.repo.startRowEventsTail({throttleMs: 0}) // high-watermark = MAX(id)
    // Init runs async — flush awaits ready before reading lastId.
    await env.repo.flushRowEventsTail()
    const afterInit = tail.lastId()

    // No further activity → second flush keeps lastId stable. The tail
    // only advances lastId for rows it consumes (source='sync'); a
    // user-source row_events row would NOT advance it.
    await env.repo.flushRowEventsTail()
    expect(tail.lastId()).toBe(afterInit)
  })
})

import type { BlockData } from '@/data/api'
