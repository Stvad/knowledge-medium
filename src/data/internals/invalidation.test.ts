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
 *   2. Layout B sync observer: PowerSync stages every downloaded row into
 *      `blocks_synced`; the observer drains that queue, materializes each
 *      into the app-visible `blocks` table (decrypt/copy), updates the
 *      cache, and walks the same handle invalidation (parent-edge dep on
 *      each sync-applied parent_id assignment). Covers PowerSync's
 *      CRUD-apply path, which bypasses repo.tx.
 *
 * These tests verify each path drives handle re-resolution end-to-end
 * (real Repo, real BlockCache, real DB, real LoaderHandle). Local and sync
 * writes land in PHYSICALLY DIFFERENT tables (`blocks` vs `blocks_synced`),
 * so a local write can't double-fire through the sync path by construction.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { BLOCKS_SYNCED_RAW_TABLE, blockToSyncedRowParams } from '@/data/blockSchema'
import { Repo } from '../repo'
import { resolveFacetRuntimeSync, type AppExtension } from '@/facets/facet.js'
import { kernelDataExtension } from '@/data/kernelDataExtension.js'
import {
  LoaderHandle,
  snapshotsToChangeNotification,
  type ChangeSnapshot,
} from './handleStore'
import type { InvalidationRule } from '@/data/invalidation.js'
import { invalidationRulesFacet } from '@/data/facets.js'

interface Harness { h: TestDb; cache: BlockCache; repo: Repo }

const setup = async (
  opts: {startTail?: boolean; extraExtensions?: readonly AppExtension[]} = {},
): Promise<Harness> => {
  // Shared DB opened once per file (beforeAll), reset per test in setup().
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const cache = new BlockCache()
  const repo = new Repo({
    db: h.db,
    cache,
    user: {id: 'u1'},
    startSyncObserver: opts.startTail ?? false, // off by default for determinism
  })
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    ...(opts.extraExtensions ?? []),
  ]))
  return {h, cache, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
afterEach(() => {
  // Dispose the per-test observer; the shared DB closes once in afterAll.
  if (env) env.repo.stopSyncObserver()
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

  it('field-row flip (referenceTargetId change): adds the parent AND the row itself', () => {
    // Two handles must re-resolve: the PARENT's visible children (the row
    // appears/disappears as a field row) and `children(row)` itself (the row's
    // own children flip between property-subtree interior and visible) — §9.
    const map = new Map<string, ChangeSnapshot>([
      ['c', {
        before: {parentId: 'p', workspaceId: 'w', referenceTargetId: null},
        after: {parentId: 'p', workspaceId: 'w', referenceTargetId: 'def-1'},
      }],
    ])
    const note = snapshotsToChangeNotification(map)
    expect(Array.from(note.parentIds!).sort()).toEqual(['c', 'p'])
  })

  it('move + field-row flip in ONE tx: adds old/new parents AND the row itself', () => {
    // `mergeBlocksInTx` clears a value row's referenceTargetId and relocates
    // it in the same commit, so the collapsed snapshot carries both a
    // parent change and a referenceTargetId change. The self-edge (`children
    // (id)` must re-resolve, §9) has to survive alongside the parent move —
    // the field-flip check is deliberately NOT chained onto the mutually
    // exclusive membership `else if` (which the "Moved" arm would otherwise
    // win, dropping `id`). Removing the standalone `parentIds.add(id)` makes
    // this fail with ['p1','p2'].
    const map = new Map<string, ChangeSnapshot>([
      ['c', {
        before: {parentId: 'p1', workspaceId: 'w', referenceTargetId: 'def-1'},
        after: {parentId: 'p2', workspaceId: 'w', referenceTargetId: null},
      }],
    ])
    const note = snapshotsToChangeNotification(map)
    expect(Array.from(note.parentIds!).sort()).toEqual(['c', 'p1', 'p2'])
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

  it('isolates a throwing rule: kernel deps and sibling rules still contribute (#191)', () => {
    // A plugin rule that throws must not abort the whole pass. In the sync
    // observer this loop runs before the drain's watermark DELETE, so an
    // un-isolated throw would skip both the watermark advance and the handle
    // notification, permanently stranding the UI on a since-equal stamp. The
    // throw is swallowed (logged) so the kernel rowIds and other rules survive.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const throwing: InvalidationRule = {
      id: 'test.throwing-rule',
      collectFromSnapshots: () => { throw new Error('boom') },
    }
    const sibling: InvalidationRule = {
      id: 'test.sibling-rule',
      collectFromSnapshots: (snapshots, emit) => {
        for (const id of snapshots.keys()) emit('sibling.channel', id)
      },
    }
    const map = new Map<string, ChangeSnapshot>([
      ['a', {before: null, after: {parentId: null, workspaceId: 'w'}}],
    ])

    const note = snapshotsToChangeNotification(map, [throwing, sibling])
    // Kernel notification unaffected by the throw.
    expect(Array.from(note.rowIds!)).toEqual(['a'])
    // The sibling rule (registered after the thrower) still ran.
    expect(Array.from(note.plugin?.get('sibling.channel') ?? [])).toEqual(['a'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
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

  it('children and childIds handles re-resolve across child soft-delete and restore', async () => {
    await create('p')
    await create('c', {parentId: 'p', orderKey: 'a0'})
    const children = env.repo.query.children({id: 'p'})
    const childIds = env.repo.query.childIds({id: 'p'})
    const childrenFired: string[][] = []
    const childIdsFired: string[][] = []
    children.subscribe(v => childrenFired.push(v.map(b => b.id)))
    childIds.subscribe(v => childIdsFired.push(v))
    await vi.waitFor(() => expect(childrenFired).toEqual([['c']]))
    await vi.waitFor(() => expect(childIdsFired).toEqual([['c']]))

    await env.repo.tx(tx => tx.delete('c'), {scope: ChangeScope.BlockDefault})
    await vi.waitFor(() => expect(childrenFired).toEqual([['c'], []]))
    await vi.waitFor(() => expect(childIdsFired).toEqual([['c'], []]))
    expect(env.repo.block('c').peek()).toBeNull()
    expect(env.repo.block('c').peekRaw()?.deleted).toBe(true)

    await env.repo.tx(tx => tx.restore('c'), {scope: ChangeScope.BlockDefault})
    await vi.waitFor(() => expect(childrenFired).toEqual([['c'], [], ['c']]))
    await vi.waitFor(() => expect(childIdsFired).toEqual([['c'], [], ['c']]))
    expect(env.repo.block('c').peek()).toMatchObject({id: 'c', deleted: false})
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
// Layout B sync observer (sync-applied invalidation)
// ════════════════════════════════════════════════════════════════════

describe('sync observer: sync-applied invalidation', () => {
  beforeEach(async () => { env = await setup({startTail: false}) })

  // "Newer than any local write": local creates stamp updated_at with the
  // engine's wall clock (~1.7e12), so a sync snapshot needs a value above
  // that to win both LWW gates (materialize + cache).
  const NEWER = 9_000_000_000_000

  /** Simulate a PowerSync sync-apply of a plaintext block: stage the row into
   *  `blocks_synced` (firing the change-capture triggers). `flushSyncObserver()`
   *  then materializes it into `blocks` (copy-through, source=NULL) and walks
   *  invalidation — the Layout B path that replaces PowerSync's CRUD-apply into
   *  `blocks`. It's an UPSERT, so re-staging the same id is an edit. */
  const syncApply = (o: {
    id: string
    parentId?: string | null
    orderKey?: string
    content?: string
    properties?: Record<string, unknown>
    references?: BlockReference[]
    workspaceId?: string
    updatedAt?: number
    deleted?: boolean
  }): Promise<unknown> =>
    env.h.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToSyncedRowParams({
      id: o.id,
      workspaceId: o.workspaceId ?? 'ws-1',
      parentId: o.parentId ?? null,
      orderKey: o.orderKey ?? 'a0',
      content: o.content ?? '',
      properties: o.properties ?? {},
      references: o.references ?? [],
      createdAt: 0,
      updatedAt: o.updatedAt ?? 0,
      userUpdatedAt: o.updatedAt ?? 0,
      createdBy: 'remote',
      updatedBy: 'remote',
      deleted: o.deleted ?? false,
    }))

  /** Simulate the server acking a block's pending local upload — PowerSync
   *  clears `ps_crud` after a successful upload. The materialize gate
   *  (correctly) lets an un-uploaded local edit win over an incoming sync
   *  snapshot, so a test that sync-edits a locally-created block must first
   *  model it as fully synced, or the gate masks the behavior under test. */
  const markUploaded = () => env.h.db.execute('DELETE FROM ps_crud')

  it('sync-applied row → handle re-resolves; cache is updated', async () => {
    await create('p')
    await create('c1', {parentId: 'p', orderKey: 'a0', content: 'one'})
    const h = env.repo.query.children({id: 'p'})
    const fired: BlockData[][] = []
    h.subscribe(v => fired.push(v))
    await vi.waitFor(() => expect(fired.length).toBe(1))

    env.repo.startSyncObserver({throttleMs: 0})
    // A sync-applied insert: a brand-new child of p arrives from the server.
    await syncApply({id: 'c2', parentId: 'p', orderKey: 'a1', content: 'remote'})
    await env.repo.flushSyncObserver()

    await vi.waitFor(() => expect(fired.length).toBe(2))
    expect(fired[1].map(b => b.id)).toEqual(['c1', 'c2'])
    expect(env.cache.getSnapshot('c2')?.content).toBe('remote')
  })

  it('records the incoming change in row_events tagged source=sync (history capture)', async () => {
    // The whole point of restoring row_events under Layout B: an INCOMING sync
    // change must be durably recorded in the local history log. The observer's
    // materialize writes the row into `blocks` with no tx_context open, so the
    // audit trigger COALESCEs source → 'sync' and zeroes tx_id. command_events
    // covers local repo.tx only, so this is the ONLY durable record of the
    // incoming edit.
    await create('p')
    env.repo.startSyncObserver({throttleMs: 0})
    await env.repo.flushSyncObserver() // settle the start-up drain

    await syncApply({id: 'c-remote', parentId: 'p', orderKey: 'a0', content: 'from server', updatedAt: NEWER})
    await env.repo.flushSyncObserver()

    const events = await env.h.db.getAll<{
      kind: string; source: string; tx_id: string | null; before_json: string | null; after_json: string | null
    }>(
      'SELECT kind, source, tx_id, before_json, after_json FROM row_events WHERE block_id = ? ORDER BY id',
      ['c-remote'],
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({kind: 'create', source: 'sync', tx_id: null})
    expect(events[0].before_json).toBeNull()
    expect(events[0].after_json).toContain('"content":"from server"')
  })

  it('local writes do NOT fire the sync path (no double invalidation)', async () => {
    await create('p')
    const h = env.repo.query.children({id: 'p'})
    const fired: number[] = []
    h.subscribe(v => fired.push(v.length))
    await vi.waitFor(() => expect(fired).toEqual([0]))

    env.repo.startSyncObserver({throttleMs: 0})
    await env.repo.flushSyncObserver() // settle the start-up drain (queue empty)

    // A local-write tx writes `blocks`, NOT `blocks_synced`, so it fires the
    // engine fast path exactly once; the observer (which watches only
    // `blocks_synced_changes`) never sees it.
    await create('c1', {parentId: 'p', orderKey: 'a0'})
    await vi.waitFor(() => expect(fired).toEqual([0, 1]))
    // Flush the observer explicitly — a redundant invalidation would show a
    // third fire. None comes: local writes don't touch the staging queue.
    await env.repo.flushSyncObserver()
    await Promise.resolve()
    await Promise.resolve()
    expect(fired).toEqual([0, 1])
  })

  it('invalidates the children handle on sync-applied parent_id assignment', async () => {
    await create('p')
    const h = env.repo.query.children({id: 'p'})
    await h.load()

    env.repo.startSyncObserver({throttleMs: 0})
    await syncApply({id: 'c1-remote', parentId: 'p', orderKey: 'a0'})
    await env.repo.flushSyncObserver()

    // The parent-edge dep on `p` matches the new child's parent_id,
    // so the load-only handle is marked stale. With no subscribers,
    // LoaderHandle defers the SQL rerun until the next load().
    const v = await h.load()
    expect(v.map(b => b.id)).toEqual(['c1-remote'])
  })

  it('invalidates childIds on sync-applied same-parent order_key update', async () => {
    // c1, c2 arrive via sync (downloaded rows, no pending upload) — exactly
    // how a block that can later take a winning server edit got there.
    env.repo.startSyncObserver({throttleMs: 0})
    await syncApply({id: 'c1', parentId: 'p', orderKey: 'a0'})
    await syncApply({id: 'c2', parentId: 'p', orderKey: 'b0'})
    await env.repo.flushSyncObserver()

    const h = env.repo.query.childIds({id: 'p', hydrate: true})
    const fired: string[][] = []
    h.subscribe(v => fired.push(v))
    await vi.waitFor(() => expect(fired).toEqual([['c1', 'c2']]))

    // Server re-orders c2 ahead of c1. NEWER updated_at wins the LWW gate
    // (real server-applied writes always carry a newer updated_at).
    await syncApply({id: 'c2', parentId: 'p', orderKey: '0', updatedAt: NEWER})
    await env.repo.flushSyncObserver()

    await vi.waitFor(() => expect(fired).toEqual([
      ['c1', 'c2'],
      ['c2', 'c1'],
    ]))
  })

  it('marks sync-applied hard-deletes missing and invalidates lean childIds without a cached row', async () => {
    await create('p')
    await create('c', {parentId: 'p', orderKey: 'a0'})
    const h = env.repo.query.childIds({id: 'p'})
    expect(await h.load()).toEqual(['c'])

    // Lean childIds does not need a hydrated row. Drop the tx-populated
    // snapshot to pin the case where membership is cached but BlockCache
    // is not tracking the child row.
    env.cache.deleteSnapshot('c')
    expect(env.repo.block('c').peek()).toBeUndefined()

    env.repo.startSyncObserver({throttleMs: 0})
    await env.repo.flushSyncObserver() // settle the start-up drain (queue empty)

    // Sync-applied hard-delete: the row leaves the staged stream, firing the
    // change-capture DELETE the observer drains — exactly the row the
    // `blocks_synced_changes_delete` trigger emits. The observer reads `before`
    // from `blocks` (the local row still there), removes it, and markMissing-es
    // the id. markMissing counts as accepted on the first missing transition
    // even with no cached snapshot, so the lean childIds parent-edge dep fires.
    await env.h.db.execute(`INSERT INTO blocks_synced_changes (id, op) VALUES (?, 'delete')`, ['c'])
    await env.repo.flushSyncObserver()

    expect(env.repo.block('c').peek()).toBeNull()
    expect(await h.load()).toEqual([])
  })

  it('does NOT re-resolve children on pure content edits (reviewer P2)', async () => {
    // c1 arrives via sync (downloaded row, no pending upload).
    env.repo.startSyncObserver({throttleMs: 0})
    await syncApply({id: 'c1', parentId: 'p', orderKey: 'a0', content: 'one'})
    await env.repo.flushSyncObserver()

    const h = env.repo.query.children({id: 'p'})
    await h.load()
    const initial = h.peek()

    // Sync-applied content-only edit — same parent_id, not deleted, so
    // membership of p's children is unchanged. NEWER updated_at passes the
    // LWW gate (real server-applied content edits carry a newer updated_at).
    await syncApply({id: 'c1', parentId: 'p', orderKey: 'a0', content: 'remote-edit', updatedAt: NEWER})

    await env.repo.flushSyncObserver()
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

    env.repo.startSyncObserver({throttleMs: 0})
    await syncApply({id: 'table-dep-row', parentId: null, orderKey: 'a0'})
    await env.repo.flushSyncObserver()
    await Promise.resolve()
    await Promise.resolve()
    expect(fired.length).toBe(1)
  })

  // (The tail's id-watermark tests are gone: the observer drains-and-deletes
  // its queue rather than advancing a `lastId`, and that durability — no
  // reprocessing across restarts, coalescing re-deliveries — is pinned in
  // observer.test.ts. Local writes never enter the queue, covered above.)

  it('ack-to-echo replay reverts disk transiently but the cache masks it (no flash), then converges with no freeze loop', async () => {
    // QuickFind-freeze / stale-echo canary, post-split. A local write to A is
    // acked (not pending). The server-monotonic DISK gate APPLIES a strictly-
    // newer-local replay (a transient disk revert) and relies on the echo — the
    // server's authoritative row, stamp floored >= local — to re-assert truth.
    // The CACHE write is LWW, so it REJECTS the older replay: the transient
    // stays on disk and never surfaces as a new→old→new UI flash. This pins:
    //   (a) the replay reverts disk transiently while the cache keeps the local
    //       value, and the echo converges disk + cache within the same settle,
    //       and
    //   (b) no repeated handle-wake loop (the freeze signature: cache-rejected
    //       sync rows kicking handles to re-read SQL in a burst).
    await create('A', {parentId: null, orderKey: 'a0', content: 'local-new'})
    await markUploaded() // acked; not pending
    const localStamp = env.cache.getSnapshot('A')!.updatedAt

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

    env.repo.startSyncObserver({throttleMs: 0})
    await env.repo.flushSyncObserver()

    // 1) Stale in-flight replay (older stamp). Disk reverts transiently; the
    // cache LWW rejects it, so the user-visible value never flashes to stale.
    await syncApply({id: 'A', parentId: null, orderKey: 'a0', content: 'server-stale', updatedAt: 1})
    await env.repo.flushSyncObserver()
    await Promise.resolve()
    const diskRow = await env.h.db.getAll<{content: string}>('SELECT content FROM blocks WHERE id = ?', ['A'])
    expect(diskRow[0]?.content).toBe('server-stale') // transient revert on disk
    expect(env.cache.getSnapshot('A')?.content).toBe('local-new') // cache masks it — no flash

    // 2) The echo: server's authoritative row, stamp floored >= local. Converges.
    await syncApply({id: 'A', parentId: null, orderKey: 'a0', content: 'local-new', updatedAt: localStamp + 1})
    await env.repo.flushSyncObserver()
    await Promise.resolve()
    await Promise.resolve()
    expect(env.cache.getSnapshot('A')?.content).toBe('local-new') // converged, not stuck stale

    // (b) No freeze: with no new deliveries, a further drain wakes nothing —
    // the handle is settled, not looping.
    const invalidationsBefore = env.repo.handleStore.metrics.snapshot().invalidations
    const firedBefore = fired.length
    await env.repo.flushSyncObserver()
    await Promise.resolve()
    expect(env.repo.handleStore.metrics.snapshot().invalidations).toBe(invalidationsBefore)
    expect(fired.length).toBe(firedBefore)
  })

  it('a throwing plugin rule does NOT leave a real handle permanently stale (#191 acceptance)', async () => {
    // The issue's literal acceptance criterion, end-to-end with a REAL
    // LoaderHandle + subscriber (not a spy handleStore): a plugin
    // InvalidationRule that throws for an id must still leave that id's handle
    // invalidated. The kernel parent-edge dep is computed independently of the
    // plugin loop, so children(p) re-resolves on the sync-applied child even
    // though the registered rule throws on every pass. Pre-fix, the throw
    // aborted the drain before the watermark DELETE and the notification was
    // lost for good.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const throwingRule: InvalidationRule = {
      id: 'test.always-throws',
      collectFromSnapshots: () => { throw new Error('rule boom') },
    }
    env = await setup({
      startTail: false,
      extraExtensions: [invalidationRulesFacet.of(throwingRule, {source: 'test'})],
    })

    await create('p')
    const h = env.repo.query.children({id: 'p'})
    const fired: string[][] = []
    h.subscribe(v => fired.push(v.map(b => b.id)))
    await vi.waitFor(() => expect(fired).toEqual([[]]))

    env.repo.startSyncObserver({throttleMs: 0})
    await syncApply({id: 'c-remote', parentId: 'p', orderKey: 'a0', content: 'remote'})
    await env.repo.flushSyncObserver()

    // The handle re-resolved despite the throwing rule — not permanently stale.
    await vi.waitFor(() => expect(fired).toEqual([[], ['c-remote']]))
    expect(warn).toHaveBeenCalled() // the rule's failure was logged, not silent
    warn.mockRestore()
  })

})

import type { BlockData, BlockReference } from '@/data/api'
