// @vitest-environment node
/**
 * Phase 4 chunk B — kernel queries as `queriesFacet` contributions.
 *
 * Covers each query's SQL behavior by dispatching through the new
 * `repo.query.X(args).load()` surface (no comparison to the legacy
 * `repo.findX` methods — those go away in chunk C). Plus invalidation
 * tests pinning each declared `Dependency` kind, plus a plugin-query
 * end-to-end test asserting the registration → dispatch → invalidation
 * loop works for non-kernel contributions.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import {
  ChangeScope,
  defineQuery,
  type BlockData,
  type BlockReference,
} from '@/data/api'
import { aliasesProp, seedKeyProp, typesProp } from '@/data/properties'
import { stateChildBlockId } from '@/data/derivedIds'
import { UI_STATE_PATH_PART, USER_PREFS_PATH_PART } from '@/data/userPrefs'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { kernelDataExtension } from '../kernelDataExtension'
import { queriesFacet } from '../facets'
import { Repo } from '../repo'
import { SELECT_BLOCKS_BY_CONTENT_SQL, compileBlocksContentSearchQuery, type RecentActivityEntry } from './kernelQueries'

const WS = 'ws-1'
const OTHER_WS = 'ws-2'

interface Harness {
  h: TestDb
  cache: BlockCache
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  // Shared DB opened once per file, reset between tests; fresh Repo per test.
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  // Keep the processor registry empty; these query tests seed
  // `references` directly and should not depend on plugin processors.
  const {repo, cache} = createTestRepo({
    db: h.db,
    user: {id: 'user-1'},
  })
  return {h, cache, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })

const create = async (args: {
  id: string
  parentId?: string | null
  orderKey?: string
  content?: string
  workspaceId?: string
  aliases?: string[]
  type?: string
  types?: string[]
  references?: BlockReference[]
}) => {
  const properties: Record<string, unknown> = {}
  if (args.aliases) properties[aliasesProp.name] = aliasesProp.codec.encode(args.aliases)
  const types = args.types ?? (args.type ? [args.type] : null)
  if (types) properties[typesProp.name] = typesProp.codec.encode(types)
  await env.repo.tx(async tx => {
    await tx.create({
      id: args.id,
      workspaceId: args.workspaceId ?? WS,
      parentId: args.parentId ?? null,
      orderKey: args.orderKey ?? 'a0',
      content: args.content ?? '',
      properties,
      references: args.references ?? [],
    })
  }, {scope: ChangeScope.BlockDefault})
}

// Result types are precise after the reviewer fix — kernel queries
// declare `BlockData[]` / `BlockData | null` directly via typed
// pass-through schemas (see kernelQueries.ts). These helpers
// previously narrowed `unknown`; kept as no-op identities to keep
// the `await ... .load()` call sites stable while we verify behavior.
const asBlocks = (v: BlockData[] | undefined): BlockData[] => v ?? []
/** `recentActivity` returns each row with its chain; most assertions
 *  here are about WHICH rows come back. */
const activityBlocks = (v: RecentActivityEntry[] | undefined): BlockData[] =>
  (v ?? []).map(entry => entry.block)
const asIds = (v: string[] | undefined): string[] => v ?? []
const asBlockOrNull = (v: BlockData | null | undefined): BlockData | null => v ?? null

/**
 * Sound "did NOT invalidate" probe. `repo.tx` fans out to the handle store
 * synchronously (repo.ts post-commit walk), and `loaderInvalidations` counts
 * `LoaderHandle.invalidate()` calls BEFORE the loader's structural-diff dedup
 * and mid-load coalescing. So a zero delta across a write proves it matched no
 * handle. `fired.length` can't prove that: an erroneous invalidation that
 * re-resolves to an equal value (or coalesces with a later control write) is
 * deduped and never reaches a subscriber. The synchronous count is complete the
 * moment `tx` resolves because these tests issue only local `repo.tx` writes to
 * `blocks`: the only registered post-commit processor is the kernel's
 * `core.aliasClaimRederive` (no plugin processors here), whose apply never
 * writes blocks — it only enqueues name-rederives, which no-op before the
 * reference-target sweep exists — AND the default sync observer only reacts to
 * `blocks_synced` writes, so nothing re-invalidates a tick later.
 */
const invalidations = () => env.repo.handleStore.metrics.loaderInvalidations

// ════════════════════════════════════════════════════════════════════
// Per-query SQL-behavior coverage
// ════════════════════════════════════════════════════════════════════

describe('compileBlocksContentSearchQuery', () => {
  it('compiles plain words into required literal trigram terms', () => {
    expect(compileBlocksContentSearchQuery('sync foo')?.matchQuery).toBe('"sync" "foo"')
  })

  it('preserves user-quoted phrases as contiguous substring matches', () => {
    expect(compileBlocksContentSearchQuery('"sync foo"')).toEqual({
      matchQuery: '"sync foo"',
      rankQuery: 'sync foo',
    })
  })

  it('supports explicit OR and exclusion operators without exposing raw FTS syntax', () => {
    expect(compileBlocksContentSearchQuery('sync OR merge -lww')?.matchQuery).toBe('("sync" OR "merge") NOT "lww"')
    expect(compileBlocksContentSearchQuery('sync NOT lww')?.matchQuery).toBe('"sync" NOT "lww"')
    expect(compileBlocksContentSearchQuery('-lww sync')?.matchQuery).toBe('"sync" NOT "lww"')
  })

  it('treats leading hyphen terms as literal when there are no positives', () => {
    expect(compileBlocksContentSearchQuery('-foo')?.matchQuery).toBe('"-foo"')
    expect(compileBlocksContentSearchQuery('-foo -bar')?.matchQuery).toBe('"-foo" "-bar"')
  })

  it('falls short hyphen terms back to whole-query phrases instead of LIKE post-filters', () => {
    expect(compileBlocksContentSearchQuery('react -')?.matchQuery).toBe('"react -"')
    expect(compileBlocksContentSearchQuery('react -1')?.matchQuery).toBe('"react -1"')
  })

  it('treats operator words and punctuation as literal text when they are not valid operators', () => {
    expect(compileBlocksContentSearchQuery('AND')?.matchQuery).toBe('"AND"')
    expect(compileBlocksContentSearchQuery('2024-01')?.matchQuery).toBe('"2024-01"')
    expect(compileBlocksContentSearchQuery('quote " token')?.matchQuery).toBe('"quote" "token"')
  })

  it('returns null below the trigram searchable length', () => {
    expect(compileBlocksContentSearchQuery('fo')).toBeNull()
  })

  it('does not generate LIKE post-filters on top of MATCH', () => {
    expect(SELECT_BLOCKS_BY_CONTENT_SQL).not.toContain("LIKE '%' || LOWER(?) || '%'")
  })
})

describe('repo.query.subtree', () => {
  it('returns root + descendants in path order', async () => {
    await create({id: 'r'})
    await create({id: 'c1', parentId: 'r', orderKey: 'a0'})
    await create({id: 'c2', parentId: 'r', orderKey: 'a1'})
    await create({id: 'gc', parentId: 'c1', orderKey: 'a0'})
    const out = asBlocks(await env.repo.query.subtree({id: 'r'}).load())
    expect(out.map(b => b.id)).toEqual(['r', 'c1', 'gc', 'c2'])
  })

  it('carries each row depth relative to the root, dropping back across branches', async () => {
    await create({id: 'r'})
    await create({id: 'c1', parentId: 'r', orderKey: 'a0'})
    await create({id: 'gc', parentId: 'c1', orderKey: 'a0'})
    await create({id: 'c2', parentId: 'r', orderKey: 'a1'})
    // Pre-order is [r, c1, gc, c2]; depth must drop from 2 (gc) back to 1
    // (c2) — the shape where an out[i]↔rows[i] off-by-one would surface.
    const out = await env.repo.query.subtree({id: 'r'}).load()
    expect(out.map(b => [b.id, b.depth])).toEqual([['r', 0], ['c1', 1], ['gc', 2], ['c2', 1]])
  })

  it('excludes soft-deleted descendants', async () => {
    await create({id: 'r'})
    await create({id: 'c1', parentId: 'r'})
    await env.repo.tx(tx => tx.delete('c1'), {scope: ChangeScope.BlockDefault})
    const out = asBlocks(await env.repo.query.subtree({id: 'r'}).load())
    expect(out.map(b => b.id)).toEqual(['r'])
  })

  it('returns empty array when root missing', async () => {
    expect(asBlocks(await env.repo.query.subtree({id: 'no-such'}).load())).toEqual([])
  })
})

describe('repo.query.ancestors', () => {
  it('returns leaf-to-root chain excluding the start id', async () => {
    await create({id: 'r'})
    await create({id: 'c', parentId: 'r'})
    await create({id: 'gc', parentId: 'c'})
    const out = asBlocks(await env.repo.query.ancestors({id: 'gc'}).load())
    expect(out.map(b => b.id)).toEqual(['c', 'r'])
  })

  it('returns [] when id has no parent', async () => {
    await create({id: 'r'})
    const out = asBlocks(await env.repo.query.ancestors({id: 'r'}).load())
    expect(out).toEqual([])
  })
})

describe('repo.query.manyAncestors', () => {
  it('returns one entry per input id with each chain in leaf-to-root order', async () => {
    await create({id: 'r'})
    await create({id: 'c1', parentId: 'r'})
    await create({id: 'c2', parentId: 'r'})
    await create({id: 'gc', parentId: 'c1'})
    const out = await env.repo.query.manyAncestors({ids: ['gc', 'c2', 'r']}).load()
    expect(out).toHaveLength(3)
    const byStart = new Map(out.map(e => [e.startId, e.ancestors.map(a => a.id)]))
    // Each chain matches the single-id `core.ancestors` shape exactly.
    expect(byStart.get('gc')).toEqual(['c1', 'r'])
    expect(byStart.get('c2')).toEqual(['r'])
    expect(byStart.get('r')).toEqual([])
  })

  it('returns empty entries for missing or soft-deleted ids', async () => {
    await create({id: 'r'})
    await create({id: 'c', parentId: 'r'})
    await env.repo.tx(tx => tx.delete('c'), {scope: ChangeScope.BlockDefault})
    const out = await env.repo.query.manyAncestors({ids: ['c', 'no-such']}).load()
    expect(out).toHaveLength(2)
    expect(out.find(e => e.startId === 'c')!.ancestors).toEqual([])
    expect(out.find(e => e.startId === 'no-such')!.ancestors).toEqual([])
  })

  it('returns [] when the input list is empty', async () => {
    expect(await env.repo.query.manyAncestors({ids: []}).load()).toEqual([])
  })
})

describe('repo.query.children', () => {
  it('returns immediate children sorted by (orderKey, id)', async () => {
    await create({id: 'p'})
    await create({id: 'c2', parentId: 'p', orderKey: 'b0'})
    await create({id: 'c1', parentId: 'p', orderKey: 'a0'})
    const out = asBlocks(await env.repo.query.children({id: 'p'}).load())
    expect(out.map(b => b.id)).toEqual(['c1', 'c2'])
  })

  it('returns [] for a leaf', async () => {
    await create({id: 'p'})
    expect(asBlocks(await env.repo.query.children({id: 'p'}).load())).toEqual([])
  })

  it('excludes soft-deleted children', async () => {
    await create({id: 'p'})
    await create({id: 'c1', parentId: 'p', orderKey: 'a0'})
    await create({id: 'c2', parentId: 'p', orderKey: 'a1'})
    await env.repo.tx(tx => tx.delete('c1'), {scope: ChangeScope.BlockDefault})
    const out = asBlocks(await env.repo.query.children({id: 'p'}).load())
    expect(out.map(b => b.id)).toEqual(['c2'])
  })
})

describe('repo.query.childIds', () => {
  it('returns ids in (orderKey, id) order — lean variant', async () => {
    await create({id: 'p'})
    await create({id: 'c2', parentId: 'p', orderKey: 'b0'})
    await create({id: 'c1', parentId: 'p', orderKey: 'a0'})
    const out = await env.repo.query.childIds({id: 'p'}).load()
    expect(out).toEqual(['c1', 'c2'])
  })

  it('hydrate=true also primes the cache (hot path for React lists)', async () => {
    await create({id: 'p'})
    await create({id: 'c1', parentId: 'p', orderKey: 'a0', content: 'hello'})
    env.cache.deleteSnapshot('c1')
    const handle = env.repo.query.childIds({id: 'p', hydrate: true})
    await handle.load()
    expect(env.cache.getSnapshot('c1')?.content).toBe('hello')
    expect(handle.__depsForTest()).toEqual([{kind: 'parent-edge', parentId: 'p'}])
  })

  it('hydrate=false leaves cache cold for unrelated rows', async () => {
    await create({id: 'p'})
    await create({id: 'c1', parentId: 'p', content: 'hello'})
    env.cache.deleteSnapshot('c1')
    await env.repo.query.childIds({id: 'p'}).load()
    // Lean variant runs CHILDREN_IDS_SQL which selects only id —
    // the row body never enters the cache via this path.
    expect(env.cache.getSnapshot('c1')).toBeUndefined()
  })

  it('hydrate=true and hydrate=false get separate handle slots', () => {
    // Different args → different handle-store keys → distinct identities.
    const a = env.repo.query.childIds({id: 'p'})
    const b = env.repo.query.childIds({id: 'p', hydrate: true})
    expect(a).not.toBe(b)
  })
})

describe('repo.query.byType', () => {
  it('returns blocks whose types membership matches', async () => {
    await create({id: 'a', type: 'note'})
    await create({id: 'b', type: 'note'})
    await create({id: 'c', type: 'task'})
    const out = asBlocks(await env.repo.query.byType({workspaceId: WS, type: 'note'}).load())
    expect(out.map(r => r.id).sort()).toEqual(['a', 'b'])
  })

  it('returns [] when nothing matches', async () => {
    await create({id: 'a', type: 'note'})
    expect(asBlocks(await env.repo.query.byType({workspaceId: WS, type: 'missing'}).load())).toEqual([])
  })

  it('excludes tombstoned blocks', async () => {
    await create({id: 'a', type: 'note'})
    await create({id: 'b', type: 'note'})
    await env.repo.tx(tx => tx.delete('a'), {scope: ChangeScope.BlockDefault})
    const out = asBlocks(await env.repo.query.byType({workspaceId: WS, type: 'note'}).load())
    expect(out.map(r => r.id)).toEqual(['b'])
  })

  it('scopes to workspaceId', async () => {
    await create({id: 'a', type: 'note'})
    await create({id: 'b', type: 'note', workspaceId: OTHER_WS})
    expect(asBlocks(await env.repo.query.byType({workspaceId: WS, type: 'note'}).load()).map(r => r.id)).toEqual(['a'])
    expect(asBlocks(await env.repo.query.byType({workspaceId: OTHER_WS, type: 'note'}).load()).map(r => r.id)).toEqual(['b'])
  })
})

describe('repo.query.typedBlockCount', () => {
  // The count projection must aggregate the SAME candidate set as the id
  // projection — proven here on the non-referencedBy (types) path; the
  // backlinks path is covered in plugins/backlinks/inline-counts.
  it('does not multiply a block carrying several of the requested types', async () => {
    // The `block_types` filter is a JOIN, so a block tagged with two of the
    // requested types produces two candidate rows; only `SELECT DISTINCT b.id`
    // in the CTE collapses them. `ids` would show it as a duplicate, `count`
    // as a phantom extra. Sibling of the ancestor_chain non-multiplication
    // case below.
    await create({id: 'both', types: ['note', 'task']})
    await create({id: 'one', type: 'task'})
    // Untyped, so the join's INNER-ness is pinned here too: LEFT would keep
    // this row (the ON clause fails, the row survives with NULL bt columns).
    await create({id: 'untyped'})

    const ids = await env.repo.query.typedBlockIds({workspaceId: WS, types: ['note', 'task']}).load()
    const n = await env.repo.query.typedBlockCount({workspaceId: WS, types: ['note', 'task']}).load()

    expect([...ids].sort()).toEqual(['both', 'one'])
    expect(n).toBe(2)
  })

  it('equals typedBlockIds length, excluding tombstoned rows', async () => {
    await create({id: 'a', type: 'note'})
    await create({id: 'b', type: 'note'})
    await create({id: 'c', type: 'task'})
    await env.repo.tx(tx => tx.delete('b'), {scope: ChangeScope.BlockDefault})

    const ids = await env.repo.query.typedBlockIds({workspaceId: WS, types: ['note']}).load()
    const n = await env.repo.query.typedBlockCount({workspaceId: WS, types: ['note']}).load()
    expect(n).toBe(ids.length)
    expect(n).toBe(1)
  })

  it('scopes to workspaceId', async () => {
    await create({id: 'a', type: 'note'})
    await create({id: 'b', type: 'note', workspaceId: OTHER_WS})
    expect(await env.repo.query.typedBlockCount({workspaceId: WS, types: ['note']}).load()).toBe(1)
    expect(await env.repo.query.typedBlockCount({workspaceId: OTHER_WS, types: ['note']}).load()).toBe(1)
  })

  it('returns 0 for an empty workspaceId', async () => {
    expect(await env.repo.query.typedBlockCount({workspaceId: '', types: ['note']}).load()).toBe(0)
  })

  it('matches typedBlockIds length on the ancestor-scope path (COUNT must not multiply per ancestor_chain row)', async () => {
    // `child` has TWO ancestors (`parent` and `gp`) that each reference `tag`,
    // so the ancestor predicate matches the one candidate via two distinct
    // ancestor_chain rows. A COUNT(*) over a multiplying ancestor JOIN would
    // return 2; the correct EXISTS-in-WHERE count is 1. A single-ancestor
    // fixture can't tell those apart — it returns 1 either way.
    await create({id: 'target'})
    await create({id: 'tag'})
    await create({id: 'gp', references: [{id: 'tag', alias: 'Tag'}]})
    await create({id: 'parent', parentId: 'gp', references: [{id: 'tag', alias: 'Tag'}]})
    await create({id: 'child', parentId: 'parent', references: [{id: 'target', alias: 'T'}]})
    await create({id: 'sibling', references: [{id: 'target', alias: 'T'}]})

    const query = {
      workspaceId: WS,
      referencedBy: {id: 'target'},
      match: [{scope: 'ancestor' as const, referencedBy: {id: 'tag'}}],
    }
    const ids = await env.repo.query.typedBlockIds(query).load()
    const n = await env.repo.query.typedBlockCount(query).load()
    expect(ids).toEqual(['child']) // one candidate, even with two matching ancestors
    expect(n).toBe(ids.length) // 1, not 2 — no per-ancestor multiplication
  })
})

describe('repo.query.searchByContent', () => {
  it('matches case-insensitive substring', async () => {
    await create({id: 'a', content: 'Hello World'})
    await create({id: 'b', content: 'goodbye'})
    const out = asBlocks(await env.repo.query.searchByContent({workspaceId: WS, query: 'hello'}).load())
    expect(out.map(r => r.id)).toEqual(['a'])
  })

  it('matches all unquoted terms anywhere in the content', async () => {
    await create({id: 'exact', content: 'sync foo'})
    await create({id: 'reverse', content: 'foo sync'})
    await create({id: 'joined', content: 'syncxxfoo'})
    await create({id: 'partial', content: 'sync only'})

    const out = asBlocks(await env.repo.query.searchByContent({workspaceId: WS, query: 'sync foo'}).load())

    expect(out.map(r => r.id)).toEqual(['exact', 'joined', 'reverse'])
  })

  it('treats user-quoted input as a contiguous phrase', async () => {
    await create({id: 'phrase', content: 'sync foo'})
    await create({id: 'reverse', content: 'foo sync'})
    await create({id: 'joined', content: 'syncxxfoo'})

    const out = asBlocks(await env.repo.query.searchByContent({workspaceId: WS, query: '"sync foo"'}).load())

    expect(out.map(r => r.id)).toEqual(['phrase'])
  })

  it('supports OR and exclusion operators', async () => {
    await create({id: 'sync', content: 'sync clean'})
    await create({id: 'sync-lww', content: 'sync lww'})
    await create({id: 'merge', content: 'merge clean'})
    await create({id: 'other', content: 'unrelated'})

    const out = asBlocks(await env.repo.query.searchByContent({workspaceId: WS, query: 'sync OR merge -lww'}).load())

    expect(out.map(r => r.id).sort()).toEqual(['merge', 'sync'])
  })

  it('supports exclusions before positive terms', async () => {
    await create({id: 'keep', content: 'react hooks'})
    await create({id: 'drop', content: 'react classes'})

    const out = asBlocks(await env.repo.query.searchByContent({workspaceId: WS, query: '-classes react'}).load())

    expect(out.map(r => r.id)).toEqual(['keep'])
  })

  it('uses a whole-query phrase for short hyphen terms instead of broadening to the FTS term', async () => {
    await create({id: 'literal', content: 'react -1'})
    await create({id: 'without-hyphen', content: 'react 1'})
    await create({id: 'without-number', content: 'react notes'})

    const out = asBlocks(await env.repo.query.searchByContent({workspaceId: WS, query: 'react -1'}).load())

    expect(out.map(r => r.id)).toEqual(['literal'])
  })

  it('keeps a trailing hyphen literal without scanning MATCH results via LIKE', async () => {
    await create({id: 'literal', content: 'sync -'})
    await create({id: 'plain', content: 'sync'})

    const out = asBlocks(await env.repo.query.searchByContent({workspaceId: WS, query: 'sync -'}).load())

    expect(out.map(r => r.id)).toEqual(['literal'])
  })

  it('treats FTS operator words and punctuation as literal user text', async () => {
    await create({id: 'and', content: 'literal AND token'})
    await create({id: 'date', content: '2024-01 report'})
    await create({id: 'quote', content: 'quote " token'})

    await expect(env.repo.query.searchByContent({workspaceId: WS, query: 'AND'}).load()).resolves.toBeDefined()
    expect(asBlocks(await env.repo.query.searchByContent({workspaceId: WS, query: 'AND'}).load()).map(r => r.id)).toEqual(['and'])
    expect(asBlocks(await env.repo.query.searchByContent({workspaceId: WS, query: '2024-01'}).load()).map(r => r.id)).toEqual(['date'])
    expect(asBlocks(await env.repo.query.searchByContent({workspaceId: WS, query: 'quote " token'}).load()).map(r => r.id)).toEqual(['quote'])
  })

  it('respects the limit argument', async () => {
    await create({id: 'a', content: 'foo 1'})
    await create({id: 'b', content: 'foo 2'})
    await create({id: 'c', content: 'foo 3'})
    const out = asBlocks(await env.repo.query.searchByContent({workspaceId: WS, query: 'foo', limit: 2}).load())
    expect(out).toHaveLength(2)
  })

  it('orders exact matches before prefix and substring matches', async () => {
    await create({id: 'exact', content: 'Dating'})
    await create({id: 'prefix', content: 'Dating notes'})
    await create({id: 'contains', content: 'My Dating notes'})

    const out = asBlocks(await env.repo.query.searchByContent({workspaceId: WS, query: 'dating'}).load())

    expect(out.map(r => r.id)).toEqual(['exact', 'prefix', 'contains'])
  })

  it('returns [] on empty query', async () => {
    await create({id: 'a', content: 'hi'})
    expect(asBlocks(await env.repo.query.searchByContent({workspaceId: WS, query: ''}).load())).toEqual([])
  })

  it('returns [] for queries below the trigram searchable length', async () => {
    await create({id: 'a', content: 'foo'})
    expect(asBlocks(await env.repo.query.searchByContent({workspaceId: WS, query: 'fo'}).load())).toEqual([])
  })

  it('excludes empty-content + tombstoned rows', async () => {
    await create({id: 'a', content: 'foo'})
    await create({id: 'b', content: ''})
    await create({id: 'c', content: 'foo'})
    await env.repo.tx(tx => tx.delete('c'), {scope: ChangeScope.BlockDefault})
    const out = asBlocks(await env.repo.query.searchByContent({workspaceId: WS, query: 'foo'}).load())
    expect(out.map(r => r.id)).toEqual(['a'])
  })
})

describe('repo.query.recentBlocks', () => {
  it('returns recent non-empty blocks in a workspace', async () => {
    await create({id: 'old', content: 'old block'})
    await create({id: 'empty', content: ''})
    await create({id: 'other', content: 'other workspace', workspaceId: OTHER_WS})
    await create({id: 'new', content: 'new block'})

    const out = asBlocks(await env.repo.query.recentBlocks({workspaceId: WS, limit: 5}).load())

    expect(out.map(r => r.id)).toEqual(['new', 'old'])
  })

  it('respects the limit argument', async () => {
    await create({id: 'a', content: 'a'})
    await create({id: 'b', content: 'b'})
    await create({id: 'c', content: 'c'})

    const out = asBlocks(await env.repo.query.recentBlocks({workspaceId: WS, limit: 2}).load())

    expect(out.map(r => r.id)).toEqual(['c', 'b'])
  })

})

describe('repo.query.recentActivity', () => {
    // Real derived ids: the filter walks down from
    // `stateChildBlockId(userPage, <root>)`, so a test that invented
    // plain ids for the roots would exercise nothing.
    const UI_STATE_ID = stateChildBlockId('user-page', UI_STATE_PATH_PART)
    const PREFS_ID = stateChildBlockId('user-page', USER_PREFS_PATH_PART)

    // The per-user state subtree, as `stateBlocks.ts` builds it:
    // user page → ui-state → per-plugin state → records.
    const seedUserState = async () => {
      await create({id: 'user-page', content: 'Alice', types: ['page', 'user']})
      await create({id: UI_STATE_ID, parentId: 'user-page', content: 'ui-state'})
      await create({id: 'plugin-state', parentId: UI_STATE_ID, content: 'Startup metrics'})
      await create({id: 'metrics-record', parentId: 'plugin-state', content: '2026-08-17T00:00:00Z'})
      await create({id: PREFS_ID, parentId: 'user-page', content: 'Preferences'})
      await create({id: 'plugin-prefs', parentId: PREFS_ID, content: 'Daily notes'})
    }

    // The two queries share one resolver so "authored" cannot mean different
    // things in the picker and the feed. Asserted against a seeded state
    // subtree, so it is the real exclusion being compared and not two empty
    // lists agreeing.
    // A parent change is what moves a row across this exclusion, and it touches
    // no content — so without a structural dep a LOADED handle keeps offering a
    // row that has since become app-owned, in a picker, as something to link
    // to. Asserted through a live handle rather than a fresh call, because a
    // fresh call re-runs the SQL and would pass with no dep declared at all.
    it('drops a row reparented into the state tree without reloading', async () => {
      await create({id: 'note', content: 'a real note'})
      await seedUserState()
      const handle = env.repo.query.recentUserBlocks({workspaceId: WS, limit: 50})
      expect((await handle.load()).map(b => b.id)).toContain('note')

      await env.repo.tx(
        tx => tx.move('note', {parentId: 'plugin-state', orderKey: 'a0'}),
        {scope: ChangeScope.BlockDefault},
      )

      await vi.waitFor(async () => {
        expect((await handle.load()).map(b => b.id)).not.toContain('note')
      })
    })

    it('agrees with the chainless query on which blocks are authored', async () => {
      await create({id: 'note', content: 'a real note'})
      await create({id: 'note-2', parentId: 'note', content: 'a nested note'})
      await seedUserState()

      const withChains = activityBlocks(await env.repo.query.recentActivity({
        workspaceId: WS, limit: 50,
      }).load())
      const chainless = await env.repo.query.recentUserBlocks({
        workspaceId: WS, limit: 50,
      }).load()

      expect(chainless.map(b => b.id)).toEqual(withChains.map(b => b.id))
      // Precondition: the state subtree really was excluded, so this is not
      // two unfiltered lists matching.
      expect(chainless.map(b => b.id)).toEqual(['note-2', 'note'])
    })

    it('drops every descendant of a state root, at any depth', async () => {
      await create({id: 'note', content: 'a real note'})
      await seedUserState()

      const out = activityBlocks(await env.repo.query.recentActivity({
        workspaceId: WS, limit: 50,
      }).load())

      expect(out.map(r => r.id)).toEqual(['note'])
    })

    it('keeps a note the user authored on their own user page', async () => {
      // The user page is an ordinary navigable page; only its two state
      // roots are app-owned. Walking from the page itself would swallow
      // this.
      await seedUserState()
      await create({id: 'my-note', parentId: 'user-page', content: 'a note on my page'})

      const out = activityBlocks(await env.repo.query.recentActivity({
        workspaceId: WS, limit: 50,
      }).load())

      expect(out.map(r => r.id)).toEqual(['my-note'])
    })

    it('is the whole difference from recentBlocks, which still sees it all', async () => {
      await create({id: 'note', content: 'a real note'})
      await seedUserState()

      const out = asBlocks(await env.repo.query.recentBlocks({workspaceId: WS, limit: 50}).load())

      expect(out.map(r => r.id).sort()).toEqual(
        [UI_STATE_ID, PREFS_ID, 'metrics-record', 'note', 'plugin-prefs', 'plugin-state', 'user-page'].sort(),
      )
    })

    it('drops workspace-root system rows by type but keeps user-defined types', async () => {
      await create({id: 'note', content: 'a real note'})
      await create({id: 'panel', content: 'some-block-id', type: 'panel'})
      await create({id: 'recents-page', content: 'Recents', types: ['page', 'panel:recents']})
      await create({id: 'my-type', content: 'Book', types: ['page', 'block-type']})

      const out = activityBlocks(await env.repo.query.recentActivity({
        workspaceId: WS, limit: 50,
      }).load())

      expect(out.map(r => r.id).sort()).toEqual(['my-type', 'note'])
    })

    it('drops code-seeded definition blocks but keeps hand-made ones of the same type', async () => {
      await create({id: 'my-schema', content: 'Status', type: 'property-schema'})
      await create({id: 'my-extension', content: 'My extension', type: 'extension'})
      await create({id: 'seeded-schema', content: 'seed:key', type: 'property-schema'})
      await env.h.db.execute(
        `UPDATE blocks SET properties_json = ? WHERE id = ?`,
        [JSON.stringify({
          types: ['property-schema'],
          [seedKeyProp.name]: 'system:kernel-data/property/alias',
        }), 'seeded-schema'],
      )

      const out = activityBlocks(await env.repo.query.recentActivity({
        workspaceId: WS, limit: 50,
      }).load())

      expect(out.map(r => r.id).sort()).toEqual(['my-extension', 'my-schema'])
    })

    it('filters before the limit — a run of system rows cannot empty the page', async () => {
      await create({id: 'note-1', content: 'first'})
      await create({id: 'note-2', content: 'second'})
      for (let i = 0; i < 5; i++) {
        await create({id: `panel-${i}`, content: `panel ${i}`, type: 'panel'})
      }

      const out = activityBlocks(await env.repo.query.recentActivity({
        workspaceId: WS, limit: 2,
      }).load())

      expect(out.map(r => r.id)).toEqual(['note-2', 'note-1'])
    })

    it('walks through a tombstoned state parent to its still-live children', async () => {
      // Sync-apply permits a live child under a tombstoned parent (the
      // parent-not-deleted trigger is skipped for `source IS NULL`), so
      // this shape is reachable. Written raw for exactly that reason —
      // `repo.tx` would refuse to produce it.
      await create({id: 'note', content: 'a real note'})
      await seedUserState()
      await env.h.db.execute('UPDATE blocks SET deleted = 1 WHERE id = ?', ['plugin-state'])

      const out = activityBlocks(await env.repo.query.recentActivity({
        workspaceId: WS, limit: 50,
      }).load())

      expect(out.map(r => r.id)).toEqual(['note'])
    })

    it('scopes the user-state walk to the workspace', async () => {
      await create({id: 'other-user-page', content: 'Alice', types: ['user'], workspaceId: OTHER_WS})
      // Same parent id across workspaces shouldn't happen, but the walk
      // must key off this workspace's user pages regardless.
      await create({id: 'note', content: 'a real note'})

      const out = activityBlocks(await env.repo.query.recentActivity({
        workspaceId: WS, limit: 50,
      }).load())

      expect(out.map(r => r.id)).toEqual(['note'])
    })
})

describe('repo.query.firstChildByContent', () => {
  it('returns the first child by (orderKey, id) on exact match', async () => {
    await create({id: 'p'})
    await create({id: 'c1', parentId: 'p', orderKey: 'a2', content: 'hello'})
    await create({id: 'c2', parentId: 'p', orderKey: 'a1', content: 'hello'})
    await create({id: 'c3', parentId: 'p', orderKey: 'a3', content: 'hello'})
    const got = asBlockOrNull(await env.repo.query.firstChildByContent({parentId: 'p', content: 'hello'}).load())
    expect(got?.id).toBe('c2')
  })

  it('returns null when no match', async () => {
    await create({id: 'p'})
    expect(await env.repo.query.firstChildByContent({parentId: 'p', content: 'nope'}).load()).toBeNull()
  })

  it('excludes tombstoned children', async () => {
    await create({id: 'p'})
    await create({id: 'c1', parentId: 'p', orderKey: 'a1', content: 'hi'})
    await create({id: 'c2', parentId: 'p', orderKey: 'a2', content: 'hi'})
    await env.repo.tx(tx => tx.delete('c1'), {scope: ChangeScope.BlockDefault})
    const got = asBlockOrNull(await env.repo.query.firstChildByContent({parentId: 'p', content: 'hi'}).load())
    expect(got?.id).toBe('c2')
  })
})

describe('repo.query.aliasesInWorkspace', () => {
  it('returns aliases from all live blocks', async () => {
    // V1's `block_aliases_workspace_alias_unique` trigger prevents
    // two live blocks from claiming the same alias in the same
    // workspace via local writes, so each alias here is unique.
    // The SQL still has GROUP BY for defense-in-depth against
    // dupes that race-land via PowerSync sync-apply (which
    // bypasses the trigger).
    await create({id: 'a', aliases: ['Foo', 'Bar']})
    await create({id: 'b', aliases: ['Baz', 'Qux']})
    const out = await env.repo.query.aliasesInWorkspace({workspaceId: WS}).load()
    expect([...out].sort()).toEqual(['Bar', 'Baz', 'Foo', 'Qux'])
  })

  it('filters case-insensitively', async () => {
    await create({id: 'a', aliases: ['Inbox', 'Tasks']})
    const out = await env.repo.query.aliasesInWorkspace({workspaceId: WS, filter: 'IN'}).load()
    expect(out).toEqual(['Inbox'])
  })

  it('matches LIKE metacharacters in the filter literally, not as wildcards', async () => {
    await create({id: 'underscore', aliases: ['a_b']})
    await create({id: 'single-char', aliases: ['axb']}) // `_`-as-wildcard would match this
    await create({id: 'percent', aliases: ['50%done']})
    await create({id: 'plain', aliases: ['anything']}) // a bare `%` would match this if unescaped
    await create({id: 'backslash', aliases: ['a\\b']}) // contains a literal backslash

    // `_` must match a literal underscore, not any single char.
    expect(await env.repo.query.aliasesInWorkspace({workspaceId: WS, filter: 'a_b'}).load())
      .toEqual(['a_b'])
    // A bare `%` must match only aliases containing a literal percent, not every row.
    expect(await env.repo.query.aliasesInWorkspace({workspaceId: WS, filter: '%'}).load())
      .toEqual(['50%done'])
    // The escape char itself (`\`) must be escaped, so a backslash in the
    // filter matches literally instead of corrupting the LIKE pattern
    // (an unescaped `\b` would be read as escaped-`b` → pattern `%ab%`).
    expect(await env.repo.query.aliasesInWorkspace({workspaceId: WS, filter: 'a\\b'}).load())
      .toEqual(['a\\b'])
  })

  it('orders exact aliases before prefix and substring matches', async () => {
    await create({id: 'exact', aliases: ['i']})
    await create({id: 'prefix', aliases: ['Inbox']})
    await create({id: 'contains', aliases: ['Skiing']})

    const out = await env.repo.query.aliasesInWorkspace({workspaceId: WS, filter: 'i'}).load()

    expect(out).toEqual(['i', 'Inbox', 'Skiing'])
  })

  it('excludes tombstoned blocks', async () => {
    await create({id: 'a', aliases: ['Live']})
    await create({id: 'b', aliases: ['Dead']})
    await env.repo.tx(tx => tx.delete('b'), {scope: ChangeScope.BlockDefault})
    expect(await env.repo.query.aliasesInWorkspace({workspaceId: WS}).load()).toEqual(['Live'])
  })
})

describe('repo.query.aliasMatches', () => {
  it('returns one row per (alias, block) with content', async () => {
    await create({id: 'a', content: 'Inbox content', aliases: ['Inbox', 'Important']})
    await create({id: 'b', content: 'Tasks content', aliases: ['Tasks']})
    const out = await env.repo.query.aliasMatches({workspaceId: WS, filter: ''}).load()
    expect(out.map(r => `${r.alias}|${r.blockId}|${r.content}`).sort()).toEqual([
      'Important|a|Inbox content',
      'Inbox|a|Inbox content',
      'Tasks|b|Tasks content',
    ])
  })

  it('respects the limit argument', async () => {
    await create({id: 'a', aliases: ['x1', 'x2', 'x3']})
    expect(await env.repo.query.aliasMatches({workspaceId: WS, filter: 'x', limit: 2}).load())
      .toHaveLength(2)
  })

  it('orders exact aliases before prefix and substring matches', async () => {
    await create({id: 'exact', content: 'Exact page', aliases: ['Dating']})
    await create({id: 'prefix', content: 'Prefix page', aliases: ['Dating pool']})
    await create({id: 'contains', content: 'Contains page', aliases: ['Online Dating']})

    const out = await env.repo.query.aliasMatches({workspaceId: WS, filter: 'dating'}).load()

    expect(out.map(row => row.alias)).toEqual(['Dating', 'Dating pool', 'Online Dating'])
  })

  it('matches LIKE metacharacters in the filter literally, not as wildcards', async () => {
    await create({id: 'lit', content: 'c', aliases: ['a_b']})
    await create({id: 'wild', content: 'c', aliases: ['axb']}) // `_`-as-wildcard would match this
    const out = await env.repo.query.aliasMatches({workspaceId: WS, filter: 'a_b'}).load()
    expect(out.map(row => row.alias)).toEqual(['a_b'])
  })
})

describe('repo.query.aliasMatchesFuzzy', () => {
  it('returns rows with updated_at for the JS ranker', async () => {
    await create({id: 'a', content: 'Inbox content', aliases: ['Inbox']})
    const out = await env.repo.query.aliasMatchesFuzzy({
      workspaceId: WS,
      prefixes: ['inb'],
    }).load()
    expect(out).toEqual([
      {alias: 'Inbox', blockId: 'a', content: 'Inbox content', updatedAt: expect.any(Number)},
    ])
    expect(out[0].updatedAt).toBeGreaterThan(0)
  })

  it('AND-filters across prefixes (word-skip pre-filter)', async () => {
    // "PR Review Skill" has both "pr" and "rev" as substrings
    await create({id: 'match', aliases: ['PR Review Skill']})
    await create({id: 'only-pr', aliases: ['PR notes']})
    await create({id: 'only-rev', aliases: ['Review of books']})

    const out = await env.repo.query.aliasMatchesFuzzy({
      workspaceId: WS,
      prefixes: ['pr', 'rev'],
    }).load()
    expect(out.map(row => row.blockId).sort()).toEqual(['match'])
  })

  it('matches LIKE metacharacters in a prefix literally, not as wildcards', async () => {
    // Prefixes are literal token substrings, not patterns — a typed `_`
    // must not act as a single-char wildcard in the pre-filter.
    await create({id: 'lit', aliases: ['a_b']})
    await create({id: 'wild', aliases: ['axb']}) // `_`-as-wildcard would match this
    const out = await env.repo.query.aliasMatchesFuzzy({
      workspaceId: WS,
      prefixes: ['a_b'],
    }).load()
    expect(out.map(row => row.blockId)).toEqual(['lit'])
  })

  it('returns workspace-wide rows when prefixes is empty', async () => {
    await create({id: 'a', aliases: ['Foo']})
    await create({id: 'b', aliases: ['Bar']})
    const out = await env.repo.query.aliasMatchesFuzzy({
      workspaceId: WS,
      prefixes: [],
    }).load()
    expect(out.map(row => row.alias).sort()).toEqual(['Bar', 'Foo'])
  })

  it('respects the limit argument', async () => {
    await create({id: 'a', aliases: ['x1', 'x2', 'x3']})
    const out = await env.repo.query.aliasMatchesFuzzy({
      workspaceId: WS,
      prefixes: ['x'],
      limit: 2,
    }).load()
    expect(out).toHaveLength(2)
  })

  it('keeps an exact alias in the candidate pool ahead of mere substring matches', async () => {
    // The substring-only row is created first and sorts alphabetically
    // ahead of the exact match, so an unordered pre-filter LIMIT would
    // evict the exact alias before the JS ranker ever sees it.
    await create({id: 'sub', aliases: ['Accommodating']})
    await create({id: 'exact', aliases: ['Dating']})

    const out = await env.repo.query.aliasMatchesFuzzy({
      workspaceId: WS,
      prefixes: ['dat'],
      query: 'dating',
      limit: 1,
    }).load()

    expect(out.map(row => row.alias)).toEqual(['Dating'])
  })

  it('excludes tombstoned blocks', async () => {
    await create({id: 'live', aliases: ['Foo Live']})
    await create({id: 'dead', aliases: ['Foo Dead']})
    await env.repo.tx(tx => tx.delete('dead'), {scope: ChangeScope.BlockDefault})
    const out = await env.repo.query.aliasMatchesFuzzy({
      workspaceId: WS,
      prefixes: ['foo'],
    }).load()
    expect(out.map(row => row.blockId)).toEqual(['live'])
  })
})

describe('repo.query.aliasLookup', () => {
  it('returns the matching block (case-sensitive exact match)', async () => {
    await create({id: 'page', aliases: ['Inbox', 'inbox-2']})
    const got = asBlockOrNull(await env.repo.query.aliasLookup({workspaceId: WS, alias: 'Inbox'}).load())
    expect(got?.id).toBe('page')
  })

  it('returns null on no match', async () => {
    await create({id: 'page', aliases: ['Inbox']})
    expect(await env.repo.query.aliasLookup({workspaceId: WS, alias: 'missing'}).load()).toBeNull()
  })

  it('returns the oldest match on duplicate aliases (deterministic tie-break)', async () => {
    // V1's local-write trigger prevents duplicate
    // `(workspace_id, alias)` rows, so we seed the dupe by
    // bypassing it: insert directly into `block_aliases` while
    // `tx_context.source` is NULL (the trigger's `WHEN` guard
    // skips outside an active local tx — mirrors the PowerSync
    // sync-apply path where dupes from other clients can race-
    // land). The query's `ORDER BY created_at LIMIT 1` is the
    // defense-in-depth tie-break this test pins.
    await create({id: 'older', aliases: ['Dup']})
    await create({id: 'newer', content: 'Newer'})
    await env.h.db.execute(
      `INSERT INTO block_aliases (block_id, workspace_id, alias, alias_lower) VALUES (?, ?, ?, ?)`,
      ['newer', WS, 'Dup', 'dup'],
    )
    const got = asBlockOrNull(await env.repo.query.aliasLookup({workspaceId: WS, alias: 'Dup'}).load())
    expect(got?.id).toBe('older')
  })

  it('excludes soft-deleted', async () => {
    await create({id: 'a', aliases: ['Foo']})
    await env.repo.tx(tx => tx.delete('a'), {scope: ChangeScope.BlockDefault})
    expect(await env.repo.query.aliasLookup({workspaceId: WS, alias: 'Foo'}).load()).toBeNull()
  })

  it('returns null on empty alias / workspaceId', async () => {
    expect(await env.repo.query.aliasLookup({workspaceId: WS, alias: ''}).load()).toBeNull()
    expect(await env.repo.query.aliasLookup({workspaceId: '', alias: 'x'}).load()).toBeNull()
  })
})

describe('repo.query.findExtensionBlocks', () => {
  it('returns blocks whose types membership includes "extension"', async () => {
    await create({id: 'ext1', type: 'extension'})
    await create({id: 'ext2', type: 'extension'})
    await create({id: 'note', type: 'note'})
    const out = asBlocks(await env.repo.query.findExtensionBlocks({workspaceId: WS}).load())
    expect(out.map(b => b.id).sort()).toEqual(['ext1', 'ext2'])
  })

  it('scopes to workspaceId', async () => {
    await create({id: 'a', type: 'extension', workspaceId: WS})
    await create({id: 'b', type: 'extension', workspaceId: OTHER_WS})
    const wsOut = asBlocks(await env.repo.query.findExtensionBlocks({workspaceId: WS}).load())
    expect(wsOut.map(b => b.id)).toEqual(['a'])
  })

  it('returns [] on empty workspaceId', async () => {
    expect(asBlocks(await env.repo.query.findExtensionBlocks({workspaceId: ''}).load())).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════
// Invalidation per dep kind
// ════════════════════════════════════════════════════════════════════

describe('repo.query.blockTypesByIds', () => {
  it('returns types in the order the block declares them, filtering non-strings', async () => {
    await env.h.db.execute(
      `UPDATE blocks SET properties_json = ? WHERE id = ?`,
      [JSON.stringify({types: ['person', null, 'author']}), 'b'],
    ).catch(() => {})
    await create({id: 'ordered'})
    await env.h.db.execute(
      `UPDATE blocks SET properties_json = ? WHERE id = ?`,
      [JSON.stringify({types: ['person', null, 'author']}), 'ordered'],
    )

    const out = await env.repo.query.blockTypesByIds({
      workspaceId: WS,
      blockIds: ['ordered'],
    }).load()
    // Declared order, NOT the (block_id, type) index's ascending order —
    // consumers show the first type, so 'person' has to stay first.
    expect(out).toEqual([
      {blockId: 'ordered', type: 'person'},
      {blockId: 'ordered', type: 'author'},
    ])
  })

  it('tagging a previously-untyped block invalidates the handle (per-id row dep)', async () => {
    // The dep is declared per REQUESTED id, not per returned row. An
    // untyped block contributes no rows, so a dep derived from the
    // result set would never see it gain a type — the completion
    // dropdown would keep showing no hint until something else
    // invalidated it.
    await create({id: 'untyped'})
    const handle = env.repo.query.blockTypesByIds({workspaceId: WS, blockIds: ['untyped']})
    expect(await handle.load()).toEqual([])

    const fired: unknown[] = []
    const unsub = handle.subscribe(v => { fired.push(v) })
    try {
      await env.repo.tx(async tx => {
        await tx.update('untyped', {
          properties: {[typesProp.name]: typesProp.codec.encode(['person'])},
        })
      }, {scope: ChangeScope.BlockDefault})

      await vi.waitFor(() => {
        expect(handle.peek()).toEqual([{blockId: 'untyped', type: 'person'}])
      })
    } finally {
      unsub()
    }
  })
})

describe('repo.query.aliasClaimants', () => {
  // Same sync-applied seeding as `aliasClaimantCounts` below, for the same
  // reason: `repo.tx` cannot produce a co-claim, the uniqueness trigger
  // rejects it. What this query adds over the counts is the ROWS — a consumer
  // asking "who else claims my name" needs to identify them, not tally them.
  const claimRaw = async (id: string, alias: string, opts: {
    workspaceId?: string; deleted?: number; createdAt?: number
  } = {}) => {
    await env.h.db.execute(
      `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json,
        references_json, created_at, updated_at, user_updated_at, created_by, updated_by, deleted)
       VALUES (?, ?, NULL, ?, ?, ?, '[]', ?, 1, 1, 'u', 'u', ?)`,
      [
        id, opts.workspaceId ?? WS, `k-${id}`, id,
        JSON.stringify({[aliasesProp.name]: [alias]}),
        opts.createdAt ?? 1, opts.deleted ?? 0,
      ],
    )
  }

  it('returns every live claimant, oldest first', async () => {
    await claimRaw('newer', 'Journal', {createdAt: 200})
    await claimRaw('older', 'Journal', {createdAt: 100})
    await claimRaw('gone', 'Journal', {createdAt: 50, deleted: 1})
    await claimRaw('elsewhere', 'Journal', {createdAt: 10, workspaceId: OTHER_WS})
    await claimRaw('unrelated', 'Other', {createdAt: 20})

    const out = await env.repo.query.aliasClaimants({workspaceId: WS, alias: 'Journal'}).load()
    expect(out.map(block => block.id)).toEqual(['older', 'newer'])
  })

  it('returns [] for an unclaimed alias and for blank arguments', async () => {
    await claimRaw('page', 'Journal')
    expect(await env.repo.query.aliasClaimants({workspaceId: WS, alias: 'Nobody'}).load()).toEqual([])
    expect(await env.repo.query.aliasClaimants({workspaceId: WS, alias: ''}).load()).toEqual([])
    expect(await env.repo.query.aliasClaimants({workspaceId: '', alias: 'Journal'}).load()).toEqual([])
  })

  it('invalidates when a claimant appears or leaves', async () => {
    await create({id: 'canonical', aliases: ['Journal']})
    const handle = env.repo.query.aliasClaimants({workspaceId: WS, alias: 'Journal'})
    expect((await handle.load()).map(block => block.id)).toEqual(['canonical'])

    await env.repo.tx(tx => tx.delete('canonical'), {scope: ChangeScope.BlockDefault})
    await vi.waitFor(async () => {
      expect(await handle.load()).toEqual([])
    })
  })
})

describe('repo.query.aliasClaimantCounts', () => {
  it('counts live claimants per alias, ignoring deleted rows and other workspaces', async () => {
    // Duplicate claims cannot go through `repo.tx` — the alias-uniqueness
    // processor rejects the second one. Raw inserts are the sync-applied
    // shape that produces co-claims in the first place: they maintain the
    // block_aliases index but run no post-commit processor.
    const claimRaw = async (id: string, alias: string, workspaceId = WS, deleted = 0) => {
      await env.h.db.execute(
        `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json,
          references_json, created_at, updated_at, user_updated_at, created_by, updated_by, deleted)
         VALUES (?, ?, NULL, ?, '', ?, '[]', 1, 1, 1, 'u', 'u', ?)`,
        [id, workspaceId, `k-${id}`, JSON.stringify({[aliasesProp.name]: [alias]}), deleted],
      )
    }
    await claimRaw('a1', 'Shared')
    await claimRaw('a2', 'Shared')
    await claimRaw('gone', 'Shared', WS, 1)
    await claimRaw('solo', 'Solo')
    await claimRaw('other', 'Shared', 'ws-other')

    const out = await env.repo.query.aliasClaimantCounts({
      workspaceId: WS,
      aliases: ['Shared', 'Solo', 'Absent'],
    }).load()

    expect([...out].sort((x, y) => x.alias.localeCompare(y.alias))).toEqual([
      {alias: 'Shared', claimants: 2},
      {alias: 'Solo', claimants: 1},
    ])
  })
})

describe('invalidation', () => {
  it('subtree: a new descendant invalidates the handle (parent-edge dep)', async () => {
    await create({id: 'r'})
    await create({id: 'c1', parentId: 'r', orderKey: 'a0'})
    const handle = env.repo.query.subtree({id: 'r'})
    let value = asBlocks(await handle.load())
    expect(value.map(b => b.id)).toEqual(['r', 'c1'])

    // Subscribe so the handle stays alive + fires on invalidation.
    const fired: BlockData[][] = []
    const unsub = handle.subscribe((v) => { fired.push(v as BlockData[]) })
    try {
      // Add a new grandchild — parent-edge on c1 should invalidate.
      await create({id: 'gc', parentId: 'c1', orderKey: 'a0'})
      // Wait for the async re-resolve. `setTimeout(10)` was racy
      // under full-suite parallelism — the loader's reader-pool
      // round-trip can take longer than 10 ms when 65+ files are
      // contending for PowerSync's worker threads.
      await vi.waitFor(() => {
        expect(asBlocks(handle.peek()).map(b => b.id)).toEqual(['r', 'c1', 'gc'])
      })
      value = asBlocks(handle.peek())
      expect(fired.length).toBeGreaterThanOrEqual(1)
    } finally {
      unsub()
    }
  })

  it.each([
    ['lean', {id: 'p'}],
    ['hydrating', {id: 'p', hydrate: true}],
  ] as const)('childIds (%s): row-content edit on a child does NOT invalidate', async (_label, args) => {
    await create({id: 'p'})
    await create({id: 'c1', parentId: 'p'})
    await create({id: 'c2', parentId: 'p', orderKey: 'a1'})
    // Both variants declare ONLY parent-edge on `id`; hydrate=true is a
    // cache-priming side effect and must not add per-row deps.
    const handle = env.repo.query.childIds(args)
    await handle.load()

    const fired: string[][] = []
    const unsub = handle.subscribe(v => { fired.push(asIds(v as string[])) })
    try {
      // Content-only edit on c1 — bumps rowIds in the tx fast path but
      // the lean childIds dep set has no row entry, so the list must not
      // re-project.
      const inv0 = invalidations()
      await env.repo.tx(tx => tx.update('c1', {content: 'edited'}), {scope: ChangeScope.BlockDefault})
      // Sound negative proof — the content edit invalidated no handle (pre-dedup).
      expect(invalidations()).toBe(inv0)
      // Tracer-bullet: adding a real child DOES invalidate (parent-edge).
      // Wait for that single emission; a content-edit re-projection would
      // surface as an extra one. (Replaces a 10 ms sleep that raced the
      // reader pool under full-suite parallelism.)
      await create({id: 'c3', parentId: 'p', orderKey: 'a2'})
      await vi.waitFor(() => expect([...(fired.at(-1) ?? [])].sort()).toEqual(['c1', 'c2', 'c3']))
      expect(fired.length).toBe(1)
    } finally {
      unsub()
    }
  })

  it('children: row-content edit on a child DOES invalidate (hydrate path declares row deps)', async () => {
    await create({id: 'p'})
    await create({id: 'c1', parentId: 'p'})
    const handle = env.repo.query.children({id: 'p'})
    await handle.load()

    const fired: number[] = []
    const unsub = handle.subscribe(() => { fired.push(1) })
    try {
      await env.repo.tx(tx => tx.update('c1', {content: 'edited'}), {scope: ChangeScope.BlockDefault})
      await vi.waitFor(() => expect(fired.length).toBeGreaterThanOrEqual(1))
    } finally {
      unsub()
    }
  })

  it('firstChildByContent: child content edits can invalidate an empty result', async () => {
    await create({id: 'p'})
    await create({id: 'c1', parentId: 'p', content: 'draft'})
    const handle = env.repo.query.firstChildByContent({parentId: 'p', content: 'published'})
    await handle.load()

    const fired: Array<BlockData | null> = []
    const unsub = handle.subscribe(value => { fired.push(value) })
    try {
      await env.repo.tx(
        tx => tx.update('c1', {content: 'published'}),
        {scope: ChangeScope.BlockDefault},
      )
      await vi.waitFor(() => expect(asBlockOrNull(handle.peek())?.id).toBe('c1'))
      expect(fired.some(value => value?.id === 'c1')).toBe(true)
    } finally {
      unsub()
    }
  })

  it('byType: a new matching row invalidates (typedBlocks.type channel)', async () => {
    await create({id: 'a', type: 'note'})
    const handle = env.repo.query.byType({workspaceId: WS, type: 'note'})
    let value = asBlocks(await handle.load())
    expect(value.map(b => b.id)).toEqual(['a'])

    const fired: BlockData[][] = []
    const unsub = handle.subscribe((v) => { fired.push(v as BlockData[]) })
    try {
      await create({id: 'b', type: 'note'})
      await vi.waitFor(() => {
        expect(asBlocks(handle.peek()).map(b => b.id).sort()).toEqual(['a', 'b'])
      })
      value = asBlocks(handle.peek())
      expect(fired.length).toBeGreaterThanOrEqual(1)
    } finally {
      unsub()
    }
  })

  it('byType: a UiState write on an unrelated block does NOT invalidate', async () => {
    // Reproduces the "up/down feels slow" regression: focus writes were
    // re-resolving every workspace-scoped query (including the
    // userSchemasService's typedBlocks subscription) on every arrow press.
    await create({id: 'a', type: 'note'})
    await create({id: 'panel'})
    const handle = env.repo.query.byType({workspaceId: WS, type: 'note'})
    await handle.load()

    const fired: string[][] = []
    const unsub = handle.subscribe(v => { fired.push(asBlocks(v as BlockData[]).map(b => b.id)) })
    try {
      const inv0 = invalidations()
      await env.repo.tx(async tx => {
        const block = env.repo.block('panel')
        await block.load()
        await tx.update('panel', {properties: {focusedBlockLocation: {blockId: 'something', renderScopeId: 'scope:something'}}})
      }, {scope: ChangeScope.UiState})
      // Sound negative proof — the UiState write invalidated no handle (pre-dedup).
      expect(invalidations()).toBe(inv0)
      // Tracer-bullet: a new matching note DOES invalidate the type channel.
      // Wait for that single emission; a UiState-triggered re-resolve would
      // surface as an extra one. (Replaces a 30 ms "give it a chance to
      // misfire" sleep with a deterministic positive control.)
      await create({id: 'b', type: 'note'})
      await vi.waitFor(() => expect([...(fired.at(-1) ?? [])].sort()).toEqual(['a', 'b']))
      expect(fired.length).toBe(1)
    } finally {
      unsub()
    }
  })

  it('byType: an unrelated content edit on a non-matching block does NOT invalidate', async () => {
    await create({id: 'a', type: 'note'})
    await create({id: 'plain'})  // no type
    const handle = env.repo.query.byType({workspaceId: WS, type: 'note'})
    await handle.load()

    const fired: string[][] = []
    const unsub = handle.subscribe(v => { fired.push(asBlocks(v as BlockData[]).map(b => b.id)) })
    try {
      const inv0 = invalidations()
      await env.repo.tx(
        tx => tx.update('plain', {content: 'edited'}),
        {scope: ChangeScope.BlockDefault},
      )
      // Sound negative proof — the unrelated content edit invalidated no handle.
      expect(invalidations()).toBe(inv0)
      // Tracer-bullet: a new note DOES invalidate. Wait for that single
      // emission; had the non-matching content edit leaked 'plain' into the
      // result, it would surface as an earlier (wrong-valued) emission.
      await create({id: 'b', type: 'note'})
      await vi.waitFor(() => expect([...(fired.at(-1) ?? [])].sort()).toEqual(['a', 'b']))
      expect(fired.length).toBe(1)
    } finally {
      unsub()
    }
  })

  it('byType: adding the type to an existing block via property update invalidates', async () => {
    await create({id: 'a'})  // starts without the type
    const handle = env.repo.query.byType({workspaceId: WS, type: 'note'})
    expect(asBlocks(await handle.load()).map(b => b.id)).toEqual([])

    const fired: number[] = []
    const unsub = handle.subscribe(() => { fired.push(1) })
    try {
      await env.repo.tx(
        tx => tx.update('a', {
          properties: {[typesProp.name]: typesProp.codec.encode(['note'])},
        }),
        {scope: ChangeScope.BlockDefault},
      )
      await vi.waitFor(() => {
        expect(asBlocks(handle.peek()).map(b => b.id)).toEqual(['a'])
      })
      expect(fired.length).toBeGreaterThanOrEqual(1)
    } finally {
      unsub()
    }
  })

  it('byType: soft-delete removes a matching row and restore re-adds it', async () => {
    await create({id: 'a', type: 'note'})
    const handle = env.repo.query.byType({workspaceId: WS, type: 'note'})
    expect(asBlocks(await handle.load()).map(b => b.id)).toEqual(['a'])

    const fired: string[][] = []
    const unsub = handle.subscribe((value) => { fired.push(asBlocks(value).map(b => b.id)) })
    try {
      await env.repo.tx(tx => tx.delete('a'), {scope: ChangeScope.BlockDefault})
      await vi.waitFor(() => {
        expect(asBlocks(handle.peek()).map(b => b.id)).toEqual([])
      })
      expect(env.repo.block('a').peek()).toBeNull()

      await env.repo.tx(tx => tx.restore('a'), {scope: ChangeScope.BlockDefault})
      await vi.waitFor(() => {
        expect(asBlocks(handle.peek()).map(b => b.id)).toEqual(['a'])
      })
      expect(fired).toContainEqual([])
      expect(fired).toContainEqual(['a'])
    } finally {
      unsub()
    }
  })

  it('typedBlocks (where): a property change on a non-matching block invalidates', async () => {
    // `renderer` is a kernel-registered, where-queryable property —
    // pick it so we don't have to wire setFacetRuntime here.
    await create({id: 'a'})
    await create({id: 'b'})
    const handle = env.repo.query.typedBlocks({workspaceId: WS, where: {renderer: 'markdown'}})
    expect(asBlocks(await handle.load()).map(b => b.id)).toEqual([])

    const fired: number[] = []
    const unsub = handle.subscribe(() => { fired.push(1) })
    try {
      // `a` was previously not in the result, so per-row deps don't
      // catch it. The typedBlocks.property:<ws>:renderer channel does.
      await env.repo.tx(
        tx => tx.update('a', {properties: {renderer: 'markdown'}}),
        {scope: ChangeScope.BlockDefault},
      )
      await vi.waitFor(() => {
        expect(asBlocks(handle.peek()).map(b => b.id)).toEqual(['a'])
      })
      expect(fired.length).toBeGreaterThanOrEqual(1)
    } finally {
      unsub()
    }
  })

  it('typedBlocks (where): UiState write on a different property does NOT invalidate', async () => {
    await create({id: 'a', type: 'note'})
    await create({id: 'panel'})
    const handle = env.repo.query.typedBlocks({workspaceId: WS, where: {renderer: 'markdown'}})
    await handle.load()

    const fired: number[] = []
    const unsub = handle.subscribe(() => { fired.push(1) })
    try {
      const inv0 = invalidations()
      await env.repo.tx(
        tx => tx.update('panel', {properties: {focusedBlockLocation: {blockId: 'x', renderScopeId: 'scope:x'}}}),
        {scope: ChangeScope.UiState},
      )
      // Sound negative proof — the UiState write matched no handle (pre-dedup).
      expect(invalidations()).toBe(inv0)

      // Control-write fence (liveness): a property write that DOES enter the result
      // proves the UiState write above fired nothing — the fence is the
      // sole emission. (Replaces a 30 ms sleep that raced the reader pool.)
      await env.repo.tx(
        tx => tx.update('a', {properties: {renderer: 'markdown'}}),
        {scope: ChangeScope.BlockDefault},
      )
      await vi.waitFor(() => {
        expect(asBlocks(handle.peek()).map(b => b.id)).toEqual(['a'])
      })
      expect(fired.length).toBe(1)
    } finally {
      unsub()
    }
  })

  it('typedBlocks (referencedBy content-only): a content ref appearing on any block invalidates an empty result', async () => {
    // `referencedBy: {id, sourceField: ''}` is the "content refs only"
    // filter — block_references stores omitted-sourceField rows as ''.
    // The query must subscribe to a channel the rule actually emits;
    // an early version skipped emitting the empty-string field channel,
    // which silently dropped these queries on the floor when a row
    // entered from an empty result via a freshly-added content ref.
    await create({id: 'target'})
    await create({id: 'src'})
    const handle = env.repo.query.typedBlocks({
      workspaceId: WS,
      referencedBy: {id: 'target', sourceField: ''},
    })
    expect(asBlocks(await handle.load()).map(b => b.id)).toEqual([])

    const fired: number[] = []
    const unsub = handle.subscribe(() => { fired.push(1) })
    try {
      // Add a content ref `src → target`. block_references writes
      // `source_field = ''` for content refs.
      await env.repo.tx(
        tx => tx.update('src', {references: [{id: 'target', alias: 'target'}]}),
        {scope: ChangeScope.BlockDefault},
      )
      await vi.waitFor(() => {
        expect(asBlocks(handle.peek()).map(b => b.id)).toEqual(['src'])
      })
      expect(fired.length).toBeGreaterThanOrEqual(1)
    } finally {
      unsub()
    }
  })

  it('typedBlockIds (referencedBy): a content edit on a matched source does NOT invalidate', async () => {
    await create({id: 'target'})
    await create({id: 'src', references: [{id: 'target', alias: 'target'}]})
    const handle = env.repo.query.typedBlockIds({
      workspaceId: WS,
      referencedBy: {id: 'target'},
    })
    expect(asIds(await handle.load())).toEqual(['src'])

    const fired: string[][] = []
    const unsub = handle.subscribe((value) => { fired.push(value) })
    try {
      const inv0 = invalidations()
      await env.repo.tx(
        tx => tx.update('src', {content: 'edited but still references target'}),
        {scope: ChangeScope.BlockDefault},
      )
      // Sound negative proof — the content edit matched no handle (pre-dedup).
      expect(invalidations()).toBe(inv0)

      // Control-write fence (liveness): a new source referencing `target` DOES enter
      // the result; the content edit above must not have fired, so the
      // create is the sole emission. (Replaces a 30 ms sleep.)
      await create({id: 'src2', references: [{id: 'target', alias: 'target'}]})
      await vi.waitFor(() => {
        expect([...asIds(handle.peek())].sort()).toEqual(['src', 'src2'])
      })
      expect(fired.length).toBe(1)
    } finally {
      unsub()
    }
  })

  it('typedBlockIds (ancestor filter): moving a source across matching ancestors invalidates', async () => {
    await create({id: 'target'})
    await create({id: 'project'})
    await create({
      id: 'matching-parent',
      references: [{id: 'project', alias: 'Project'}],
    })
    await create({id: 'plain-parent'})
    await create({
      id: 'src',
      parentId: 'matching-parent',
      references: [{id: 'target', alias: 'Target'}],
    })
    const handle = env.repo.query.typedBlockIds({
      workspaceId: WS,
      referencedBy: {id: 'target'},
      match: [{scope: 'ancestor', referencedBy: {id: 'project'}}],
    })
    expect(asIds(await handle.load())).toEqual(['src'])

    const fired: string[][] = []
    const unsub = handle.subscribe((value) => { fired.push(value) })
    try {
      await env.repo.tx(
        tx => tx.move('src', {parentId: 'plain-parent', orderKey: 'a0'}),
        {scope: ChangeScope.BlockDefault},
      )
      await vi.waitFor(() => {
        expect(asIds(handle.peek())).toEqual([])
      })
      expect(fired).toContainEqual([])
    } finally {
      unsub()
    }
  })

  it('typedBlockIds (ancestor filter): restoring an implicit ancestor context invalidates', async () => {
    await create({id: 'target'})
    await create({id: 'context'})
    await create({
      id: 'src',
      parentId: 'context',
      references: [{id: 'target', alias: 'Target'}],
    })
    const handle = env.repo.query.typedBlockIds({
      workspaceId: WS,
      referencedBy: {id: 'target'},
      match: [{scope: 'ancestor', referencedBy: {id: 'context'}}],
    })
    expect(asIds(await handle.load())).toEqual(['src'])

    const fired: string[][] = []
    const unsub = handle.subscribe((value) => { fired.push(value) })
    try {
      await env.repo.tx(tx => tx.delete('context'), {scope: ChangeScope.BlockDefault})
      await vi.waitFor(() => {
        expect(asIds(handle.peek())).toEqual([])
      })

      await env.repo.tx(tx => tx.restore('context'), {scope: ChangeScope.BlockDefault})
      await vi.waitFor(() => {
        expect(asIds(handle.peek())).toEqual(['src'])
      })
      expect(fired).toContainEqual(['src'])
    } finally {
      unsub()
    }
  })

  it('typedBlockIds (ancestor filter): ancestor content edits do NOT invalidate', async () => {
    await create({id: 'target'})
    await create({id: 'project'})
    await create({
      id: 'parent',
      references: [{id: 'project', alias: 'Project'}],
    })
    await create({id: 'plain-parent'})
    await create({
      id: 'src',
      parentId: 'parent',
      references: [{id: 'target', alias: 'Target'}],
    })
    const handle = env.repo.query.typedBlockIds({
      workspaceId: WS,
      referencedBy: {id: 'target'},
      match: [{scope: 'ancestor', referencedBy: {id: 'project'}}],
    })
    expect(asIds(await handle.load())).toEqual(['src'])

    const fired: string[][] = []
    const unsub = handle.subscribe((value) => { fired.push(value) })
    try {
      const inv0 = invalidations()
      await env.repo.tx(
        tx => tx.update('parent', {content: 'renamed parent, refs unchanged'}),
        {scope: ChangeScope.BlockDefault},
      )
      // Sound negative proof — the ancestor content edit matched no handle.
      expect(invalidations()).toBe(inv0)

      // Control-write fence (liveness): moving `src` out from under the matching
      // ancestor DOES empty the result; the ancestor content edit above
      // must not have fired. (Replaces a 30 ms sleep.)
      await env.repo.tx(
        tx => tx.move('src', {parentId: 'plain-parent', orderKey: 'a0'}),
        {scope: ChangeScope.BlockDefault},
      )
      await vi.waitFor(() => {
        expect(asIds(handle.peek())).toEqual([])
      })
      expect(fired.length).toBe(1)
    } finally {
      unsub()
    }
  })

  it('typedBlocks (types + null-where): a creation that is NOT a member type does NOT invalidate', async () => {
    // {types:['note'], where:{renderer:null}} — the type filter is the
    // positive membership axis. A new block in the workspace that
    // isn't typed `note` cannot enter the result regardless of its
    // `renderer`, so the query should not subscribe to the live
    // channel; only the `note` type channel is required.
    await create({id: 'a', type: 'note'})
    const handle = env.repo.query.typedBlocks({
      workspaceId: WS,
      types: ['note'],
      where: {renderer: null},
    })
    await handle.load()

    const fired: number[] = []
    const unsub = handle.subscribe(() => { fired.push(1) })
    try {
      // Create an unrelated block (no `note` type). With the previous
      // unconditional live dep, this fired the handle for nothing.
      const inv0 = invalidations()
      await create({id: 'unrelated'})
      // Sound negative proof — the unrelated create matched no handle (pre-dedup).
      expect(invalidations()).toBe(inv0)

      // Control-write fence (liveness): a new `note` block DOES enter the result;
      // the unrelated non-note create above must not have fired.
      // (Replaces a 30 ms sleep.)
      await create({id: 'b', type: 'note'})
      await vi.waitFor(() => {
        expect(asBlocks(handle.peek()).map(b => b.id).sort()).toEqual(['a', 'b'])
      })
      expect(fired.length).toBe(1)
    } finally {
      unsub()
    }
  })

  it('searchByContent: a content edit on any block invalidates (kernel.content channel)', async () => {
    await create({id: 'a', content: 'hello world'})
    await create({id: 'b', content: 'unrelated'})
    const handle = env.repo.query.searchByContent({workspaceId: WS, query: 'hello'})
    expect(asBlocks(await handle.load()).map(b => b.id)).toEqual(['a'])

    const fired: number[] = []
    const unsub = handle.subscribe(() => { fired.push(1) })
    try {
      await env.repo.tx(
        tx => tx.update('b', {content: 'hello again'}),
        {scope: ChangeScope.BlockDefault},
      )
      await vi.waitFor(() => {
        expect(asBlocks(handle.peek()).map(b => b.id).sort()).toEqual(['a', 'b'])
      })
      expect(fired.length).toBeGreaterThanOrEqual(1)
    } finally {
      unsub()
    }
  })

  it('searchByContent: a UiState property write does NOT invalidate', async () => {
    // The narrow `kernel.content` channel only fires on content edits +
    // live-set membership. Property-only writes (the UiState shape) used
    // to wake every workspace-broad alias/content handle.
    await create({id: 'a', content: 'hello'})
    await create({id: 'panel'})
    const handle = env.repo.query.searchByContent({workspaceId: WS, query: 'hello'})
    await handle.load()

    const fired: number[] = []
    const unsub = handle.subscribe(() => { fired.push(1) })
    try {
      const inv0 = invalidations()
      await env.repo.tx(
        tx => tx.update('panel', {properties: {focusedBlockLocation: {blockId: 'x', renderScopeId: 'scope:x'}}}),
        {scope: ChangeScope.UiState},
      )
      // Sound negative proof — the UiState write matched no handle (pre-dedup).
      expect(invalidations()).toBe(inv0)

      // Control-write fence (liveness): a content edit that enters the result DOES
      // fire; the UiState write above must not have. (Replaces a 30 ms sleep.)
      await env.repo.tx(
        tx => tx.update('panel', {content: 'hello world'}),
        {scope: ChangeScope.BlockDefault},
      )
      await vi.waitFor(() => {
        expect(asBlocks(handle.peek()).map(b => b.id).sort()).toEqual(['a', 'panel'])
      })
      expect(fired.length).toBe(1)
    } finally {
      unsub()
    }
  })

  it('recentBlocks: a content edit invalidates; a UiState write does NOT', async () => {
    await create({id: 'a', content: 'aa'})
    await create({id: 'panel'})
    const handle = env.repo.query.recentBlocks({workspaceId: WS, limit: 10})
    expect(asBlocks(await handle.load()).map(b => b.id)).toEqual(['a'])

    const fired: number[] = []
    const unsub = handle.subscribe(() => { fired.push(1) })
    try {
      // UiState writes must not wake the handle — recent-picker tolerates
      // lightly stale `updated_at` ordering between content events.
      const inv0 = invalidations()
      await env.repo.tx(
        tx => tx.update('panel', {properties: {focusedBlockLocation: {blockId: 'x', renderScopeId: 'scope:x'}}}),
        {scope: ChangeScope.UiState},
      )
      // Sound negative proof — the UiState write matched no handle (pre-dedup).
      expect(invalidations()).toBe(inv0)

      // Control-write fence (liveness): a new non-empty block DOES wake it (live-set
      // membership); the UiState write above must not have fired, so the
      // create is the sole emission. (Replaces a 30 ms sleep.)
      await create({id: 'b', content: 'bb'})
      await vi.waitFor(() => {
        expect(asBlocks(handle.peek()).map(b => b.id).sort()).toEqual(['a', 'b'])
      })
      expect(fired.length).toBe(1)
    } finally {
      unsub()
    }
  })

  it('searchByContent / recentBlocks: parent move on a result row does NOT invalidate', async () => {
    // Both queries declare only the `kernel.content` plugin channel —
    // that covers content edits + live-set membership, which is the
    // full sensitivity surface of a content-substring scan / recency
    // pick. Per-row deps would fire on parent moves of currently-
    // returned rows for nothing; passing declareRowDeps:false on the
    // hydrateBlocks call keeps the dep set narrow.
    await create({id: 'p1'})
    await create({id: 'p2'})
    await create({id: 'a', parentId: 'p1', content: 'hello world'})
    const searchHandle = env.repo.query.searchByContent({workspaceId: WS, query: 'hello'})
    const recentHandle = env.repo.query.recentBlocks({workspaceId: WS, limit: 10})
    expect(asBlocks(await searchHandle.load()).map(b => b.id)).toEqual(['a'])
    expect(asBlocks(await recentHandle.load()).map(b => b.id).sort()).toEqual(['a'])

    const fired: string[] = []
    const u1 = searchHandle.subscribe(() => { fired.push('search') })
    const u2 = recentHandle.subscribe(() => { fired.push('recent') })
    try {
      const inv0 = invalidations()
      await env.repo.tx(
        tx => tx.move('a', {parentId: 'p2', orderKey: 'a0'}),
        {scope: ChangeScope.BlockDefault},
      )
      // Sound negative proof — the parent move invalidated no handle (pre-dedup).
      expect(invalidations()).toBe(inv0)

      // Control-write fence (liveness): a new block matching both queries DOES fire
      // each handle once; the parent move above must not have fired.
      // (Replaces a 30 ms sleep.)
      await create({id: 'c', content: 'hello again'})
      await vi.waitFor(() => {
        expect(fired).toContain('search')
        expect(fired).toContain('recent')
      })
      expect(fired.length).toBe(2)
    } finally {
      u1(); u2()
    }
  })

  // `recentActivity` is the exception to the rule above: it reports which
  // PAGE an edit happened under, so a parent move changes its answer with
  // no content written anywhere.
  it('recentActivity: a parent move of a listed row invalidates, and re-homes the entry', async () => {
    await create({id: 'p1', content: 'Page one', types: ['page']})
    await create({id: 'p2', content: 'Page two', types: ['page']})
    await create({id: 'a', parentId: 'p1', content: 'a note'})
    const handle = env.repo.query.recentActivity({workspaceId: WS, limit: 10})
    const chainOf = (id: string) =>
      handle.peek()?.find(e => e.block.id === id)?.ancestors.map(b => b.id)
    await handle.load()
    expect(chainOf('a')).toEqual(['p1'])

    const fired: number[] = []
    const unsub = handle.subscribe(() => { fired.push(1) })
    try {
      await env.repo.tx(
        tx => tx.move('a', {parentId: 'p2', orderKey: 'a0'}),
        {scope: ChangeScope.BlockDefault},
      )
      await vi.waitFor(() => {
        expect(fired.length).toBeGreaterThan(0)
        expect(chainOf('a')).toEqual(['p2'])
      })
    } finally {
      unsub()
    }
  })

  it('recentActivity: a move of the PAGE a listed row sits under invalidates too', async () => {
    // Nothing about row `a` changes here — its container moves out from
    // under it, which is why the dep covers the chain, not just the row.
    // `p1` is deliberately empty-content so it is NOT itself a listed row:
    // otherwise its own per-row dep would catch the move and this would
    // pass with the ancestor dep deleted.
    await create({id: 'p1', content: '', types: ['page']})
    await create({id: 'p2', content: 'Page two', types: ['page']})
    await create({id: 'a', parentId: 'p1', content: 'a note'})
    const handle = env.repo.query.recentActivity({workspaceId: WS, limit: 10})
    await handle.load()

    const fired: number[] = []
    const unsub = handle.subscribe(() => { fired.push(1) })
    try {
      await env.repo.tx(
        tx => tx.move('p1', {parentId: 'p2', orderKey: 'a0'}),
        {scope: ChangeScope.BlockDefault},
      )
      await vi.waitFor(() => {
        expect(fired.length).toBeGreaterThan(0)
        expect(handle.peek()?.find(e => e.block.id === 'a')?.ancestors.map(b => b.id))
          .toEqual(['p1', 'p2'])
      })
    } finally {
      unsub()
    }
  })

  it('searchByContent / recentBlocks: non-content property edit on a result row does NOT invalidate', async () => {
    // Same rationale as the parent-move case: editing an unrelated
    // property on a currently-returned row leaves content + liveness
    // unchanged, so the kernel.content channel doesn't fire and the
    // handle should stay quiet. Pre-fix per-row deps fired here for
    // every result row on every property write.
    await create({id: 'a', content: 'hello world'})
    const searchHandle = env.repo.query.searchByContent({workspaceId: WS, query: 'hello'})
    const recentHandle = env.repo.query.recentBlocks({workspaceId: WS, limit: 10})
    expect(asBlocks(await searchHandle.load()).map(b => b.id)).toEqual(['a'])
    expect(asBlocks(await recentHandle.load()).map(b => b.id)).toEqual(['a'])

    const fired: string[] = []
    const u1 = searchHandle.subscribe(() => { fired.push('search') })
    const u2 = recentHandle.subscribe(() => { fired.push('recent') })
    try {
      const inv0 = invalidations()
      await env.repo.tx(
        tx => tx.update('a', {properties: {renderer: 'markdown'}}),
        {scope: ChangeScope.BlockDefault},
      )
      // Sound negative proof — the property edit invalidated no handle (pre-dedup).
      expect(invalidations()).toBe(inv0)

      // Control-write fence (liveness): a new block matching both queries DOES fire
      // each handle once; the non-content property edit above must not
      // have. (Replaces a 30 ms sleep.)
      await create({id: 'c', content: 'hello again'})
      await vi.waitFor(() => {
        expect(fired).toContain('search')
        expect(fired).toContain('recent')
      })
      expect(fired.length).toBe(2)
    } finally {
      u1(); u2()
    }
  })

  it('aliasLookup / aliasMatches / aliasesInWorkspace: alias changes invalidate', async () => {
    await create({id: 'a', aliases: ['greeting']})
    const lookupHandle = env.repo.query.aliasLookup({workspaceId: WS, alias: 'greeting'})
    const matchesHandle = env.repo.query.aliasMatches({workspaceId: WS, filter: ''})
    const distinctHandle = env.repo.query.aliasesInWorkspace({workspaceId: WS})
    expect((await lookupHandle.load())?.id).toBe('a')
    expect((await matchesHandle.load()).map(r => r.alias).sort()).toEqual(['greeting'])
    expect(await distinctHandle.load()).toEqual(['greeting'])

    const fired: string[] = []
    const u1 = lookupHandle.subscribe(() => { fired.push('lookup') })
    const u2 = matchesHandle.subscribe(() => { fired.push('matches') })
    const u3 = distinctHandle.subscribe(() => { fired.push('distinct') })
    try {
      // Adding a new aliased block fires kernel.aliases on the create
      // path (live flip + `hasAlias` true).
      await create({id: 'b', aliases: ['farewell']})
      await vi.waitFor(() => {
        expect(fired).toContain('matches')
        expect(fired).toContain('distinct')
      })
    } finally {
      u1(); u2(); u3()
    }
  })

  it('aliasLookup: a UiState write does NOT invalidate', async () => {
    await create({id: 'a', aliases: ['greeting']})
    await create({id: 'panel'})
    const handle = env.repo.query.aliasLookup({workspaceId: WS, alias: 'greeting'})
    await handle.load()

    const fired: number[] = []
    const unsub = handle.subscribe(() => { fired.push(1) })
    try {
      const inv0 = invalidations()
      await env.repo.tx(
        tx => tx.update('panel', {properties: {focusedBlockLocation: {blockId: 'x', renderScopeId: 'scope:x'}}}),
        {scope: ChangeScope.UiState},
      )
      // Sound negative proof — the UiState write matched no handle (pre-dedup).
      expect(invalidations()).toBe(inv0)

      // Control-write fence (liveness): clearing `a`'s alias DOES change the lookup
      // result; the UiState write above must not have fired. (Replaces a
      // 30 ms sleep.)
      await env.repo.tx(
        tx => tx.update('a', {properties: {[aliasesProp.name]: aliasesProp.codec.encode([])}}),
        {scope: ChangeScope.BlockDefault},
      )
      await vi.waitFor(() => {
        expect(asBlockOrNull(handle.peek())).toBeNull()
      })
      expect(fired.length).toBe(1)
    } finally {
      unsub()
    }
  })

  it('aliasMatches: creating a row with an empty-string alias invalidates (mirrors trigger)', async () => {
    // The block_aliases trigger indexes any text-typed alias entry,
    // including ''. The kernel.aliases rule has to mirror that — if it
    // skipped '' on the liveness branch, the trigger would write a
    // block_aliases row but the handle wouldn't wake.
    const handle = env.repo.query.aliasMatches({workspaceId: WS, filter: ''})
    expect(await handle.load()).toEqual([])

    const fired: number[] = []
    const unsub = handle.subscribe(() => { fired.push(1) })
    try {
      await create({id: 'a', aliases: ['']})
      await vi.waitFor(() => {
        expect(handle.peek()?.map(r => r.alias)).toEqual([''])
      })
      expect(fired.length).toBeGreaterThanOrEqual(1)
    } finally {
      unsub()
    }
  })

  it('aliasMatches: a content edit on a currently-returned alias block invalidates', async () => {
    // aliasMatches returns `{alias, blockId, content}` and bypasses
    // hydrateBlocks, so it has to declare row deps explicitly — without
    // them, kernel.aliases alone would let content edits slip past and
    // the autocomplete preview would stay stale.
    await create({id: 'a', aliases: ['greeting'], content: 'old'})
    const handle = env.repo.query.aliasMatches({workspaceId: WS, filter: ''})
    expect((await handle.load()).map(r => r.content)).toEqual(['old'])

    const fired: number[] = []
    const unsub = handle.subscribe(() => { fired.push(1) })
    try {
      await env.repo.tx(
        tx => tx.update('a', {content: 'new'}),
        {scope: ChangeScope.BlockDefault},
      )
      await vi.waitFor(() => {
        expect(handle.peek()?.map(r => r.content)).toEqual(['new'])
      })
      expect(fired.length).toBeGreaterThanOrEqual(1)
    } finally {
      unsub()
    }
  })

  it('aliasMatches: a non-alias property change on an unrelated block does NOT invalidate', async () => {
    await create({id: 'a', aliases: ['greeting']})
    await create({id: 'b'})
    const handle = env.repo.query.aliasMatches({workspaceId: WS, filter: ''})
    await handle.load()

    const fired: number[] = []
    const unsub = handle.subscribe(() => { fired.push(1) })
    try {
      // Non-alias property edit on a different block — block_aliases
      // index doesn't move, so the alias-keyed handle shouldn't either.
      const inv0 = invalidations()
      await env.repo.tx(
        tx => tx.update('b', {properties: {renderer: 'markdown'}}),
        {scope: ChangeScope.BlockDefault},
      )
      // Sound negative proof — the non-alias edit matched no handle (pre-dedup).
      expect(invalidations()).toBe(inv0)

      // Control-write fence (liveness): a new aliased block DOES enter aliasMatches;
      // the non-alias property edit above must not have fired. (Replaces a
      // 30 ms sleep.)
      await create({id: 'c', aliases: ['farewell']})
      await vi.waitFor(() => {
        expect(handle.peek()?.map(r => r.alias).sort()).toEqual(['farewell', 'greeting'])
      })
      expect(fired.length).toBe(1)
    } finally {
      unsub()
    }
  })

  it('subtree: identity stable across calls (handle-store key)', async () => {
    await create({id: 'r'})
    const a = env.repo.query.subtree({id: 'r'})
    const b = env.repo.query.subtree({id: 'r'})
    expect(a).toBe(b)
  })
})

// ════════════════════════════════════════════════════════════════════
// kernelDataExtension contributes the kernel queries through the runtime
// ════════════════════════════════════════════════════════════════════

describe('kernelDataExtension queriesFacet wiring', () => {
  it('exposes every kernel query through the FacetRuntime', () => {
    const runtime = resolveFacetRuntimeSync(kernelDataExtension)
    const queries = runtime.read(queriesFacet)
    const expected = [
      'core.subtree', 'core.ancestors', 'core.manyAncestors',
      'core.children', 'core.childIds', 'core.byType',
      'core.searchByContent', 'core.recentBlocks',
      'core.firstChildByContent', 'core.aliasesInWorkspace',
      'core.aliasMatches', 'core.aliasLookup', 'core.findExtensionBlocks',
    ]
    for (const name of expected) {
      expect(queries.has(name)).toBe(true)
    }
  })

  it('setFacetRuntime keeps kernel queries dispatchable after replacing the registry', async () => {
    const runtime = resolveFacetRuntimeSync(kernelDataExtension)
    env.repo.setFacetRuntime(runtime)
    await create({id: 'r'})
    const out = asBlocks(await env.repo.query.subtree({id: 'r'}).load())
    expect(out.map(b => b.id)).toEqual(['r'])
  })
})

// ════════════════════════════════════════════════════════════════════
// Plugin-query end-to-end
// ════════════════════════════════════════════════════════════════════

describe('plugin queries via setFacetRuntime', () => {
  it('a plugin-registered query dispatches and invalidates correctly', async () => {
    // Plugin: count tombstones in a workspace. Declares a coarse
    // workspace dep so any workspace write re-runs the resolver.
    interface CountArgs { workspaceId: string }
    const countTombstones = defineQuery<CountArgs, number>({
      name: 'plugin:countTombstones',
      argsSchema: z.object({workspaceId: z.string()}),
      resultSchema: z.number(),
      resolve: async ({workspaceId}, ctx) => {
        ctx.depend({kind: 'workspace', workspaceId})
        const row = await ctx.db.getOptional<{n: number}>(
          'SELECT COUNT(*) AS n FROM blocks WHERE workspace_id = ? AND deleted = 1',
          [workspaceId],
        )
        return row?.n ?? 0
      },
    })

    // Wire kernel + plugin through the runtime so kernel mutators stay
    // available (the test mutates rows via repo.tx).
    const runtime = resolveFacetRuntimeSync([
      kernelDataExtension,
      queriesFacet.of(countTombstones, {source: 'plugin'}),
    ])
    env.repo.setFacetRuntime(runtime)

    await create({id: 'live'})
    await create({id: 'goner'})
    const handle = env.repo.query['plugin:countTombstones']({workspaceId: WS})
    expect(await handle.load()).toBe(0)

    const fired: number[] = []
    const unsub = handle.subscribe((v) => { fired.push(v as number) })
    try {
      await env.repo.tx(tx => tx.delete('goner'), {scope: ChangeScope.BlockDefault})
      await vi.waitFor(() => expect(handle.peek()).toBe(1))
      expect(fired.length).toBeGreaterThanOrEqual(1)
    } finally {
      unsub()
    }
  })
})
