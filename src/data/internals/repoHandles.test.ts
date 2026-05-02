// @vitest-environment node
/**
 * Tests for Repo's collection-handle factories (Phase 2.B):
 *   `repo.children(id)`, `repo.subtree(id)`, `repo.ancestors(id)`,
 *   `repo.backlinks(id)` — each returning a LoaderHandle<BlockData[]>.
 *
 * Coverage:
 *   - Identity stability per (factory, id).
 *   - Loader correctness: data shape matches the legacy one-shot APIs
 *     (CHILDREN_SQL / SUBTREE_SQL / ANCESTORS_SQL / SELECT_BACKLINKS).
 *   - Side-effects: each loader hydrates its result rows into the
 *     per-row cache via `applySyncSnapshot`.
 *   - Dependencies declared during resolve (verified via the test-only
 *     `__depsForTest` helper on LoaderHandle):
 *       - `children`:  parent-edge on `id` + row on each child.
 *       - `subtree`:   row + parent-edge on every visited id.
 *       - `ancestors`: row on `id` + every ancestor id.
 *       - `backlinks`: row on `id`, workspace, row on each backlink.
 *   - Invalidation through the HandleStore index: the right shape of
 *     change re-resolves the handle. (The TxEngine + row_events tail
 *     wiring is Phase 2.C; here we drive `handleStore.invalidate` by
 *     hand to verify the dep-matching contract.)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from './repo'
import type { Dependency } from './handleStore'

interface Harness { h: TestDb; cache: BlockCache; repo: Repo }

const setup = async (): Promise<Harness> => {
  const h = await createTestDb()
  const cache = new BlockCache()
  const repo = new Repo({db: h.db, cache, user: {id: 'u1'}})
  return {h, cache, repo}
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

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

const depIds = (deps: readonly Dependency[], kind: Dependency['kind']) =>
  deps
    .filter(d => d.kind === kind)
    .map(d => {
      if (d.kind === 'row') return d.id
      if (d.kind === 'parent-edge') return d.parentId
      if (d.kind === 'workspace') return d.workspaceId
      return d.table
    })
    .sort()

describe('repo.children(id)', () => {
  it('identity-stable across calls', () => {
    const a = env.repo.query.children({id: 'p'})
    const b = env.repo.query.children({id: 'p'})
    expect(a).toBe(b)
    // different id → different handle
    expect(env.repo.query.children({id: 'q'})).not.toBe(a)
  })

  it('loader returns children sorted by (orderKey, id)', async () => {
    await create('p')
    await create('c1', {parentId: 'p', orderKey: 'a0'})
    await create('c2', {parentId: 'p', orderKey: 'a1'})
    const h = env.repo.query.children({id: 'p'})
    const result = await h.load()
    expect(result.map(b => b.id)).toEqual(['c1', 'c2'])
  })

  it('declares parent-edge on id + row on each child', async () => {
    await create('p')
    await create('c1', {parentId: 'p', orderKey: 'a0'})
    await create('c2', {parentId: 'p', orderKey: 'a1'})
    const h = env.repo.query.children({id: 'p'})
    await h.load()
    const deps = h.__depsForTest()
    expect(depIds(deps, 'parent-edge')).toEqual(['p'])
    expect(depIds(deps, 'row').sort()).toEqual(['c1', 'c2'])
    // Table dep auto-declared from coarseScope.tables (reviewer P2 fix).
    expect(deps.some(d => d.kind === 'table' && d.table === 'blocks')).toBe(true)
  })

  it('handleStore.invalidate({parentIds:[id]}) re-resolves the handle', async () => {
    await create('p')
    await create('c1', {parentId: 'p', orderKey: 'a0'})
    const h = env.repo.query.children({id: 'p'})
    const fired: number[] = []
    h.subscribe(v => fired.push(v.length))
    await vi.waitFor(() => expect(fired).toEqual([1]))

    // Add another child via tx (cache populated through commit walk),
    // then drive invalidation explicitly — this isolates the
    // dep-matching contract from the (Phase 2.C) wiring.
    await create('c2', {parentId: 'p', orderKey: 'a1'})
    env.repo.handleStore.invalidate({parentIds: ['p']})
    await vi.waitFor(() => expect(fired).toEqual([1, 2]))
  })
})

describe('repo.subtree(id)', () => {
  it('identity-stable across calls', () => {
    const a = env.repo.query.subtree({id: 'r'})
    const b = env.repo.query.subtree({id: 'r'})
    expect(a).toBe(b)
  })

  it('returns root + descendants', async () => {
    await create('r')
    await create('a', {parentId: 'r', orderKey: 'a0'})
    await create('b', {parentId: 'a', orderKey: 'b0'})
    const h = env.repo.query.subtree({id: 'r'})
    const out = await h.load()
    const ids = out.map(b => b.id).sort()
    expect(ids).toEqual(['a', 'b', 'r'])
  })

  it('declares row + parent-edge on every visited id (and upfront on root)', async () => {
    await create('r')
    await create('a', {parentId: 'r', orderKey: 'a0'})
    const h = env.repo.query.subtree({id: 'r'})
    await h.load()
    const deps = h.__depsForTest()
    // Subtree declares root deps upfront BEFORE the SQL (so empty-result
    // and mid-load cases still match) AND per-row during the walk.
    // The duplicate `row:r` is intentional — assert against the unique set.
    expect(new Set(depIds(deps, 'row'))).toEqual(new Set(['a', 'r']))
    expect(new Set(depIds(deps, 'parent-edge'))).toEqual(new Set(['a', 'r']))
  })

  it('declares root deps even when the subtree is empty (root not yet created)', async () => {
    const h = env.repo.query.subtree({id: 'not-yet'})
    await h.load()
    const deps = h.__depsForTest()
    expect(depIds(deps, 'row')).toEqual(['not-yet'])
    expect(depIds(deps, 'parent-edge')).toEqual(['not-yet'])
  })
})

describe('repo.ancestors(id)', () => {
  it('identity-stable across calls', () => {
    const a = env.repo.query.ancestors({id: 'x'})
    const b = env.repo.query.ancestors({id: 'x'})
    expect(a).toBe(b)
  })

  it('returns chain leaf-to-root, excludes id itself', async () => {
    await create('r')
    await create('a', {parentId: 'r', orderKey: 'a0'})
    await create('b', {parentId: 'a', orderKey: 'b0'})
    const h = env.repo.query.ancestors({id: 'b'})
    const out = await h.load()
    expect(out.map(x => x.id)).toEqual(['a', 'r'])
  })

  it('declares row deps on id + every ancestor', async () => {
    await create('r')
    await create('a', {parentId: 'r', orderKey: 'a0'})
    await create('b', {parentId: 'a', orderKey: 'b0'})
    const h = env.repo.query.ancestors({id: 'b'})
    await h.load()
    const deps = h.__depsForTest()
    expect(depIds(deps, 'row').sort()).toEqual(['a', 'b', 'r'])
    expect(depIds(deps, 'parent-edge')).toEqual([])
  })
})

describe('repo.query.backlinks({workspaceId, id})', () => {
  it('identity-stable across calls', () => {
    const a = env.repo.query.backlinks({workspaceId: 'ws-1', id: 't'})
    const b = env.repo.query.backlinks({workspaceId: 'ws-1', id: 't'})
    expect(a).toBe(b)
  })

  it('returns blocks whose references include id', async () => {
    await create('t', {workspaceId: 'ws-1'})
    // Create a block that references `t`. tx.update doesn't take
    // references; we patch via direct SQL after the row exists.
    await create('linker', {workspaceId: 'ws-1', content: 'see t'})
    await env.h.db.execute(
      `UPDATE blocks SET references_json = ? WHERE id = ?`,
      [JSON.stringify([{id: 't', alias: 't'}]), 'linker'],
    )
    const h = env.repo.query.backlinks({workspaceId: 'ws-1', id: 't'})
    const out = await h.load()
    expect(out.map(b => b.id)).toEqual(['linker'])
  })

  it('returns [] when no block references id', async () => {
    const h = env.repo.query.backlinks({workspaceId: 'ws-1', id: 'nope'})
    const out = await h.load()
    expect(out).toEqual([])
  })

  it('declares row(id) + workspace dep + table dep + row deps on each backlink', async () => {
    await create('t', {workspaceId: 'ws-1'})
    await create('linker', {workspaceId: 'ws-1'})
    await env.h.db.execute(
      `UPDATE blocks SET references_json = ? WHERE id = ?`,
      [JSON.stringify([{id: 't', alias: 't'}]), 'linker'],
    )
    // Drain the row_events tail BEFORE creating the handle. Otherwise
    // the tail's throttled flush of the direct UPDATE above can race
    // with the handle's first load: when invalidate({rowIds:['linker']})
    // arrives between the load resolving and the test reading deps,
    // runLoader's post-settle microtask kicks off a re-resolve whose
    // synchronous prefix pushes upfront ctx.depend calls onto
    // this.deps before the test's await-continuation runs — making
    // __depsForTest() return mid-resolve state with duplicate rows.
    await env.repo.flushRowEventsTail()
    const h = env.repo.query.backlinks({workspaceId: 'ws-1', id: 't'})
    await h.load()
    const deps = h.__depsForTest()
    expect(depIds(deps, 'row').sort()).toEqual(['linker', 't'])
    expect(depIds(deps, 'workspace')).toEqual(['ws-1'])
    // Table dep auto-declared from coarseScope.tables (reviewer P2 fix).
    expect(deps.some(d => d.kind === 'table' && d.table === 'blocks')).toBe(true)
  })
})

describe('Acceptance §13.2: status() distinguishes loading vs not-found', () => {
  it('Block.status returns ready+null after load on a missing row', async () => {
    const b = env.repo.block('nope')
    expect(b.status()).toBe('idle')
    const p = b.load()
    expect(b.status()).toBe('loading')
    const v = await p
    expect(v).toBeNull()
    expect(b.status()).toBe('ready')
    expect(b.peek()).toBeNull()
  })
})
