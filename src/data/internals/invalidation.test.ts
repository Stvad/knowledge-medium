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
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
import { kernelDataExtension } from '@/data/kernelDataExtension.js'
import {
  LoaderHandle,
  snapshotsToChangeNotification,
  type ChangeSnapshot,
} from './handleStore'
import type { InvalidationRule } from '@/data/invalidation.js'

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

  it('parent-edge for same-parent order change: adds parent_id', () => {
    const map = new Map<string, ChangeSnapshot>([
      ['c', {
        before: {parentId: 'p', orderKey: 'b0', workspaceId: 'w'},
        after: {parentId: 'p', orderKey: 'a0', workspaceId: 'w'},
      }],
    ])
    const note = snapshotsToChangeNotification(map)
    expect(Array.from(note.parentIds!)).toEqual(['p'])
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

  it('tables: NOT emitted on tx commit (no auto-emit; mechanism intact for direct invalidate)', () => {
    // The fast path no longer auto-emits `tables: ['blocks']` — no
    // production query depends on the coarse channel and walking it on
    // every commit was dead weight. Plugins that genuinely need a
    // coarse-table dep can still call `handleStore.invalidate({tables:
    // [...]})` directly; the dep mechanism (handleStore.matchesDep)
    // is unchanged.
    const map = new Map<string, ChangeSnapshot>([
      ['a', {before: null, after: {parentId: null, workspaceId: 'w'}}],
    ])
    const note = snapshotsToChangeNotification(map)
    expect(note.tables).toBeUndefined()
  })

  it('tables: undefined for an empty snapshot map (no spurious table notification)', () => {
    const note = snapshotsToChangeNotification(new Map())
    expect(note.tables).toBeUndefined()
  })

  it('plugin rules can add channel/key invalidations', () => {
    const rule: InvalidationRule = {
      id: 'test.plugin-rule',
      collectFromSnapshots: (snapshots, emit) => {
        for (const id of snapshots.keys()) emit('test.channel', id)
      },
    }
    const map = new Map<string, ChangeSnapshot>([
      ['a', {before: null, after: {parentId: null, workspaceId: 'w'}}],
      ['b', {before: null, after: {parentId: null, workspaceId: 'w'}}],
    ])

    const note = snapshotsToChangeNotification(map, [rule])
    expect(Array.from(note.plugin?.get('test.channel') ?? []).sort()).toEqual(['a', 'b'])
  })

  it('plugin invalidations stay undefined when no rule emits', () => {
    const rule: InvalidationRule = {
      id: 'test.noop-rule',
      collectFromSnapshots: () => {},
    }
    const map = new Map<string, ChangeSnapshot>([
      ['a', {before: null, after: {parentId: null, workspaceId: 'w'}}],
    ])

    const note = snapshotsToChangeNotification(map, [rule])
    expect(note.plugin).toBeUndefined()
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

  it.each([
    ['lean', {id: 'p'}],
    ['hydrating', {id: 'p', hydrate: true}],
  ] as const)('childIds (%s) re-resolves on same-parent order_key move', async (_label, args) => {
    await create('p')
    await create('c1', {parentId: 'p', orderKey: 'a0'})
    await create('c2', {parentId: 'p', orderKey: 'b0'})

    const h = env.repo.query.childIds(args)
    const fired: string[][] = []
    h.subscribe(v => fired.push(v))
    await vi.waitFor(() => expect(fired).toEqual([['c1', 'c2']]))

    await env.repo.mutate.move({
      id: 'c2',
      parentId: 'p',
      position: {kind: 'before', siblingId: 'c1'},
    })
    await vi.waitFor(() => expect(fired).toEqual([
      ['c1', 'c2'],
      ['c2', 'c1'],
    ]))
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

  it('plugin dep: handle re-resolves only on matching channel/key', async () => {
    let value = 0
    const key = 'test:plugin-dep'
    const h = env.repo.handleStore.getOrCreate(key, () =>
      new LoaderHandle<number>({
        store: env.repo.handleStore,
        key,
        loader: async (ctx) => {
          ctx.depend({kind: 'plugin', channel: 'test.channel', key: 'hit'})
          return ++value
        },
      }),
    )
    const fired: number[] = []
    h.subscribe(v => fired.push(v))
    await vi.waitFor(() => expect(fired).toEqual([1]))

    env.repo.handleStore.invalidate({
      plugin: new Map([['test.channel', new Set(['miss'])]]),
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(fired).toEqual([1])

    env.repo.handleStore.invalidate({
      plugin: new Map([['test.channel', new Set(['hit'])]]),
    })
    await vi.waitFor(() => expect(fired).toEqual([1, 2]))
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

  it('table-dep handle does NOT auto-fire on local repo.tx write (no auto-tables emit)', async () => {
    // The fast path no longer auto-emits `tables: ['blocks']` (production
    // queries use narrow plugin channels). A table-only dep stays stale
    // through a tx commit — the mechanism is intact (direct
    // `store.invalidate({tables})` still fires it; see handleStore.test
    // for that path), but transactional commits don't wake it.
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
    // Settle — assert no second fire arrives.
    await Promise.resolve()
    await Promise.resolve()
    expect(fired.length).toBe(1)
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

  it('invalidates childIds on sync-applied same-parent order_key update', async () => {
    await create('p')
    await create('c1', {parentId: 'p', orderKey: 'a0'})
    await create('c2', {parentId: 'p', orderKey: 'b0'})
    const h = env.repo.query.childIds({id: 'p', hydrate: true})
    const fired: string[][] = []
    h.subscribe(v => fired.push(v))
    await vi.waitFor(() => expect(fired).toEqual([['c1', 'c2']]))

    env.repo.startRowEventsTail({initialLastId: 0, throttleMs: 0})
    await env.h.db.execute(
      `UPDATE tx_context SET source = NULL, tx_id = NULL, tx_seq = NULL WHERE id = 1`,
    )
    // Bump updated_at so the sync snapshot wins the LWW gate at the
    // cache layer — real server-applied writes always carry a newer
    // updated_at than what the cache already has.
    await env.h.db.execute(
      `UPDATE blocks SET order_key = '0', updated_at = updated_at + 1 WHERE id = ?`,
      ['c2'],
    )

    await env.repo.flushRowEventsTail()
    await vi.waitFor(() => expect(fired).toEqual([
      ['c1', 'c2'],
      ['c2', 'c1'],
    ]))
  })

  it('does NOT re-resolve children on pure content edits (reviewer P2)', async () => {
    await create('p')
    await create('c1', {parentId: 'p', orderKey: 'a0', content: 'one'})
    const h = env.repo.query.children({id: 'p'})
    await h.load()
    const initial = h.peek()

    env.repo.startRowEventsTail({initialLastId: 0, throttleMs: 0})

    // Sync-applied UPDATE that touches content only — same parent_id,
    // not deleted. Membership of p's children unchanged. Bump
    // updated_at so the snapshot passes the cache LWW gate (real
    // server-applied content edits always carry a newer updated_at).
    await env.h.db.execute(
      `UPDATE tx_context SET source = NULL, tx_id = NULL, tx_seq = NULL WHERE id = 1`,
    )
    await env.h.db.execute(
      `UPDATE blocks SET content = 'remote-edit', updated_at = updated_at + 1 WHERE id = ?`,
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

  it('table-dep handle does NOT auto-fire on sync-applied write (no auto-tables emit)', async () => {
    // Symmetric with the fast-path test: the row_events tail no longer
    // auto-emits `tables: ['blocks']`. A handle with ONLY a coarse
    // `{kind:'table', table:'blocks'}` dep stays stale through a sync
    // commit. The mechanism is still wired (a manual
    // `store.invalidate({tables: [...]})` still works); we just don't
    // burn it on every write since no production query uses it.
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
    await Promise.resolve()
    await Promise.resolve()
    expect(fired.length).toBe(1)
  })

  it('high-watermark: only consumes new rows (id > lastId)', async () => {
    await create('p')
    await create('c1', {parentId: 'p', orderKey: 'a0'}) // local write — id=N

    const tail = env.repo.startRowEventsTail({throttleMs: 0}) // high-watermark = MAX(id)
    // Init runs async — flush awaits ready before reading lastId.
    await env.repo.flushRowEventsTail()
    const afterInit = tail.lastId()

    // No further activity → second flush keeps lastId stable.
    await env.repo.flushRowEventsTail()
    expect(tail.lastId()).toBe(afterInit)
  })

  it('advances the watermark across local row_events without processing them', async () => {
    await create('p')
    const h = env.repo.query.children({id: 'p'})
    const fired: number[] = []
    h.subscribe(v => fired.push(v.length))
    await vi.waitFor(() => expect(fired).toEqual([0]))

    const tail = env.repo.startRowEventsTail({throttleMs: 0})
    await env.repo.flushRowEventsTail()
    const afterInit = tail.lastId()

    await create('c1', {parentId: 'p', orderKey: 'a0'})
    await vi.waitFor(() => expect(fired).toEqual([0, 1]))
    const maxRow = await env.h.db.getOptional<{maxId: number | null}>(
      `SELECT MAX(id) AS maxId FROM row_events`,
    )

    await env.repo.flushRowEventsTail()
    await Promise.resolve()
    await Promise.resolve()

    expect(maxRow?.maxId).toBeGreaterThan(afterInit)
    expect(tail.lastId()).toBe(maxRow?.maxId)
    // The local row was considered for watermark purposes but not
    // processed by the sync invalidation path, so no duplicate fire.
    expect(fired).toEqual([0, 1])
  })

  it('LWW-rejected sync delivery does not invalidate handles', async () => {
    // Scenario: PowerSync upload-window replay. A local write has
    // already advanced the cache (and SQL) for block A. Sync then
    // delivers an older `updated_at` for A — typically the server-side
    // state-at-time-T before the local write was uploaded. The cache's
    // LWW gate rejects it. The SQL row briefly flickers to the older
    // state before PowerSync reconverges, but the cache (and any
    // consumers reading via it) never observed the flicker.
    //
    // The invalidation pipeline must NOT propagate the flicker. If it
    // did, every cache-rejected sync row would wake handles to re-read
    // SQL, which is exactly the freeze pattern observed in QuickFind
    // (`core.searchByContent` getting kicked off mid-load by replay
    // bursts).
    await create('A', {parentId: null, orderKey: 'a0', content: 'local-new'})

    // Track a handle with a per-row dep on A. After the initial load
    // it should only fire again for real changes to A.
    let v = 0
    const handle = env.repo.handleStore.getOrCreate('test:row-dep-A', () =>
      new LoaderHandle<number>({
        store: env.repo.handleStore,
        key: 'test:row-dep-A',
        loader: async (ctx) => {
          ctx.depend({kind: 'row', id: 'A'})
          return ++v
        },
      }),
    )
    const fired: number[] = []
    handle.subscribe((x) => fired.push(x))
    await vi.waitFor(() => expect(fired).toEqual([1]))

    env.repo.startRowEventsTail({initialLastId: 0, throttleMs: 0})
    await env.repo.flushRowEventsTail()

    const invalidationsBefore = env.repo.handleStore.metrics.snapshot().invalidations

    // Sync replays an OLDER `updated_at` than the cache. `updated_at = 1`
    // is well below `Date.now()` used by the local create above, so
    // `applySyncSnapshot` rejects the snapshot via the LWW gate.
    await env.h.db.execute(
      `UPDATE tx_context SET source = NULL, tx_id = NULL, tx_seq = NULL WHERE id = 1`,
    )
    await env.h.db.execute(
      `UPDATE blocks SET content = 'server-stale', updated_at = 1 WHERE id = ?`,
      ['A'],
    )

    await env.repo.flushRowEventsTail()
    await Promise.resolve()
    await Promise.resolve()

    // The row_event has before='local-new', after='server-stale' —
    // without the LWW skip, this would fire kernel.content AND the
    // per-row dep on A. With the skip, neither contributes to the
    // notification, so no handle is woken and the metric is unchanged.
    expect(env.repo.handleStore.metrics.snapshot().invalidations)
      .toBe(invalidationsBefore)
    expect(fired).toEqual([1])
    // Cache retained the local-new state (LWW rejected the stale write).
    expect(env.cache.getSnapshot('A')?.content).toBe('local-new')
  })

})

import type { BlockData } from '@/data/api'
