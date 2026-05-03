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
import { Repo } from '../repo'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { kernelDataExtension } from '@/data/kernelDataExtension.ts'
import { backlinksDataExtension } from '@/plugins/backlinks/dataExtension.ts'
import { BACKLINKS_FOR_BLOCK_QUERY } from '@/plugins/backlinks/query.ts'
import {
  LoaderHandle,
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
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    backlinksDataExtension,
  ]))
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

  it('tables: emits ["blocks"] for any non-empty snapshot map (reviewer P2)', () => {
    // Without this, query handles declaring `{kind:'table', table:'blocks'}`
    // never re-resolve from the TxEngine fast path. Empty-result table-scan
    // queries (no per-row deps captured) are the canonical case.
    const map = new Map<string, ChangeSnapshot>([
      ['a', {before: null, after: {parentId: null, workspaceId: 'w'}}],
    ])
    const note = snapshotsToChangeNotification(map)
    expect(Array.from(note.tables ?? [])).toEqual(['blocks'])
  })

  it('tables: undefined for an empty snapshot map (no spurious table notification)', () => {
    const note = snapshotsToChangeNotification(new Map())
    expect(note.tables).toBeUndefined()
  })

  // ──── backlinkTargets — symmetric diff of references ────

  it('backlinkTargets: new live row contributes all its target ids', () => {
    const map = new Map<string, ChangeSnapshot>([
      ['src', {
        before: null,
        after: {parentId: null, workspaceId: 'w', references: [{id: 'tgt-a'}, {id: 'tgt-b'}]},
      }],
    ])
    const note = snapshotsToChangeNotification(map)
    expect(Array.from(note.backlinkTargets ?? []).sort()).toEqual(['tgt-a', 'tgt-b'])
  })

  it('backlinkTargets: soft-delete of a row with refs contributes all its prior targets', () => {
    const map = new Map<string, ChangeSnapshot>([
      ['src', {
        before: {parentId: null, workspaceId: 'w', deleted: false, references: [{id: 'tgt-x'}]},
        after: {parentId: null, workspaceId: 'w', deleted: true, references: [{id: 'tgt-x'}]},
      }],
    ])
    const note = snapshotsToChangeNotification(map)
    expect(Array.from(note.backlinkTargets ?? [])).toEqual(['tgt-x'])
  })

  it('backlinkTargets: tombstone restore contributes all current targets', () => {
    const map = new Map<string, ChangeSnapshot>([
      ['src', {
        before: {parentId: null, workspaceId: 'w', deleted: true, references: [{id: 'tgt-x'}]},
        after: {parentId: null, workspaceId: 'w', deleted: false, references: [{id: 'tgt-x'}]},
      }],
    ])
    const note = snapshotsToChangeNotification(map)
    expect(Array.from(note.backlinkTargets ?? [])).toEqual(['tgt-x'])
  })

  it('backlinkTargets: refs added/removed contribute only the symmetric difference', () => {
    const map = new Map<string, ChangeSnapshot>([
      ['src', {
        before: {parentId: null, workspaceId: 'w', references: [{id: 'kept'}, {id: 'removed'}]},
        after: {parentId: null, workspaceId: 'w', references: [{id: 'kept'}, {id: 'added'}]},
      }],
    ])
    const note = snapshotsToChangeNotification(map)
    expect(Array.from(note.backlinkTargets ?? []).sort()).toEqual(['added', 'removed'])
  })

  it('backlinkTargets: pure content edit with unchanged references contributes nothing', () => {
    // The whole point of the new dep — a focus/content edit that doesn't
    // alter the set of distinct outgoing targets must not invalidate any
    // backlinks handle.
    const map = new Map<string, ChangeSnapshot>([
      ['src', {
        before: {parentId: null, workspaceId: 'w', references: [{id: 'tgt'}]},
        after: {parentId: null, workspaceId: 'w', references: [{id: 'tgt'}]},
      }],
    ])
    const note = snapshotsToChangeNotification(map)
    expect(Array.from(note.backlinkTargets ?? [])).toEqual([])
  })

  it('backlinkTargets: alias-only change to the same target contributes nothing', () => {
    // Two BlockReference entries pointing at the same target id with
    // different aliases (Roam-style `[[Foo]]` vs `[[foo]]`) — the set of
    // distinct target ids is the same, so the backlinks handle for that
    // target doesn't need to re-resolve. (The block_references row set
    // does change, but the consumer-visible result of
    // `backlinks.forBlock({id})` does not.)
    const map = new Map<string, ChangeSnapshot>([
      ['src', {
        before: {parentId: null, workspaceId: 'w', references: [{id: 'tgt'}]},
        after: {parentId: null, workspaceId: 'w', references: [{id: 'tgt'}, {id: 'tgt'}]},
      }],
    ])
    const note = snapshotsToChangeNotification(map)
    expect(Array.from(note.backlinkTargets ?? [])).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════
// TxEngine fast path
// ════════════════════════════════════════════════════════════════════

describe('TxEngine fast path: repo.tx → handle re-resolve', () => {
  beforeEach(async () => { env = await setup({startTail: false}) })

  it('children handle re-resolves when a child is added via repo.tx', async () => {
    await create('p')
    const h = env.repo.query.children({id: 'p'})
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
    const h1 = env.repo.query.children({id: 'p1'})
    const h2 = env.repo.query.children({id: 'p2'})
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
    const h = env.repo.query.subtree({id: 'r'})
    const fired: number[] = []
    h.subscribe(v => fired.push(v.length))
    await vi.waitFor(() => expect(fired).toEqual([2])) // r + a

    await create('b', {parentId: 'a', orderKey: 'b0'})
    await vi.waitFor(() => expect(fired).toEqual([2, 3])) // r + a + b
  })

  it('row dep: pure content edit fires handle even without parent-edge change', async () => {
    await create('p')
    await create('c1', {parentId: 'p', orderKey: 'a0', content: 'first'})
    const h = env.repo.query.children({id: 'p'})
    const fired: BlockData[][] = []
    h.subscribe(v => fired.push(v))
    await vi.waitFor(() => expect(fired.length).toBe(1))
    expect(fired[0][0].content).toBe('first')

    await env.repo.mutate.setContent({id: 'c1', content: 'updated'})
    await vi.waitFor(() => expect(fired.length).toBe(2))
    expect(fired[1][0].content).toBe('updated')
  })

  it('backlink-target dep: handle re-resolves only when some source gains/loses a ref to this target', async () => {
    // Seed three blocks. `target` is the id we'll subscribe backlinks
    // for. `unrelated` is a sibling that points at a *different*
    // target — its writes must not invalidate `target`'s backlinks
    // handle. `src` will start with no refs, then gain a ref to
    // target, then drop it.
    await create('target')
    await create('other-target')
    await create('unrelated')
    await env.repo.tx(tx => tx.create({
      id: 'src',
      workspaceId: 'ws-1',
      parentId: null,
      orderKey: 'src0',
      content: '',
    }), {scope: ChangeScope.BlockDefault})

    const h = env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: 'ws-1', id: 'target'})
    const fired: number[] = []
    h.subscribe(v => fired.push(v.length))
    await vi.waitFor(() => expect(fired).toEqual([0]))

    // Pure content edit on `unrelated` — no references_json change at
    // all. Old workspace-dep would fire; the new dep must NOT.
    await env.repo.mutate.setContent({id: 'unrelated', content: 'noise'})
    await Promise.resolve()
    await Promise.resolve()
    expect(fired).toEqual([0])

    // `unrelated` gains a ref to `other-target`, NOT to `target`. The
    // change notification's backlinkTargets is {other-target}; target's
    // handle still must not fire.
    await env.repo.tx(tx => tx.update('unrelated', {
      references: [{id: 'other-target', alias: 'OT'}],
    }), {scope: ChangeScope.BlockDefault})
    await Promise.resolve()
    await Promise.resolve()
    expect(fired).toEqual([0])

    // Now `src` gains a ref to `target`. backlinkTargets contains
    // 'target' → the handle re-resolves and includes src.
    await env.repo.tx(tx => tx.update('src', {
      references: [{id: 'target', alias: 'T'}],
    }), {scope: ChangeScope.BlockDefault})
    await vi.waitFor(() => expect(fired).toEqual([0, 1]))
    expect(h.peek()?.map(b => b.id)).toEqual(['src'])

    // `src` drops the ref. backlinkTargets contains 'target' →
    // re-resolve, list is empty again.
    await env.repo.tx(tx => tx.update('src', {references: []}), {
      scope: ChangeScope.BlockDefault,
    })
    await vi.waitFor(() => expect(fired).toEqual([0, 1, 0]))
  })

  it('handles outside the change scope are not re-resolved', async () => {
    await create('p1')
    await create('p2')
    await create('a', {parentId: 'p1', orderKey: 'a0'})
    const h2 = env.repo.query.children({id: 'p2'})
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

  it('table-dep handle re-resolves on local repo.tx write (reviewer P2)', async () => {
    // Mirror of the row_events tail test, but for the fast path. A
    // table-only dep needs `tables: ['blocks']` in the fast-path
    // notification or it never fires for local writes either.
    let v = 0
    const handle = env.repo.handleStore.getOrCreate('test:table-fast', () =>
      new LoaderHandle<number>({
        store: env.repo.handleStore,
        key: 'test:table-fast',
        loader: async (ctx) => {
          ctx.depend({kind: 'table', table: 'blocks'})
          return ++v
        },
      }),
    )
    const fired: number[] = []
    handle.subscribe((x) => fired.push(x))
    await vi.waitFor(() => expect(fired.length).toBe(1))

    await create('table-fast-row')
    // Exactly 2 — the matching-invalidate path no longer double-fires
    // (reviewer P2 #3, fixed by reordering observeDuringLoad before
    // invalidate in HandleStore).
    await vi.waitFor(() => expect(fired.length).toBe(2))
    // Settle to confirm no spurious extra reload arrives.
    await Promise.resolve()
    await Promise.resolve()
    expect(fired.length).toBe(2)
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
    const h = env.repo.query.children({id: 'p'})
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
    const h = env.repo.query.children({id: 'p'})
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
    const h = env.repo.query.children({id: 'p'})
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
    // so the load-only handle is marked stale. With no subscribers,
    // LoaderHandle defers the SQL rerun until the next load().
    const v = await h.load()
    expect(v.map(b => b.id)).toEqual(['c1-remote'])
  })

  it('does NOT re-resolve children on pure content edits (reviewer P2)', async () => {
    await create('p')
    await create('c1', {parentId: 'p', orderKey: 'a0', content: 'one'})
    const h = env.repo.query.children({id: 'p'})
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
    expect(await env.repo.query.childIds({id: 'p'}).load()).toEqual(['c1'])
  })

  it('table-dep handle re-resolves on sync-applied write (reviewer P2)', async () => {
    // A handle with ONLY a `{kind:'table', table:'blocks'}` dep — the
    // canonical empty-result table-scan case (no per-row dep was ever
    // captured). Without `tables: ['blocks']` on the tail's
    // notification, the dep would never match and the handle would
    // stay stale on sync writes.
    let v = 0
    const handle = env.repo.handleStore.getOrCreate('test:table-dep', () =>
      new LoaderHandle<number>({
        store: env.repo.handleStore,
        key: 'test:table-dep',
        loader: async (ctx) => {
          ctx.depend({kind: 'table', table: 'blocks'})
          return ++v
        },
      }),
    )
    const fired: number[] = []
    handle.subscribe((x) => fired.push(x))
    await vi.waitFor(() => expect(fired.length).toBe(1))

    env.repo.startRowEventsTail({initialLastId: 0, throttleMs: 0})
    await env.h.db.execute(
      `UPDATE tx_context SET source = NULL, tx_id = NULL, tx_seq = NULL WHERE id = 1`,
    )
    await env.h.db.execute(
      `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
                            properties_json, references_json, created_at,
                            updated_at, created_by, updated_by, deleted)
       VALUES (?, 'ws-1', NULL, 'a0', '', '{}', '[]', 0, 0, 'remote', 'remote', 0)`,
      ['table-dep-row'],
    )
    await env.repo.flushRowEventsTail()
    // Exactly 2 — see the fast-path test for the matching rationale.
    await vi.waitFor(() => expect(fired.length).toBe(2))
    await Promise.resolve()
    await Promise.resolve()
    expect(fired.length).toBe(2)
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
