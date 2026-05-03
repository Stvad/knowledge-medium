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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { resolveFacetRuntimeSync } from '@/extensions/facet'
import {
  ChangeScope,
  defineQuery,
  type BlockData,
  type BlockReference,
} from '@/data/api'
import { aliasesProp, typeProp } from '@/data/properties'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { kernelDataExtension } from '../kernelDataExtension'
import { queriesFacet } from '../facets'
import { Repo } from '../repo'

const WS = 'ws-1'
const OTHER_WS = 'ws-2'

interface Harness {
  h: TestDb
  cache: BlockCache
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  const h = await createTestDb()
  const cache = new BlockCache()
  let timeCursor = 1700_000_000_000
  let idCursor = 0
  const repo = new Repo({
    db: h.db,
    cache,
    user: {id: 'user-1'},
    now: () => ++timeCursor,
    newId: () => `gen-${++idCursor}`,
    // Don't register parseReferences — these tests seed `references`
    // directly via `tx.create({references})` and the processor would
    // overwrite that with whatever it parses out of `content`.
    registerKernelProcessors: false,
  })
  return {h, cache, repo}
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

const create = async (args: {
  id: string
  parentId?: string | null
  orderKey?: string
  content?: string
  workspaceId?: string
  aliases?: string[]
  type?: string
  references?: BlockReference[]
}) => {
  const properties: Record<string, unknown> = {}
  if (args.aliases) properties[aliasesProp.name] = aliasesProp.codec.encode(args.aliases)
  if (args.type) properties[typeProp.name] = typeProp.codec.encode(args.type)
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
const asBlockOrNull = (v: BlockData | null | undefined): BlockData | null => v ?? null

// ════════════════════════════════════════════════════════════════════
// Per-query SQL-behavior coverage
// ════════════════════════════════════════════════════════════════════

describe('repo.query.subtree', () => {
  it('returns root + descendants in path order', async () => {
    await create({id: 'r'})
    await create({id: 'c1', parentId: 'r', orderKey: 'a0'})
    await create({id: 'c2', parentId: 'r', orderKey: 'a1'})
    await create({id: 'gc', parentId: 'c1', orderKey: 'a0'})
    const out = asBlocks(await env.repo.query.subtree({id: 'r'}).load())
    expect(out.map(b => b.id)).toEqual(['r', 'c1', 'gc', 'c2'])
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
    await env.repo.query.childIds({id: 'p', hydrate: true}).load()
    expect(env.cache.getSnapshot('c1')?.content).toBe('hello')
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

describe('repo.query.backlinks', () => {
  it('returns blocks whose references include the target id', async () => {
    await create({id: 'target'})
    await create({id: 'src1', references: [{id: 'target', alias: 't'}]})
    await create({id: 'src2', references: [{id: 'target', alias: 't'}]})
    await create({id: 'unrelated'})
    const out = asBlocks(await env.repo.query.backlinks({workspaceId: WS, id: 'target'}).load())
    expect(out.map(r => r.id).sort()).toEqual(['src1', 'src2'])
  })

  it('excludes self-reference', async () => {
    await create({id: 'self', references: [{id: 'self', alias: 'self'}]})
    expect(asBlocks(await env.repo.query.backlinks({workspaceId: WS, id: 'self'}).load())).toEqual([])
  })

  it('excludes soft-deleted source rows', async () => {
    await create({id: 'target'})
    await create({id: 'src', references: [{id: 'target', alias: 't'}]})
    await env.repo.tx(tx => tx.delete('src'), {scope: ChangeScope.BlockDefault})
    expect(asBlocks(await env.repo.query.backlinks({workspaceId: WS, id: 'target'}).load())).toEqual([])
  })

  it('scopes to workspaceId', async () => {
    await create({id: 'target', workspaceId: WS})
    await create({id: 'src-other', workspaceId: OTHER_WS, references: [{id: 'target', alias: 't'}]})
    expect(asBlocks(await env.repo.query.backlinks({workspaceId: WS, id: 'target'}).load())).toEqual([])
    const otherWs = asBlocks(await env.repo.query.backlinks({workspaceId: OTHER_WS, id: 'target'}).load())
    expect(otherWs.map(r => r.id)).toEqual(['src-other'])
  })

  it('returns [] on empty workspaceId or id', async () => {
    expect(asBlocks(await env.repo.query.backlinks({workspaceId: '', id: 'x'}).load())).toEqual([])
    expect(asBlocks(await env.repo.query.backlinks({workspaceId: WS, id: ''}).load())).toEqual([])
  })
})

describe('repo.query.byType', () => {
  it('returns blocks whose type property matches', async () => {
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

describe('repo.query.searchByContent', () => {
  it('matches case-insensitive substring', async () => {
    await create({id: 'a', content: 'Hello World'})
    await create({id: 'b', content: 'goodbye'})
    const out = asBlocks(await env.repo.query.searchByContent({workspaceId: WS, query: 'hello'}).load())
    expect(out.map(r => r.id)).toEqual(['a'])
  })

  it('respects the limit argument', async () => {
    await create({id: 'a', content: 'foo 1'})
    await create({id: 'b', content: 'foo 2'})
    await create({id: 'c', content: 'foo 3'})
    const out = asBlocks(await env.repo.query.searchByContent({workspaceId: WS, query: 'foo', limit: 2}).load())
    expect(out).toHaveLength(2)
  })

  it('returns [] on empty query', async () => {
    await create({id: 'a', content: 'hi'})
    expect(asBlocks(await env.repo.query.searchByContent({workspaceId: WS, query: ''}).load())).toEqual([])
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
  it('returns distinct aliases from all live blocks', async () => {
    await create({id: 'a', aliases: ['Foo', 'Bar']})
    await create({id: 'b', aliases: ['Bar', 'Baz']})
    const out = await env.repo.query.aliasesInWorkspace({workspaceId: WS}).load()
    expect([...out].sort()).toEqual(['Bar', 'Baz', 'Foo'])
  })

  it('filters case-insensitively', async () => {
    await create({id: 'a', aliases: ['Inbox', 'Tasks']})
    const out = await env.repo.query.aliasesInWorkspace({workspaceId: WS, filter: 'IN'}).load()
    expect(out).toEqual(['Inbox'])
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

  it('returns the oldest match on duplicate aliases (deterministic)', async () => {
    await create({id: 'older', aliases: ['Dup']})
    await create({id: 'newer', aliases: ['Dup']})
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
  it('returns blocks whose type property is "extension"', async () => {
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

  it('childIds: row-content edit on a child does NOT invalidate (lean — no row dep)', async () => {
    await create({id: 'p'})
    await create({id: 'c1', parentId: 'p'})
    await create({id: 'c2', parentId: 'p', orderKey: 'a1'})
    // Lean variant: declares ONLY parent-edge on `id`; no per-row deps.
    // (The hydrating variant `{hydrate: true}` calls `hydrateBlocks` and
    // would declare row deps — that path is exercised by `children`.)
    const handle = env.repo.query.childIds({id: 'p'})
    await handle.load()

    const fired: number[] = []
    const unsub = handle.subscribe(() => { fired.push(1) })
    try {
      // Content-only edit on c1 — bumps rowIds in the tx fast path but
      // the lean childIds dep set has no row entry, so `matches` is
      // false and the listener never fires.
      await env.repo.tx(tx => tx.update('c1', {content: 'edited'}), {scope: ChangeScope.BlockDefault})
      await new Promise(r => setTimeout(r, 10))
      expect(fired.length).toBe(0)
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

  it('byType: a new matching row invalidates (workspace dep, coarse)', async () => {
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
      'core.subtree', 'core.ancestors', 'core.children', 'core.childIds',
      'core.backlinks', 'core.byType', 'core.searchByContent',
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
