// @vitest-environment node
/**
 * `QueryCtx.run` — composing a registered query inline, in the calling
 * resolver's dependency scope (no separate handle). Pins the two dep
 * modes:
 *   - `inherit` (default): the sub-query's declared deps fold onto the
 *     calling handle, so the composed result stays fresh.
 *   - `none`: the sub-query's deps are dropped; only the caller's own
 *     declared deps drive re-resolution.
 *
 * Both queries below compose `core.subtree` and sum descendant content
 * length, so a descendant content edit changes the value iff the handle
 * re-resolves — which is exactly what the dep mode controls.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { ChangeScope, defineQuery, type Query } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { queriesFacet } from '@/data/facets'
import { Repo } from '@/data/repo'

// Typed name for the composed helper the swap test exercises.
declare module '@/data/api' {
  interface QueryRegistry {
    'plugin:composedHelper': Query<{tag: string}, string>
    'plugin:composedNested': Query<{tag: string}, string>
  }
}

const WS = 'ws-1'

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = new Repo({
    db: sharedDb.db,
    cache: new BlockCache(),
    user: {id: 'user-1'},
    registerKernelProcessors: false,
  })
})
afterEach(() => { repo.stopSyncObserver() })

const create = (id: string, content: string, parentId: string | null) =>
  repo.tx(tx => tx.create({
    id, workspaceId: WS, parentId, orderKey: 'a0', content, properties: {}, references: [],
  }), {scope: ChangeScope.BlockDefault})

const setContent = (id: string, content: string) =>
  repo.tx(tx => tx.update(id, {content}), {scope: ChangeScope.BlockDefault})

// r('aaaa') → c('bbb') → gc('cc'), total content length 4+3+2 = 9.
const seedTree = async () => {
  await create('r', 'aaaa', null)
  await create('c', 'bbb', 'r')
  await create('gc', 'cc', 'c')
}

describe('QueryCtx.run', () => {
  it('inherit (default): folds the sub-query deps onto the calling handle', async () => {
    let resolves = 0
    const subtreeLen = defineQuery<{id: string}, number>({
      name: 'plugin:subtreeLenInherit',
      argsSchema: z.object({id: z.string()}),
      resultSchema: z.number(),
      resolve: async ({id}, ctx) => {
        resolves++
        const blocks = await ctx.run('core.subtree', {id})
        return blocks.reduce((n, b) => n + b.content.length, 0)
      },
    })
    repo.setFacetRuntime(resolveFacetRuntimeSync([
      kernelDataExtension,
      queriesFacet.of(subtreeLen, {source: 'plugin'}),
    ]))
    await seedTree()

    const handle = repo.query['plugin:subtreeLenInherit']({id: 'r'})
    expect(await handle.load()).toBe(9)

    const unsub = handle.subscribe(() => {})
    try {
      // Editing a grandchild's content is a `row:gc` dep that core.subtree
      // declares — with inherit it folded onto this handle, so the value
      // re-resolves to the new total.
      await setContent('gc', 'ccccc') // 2 → 5, total 9 → 12
      await vi.waitFor(() => expect(handle.peek()).toBe(12))
      expect(resolves).toBeGreaterThan(1)
    } finally {
      unsub()
    }
  })

  it('none: drops the sub-query deps; only the caller\'s own dep re-resolves', async () => {
    let resolves = 0
    const subtreeLen = defineQuery<{id: string}, number>({
      name: 'plugin:subtreeLenNone',
      argsSchema: z.object({id: z.string()}),
      resultSchema: z.number(),
      resolve: async ({id}, ctx) => {
        resolves++
        // Narrow, deliberate sensitivity: re-resolve only on the root row.
        ctx.depend({kind: 'row', id})
        const blocks = await ctx.run('core.subtree', {id}, {deps: 'none'})
        return blocks.reduce((n, b) => n + b.content.length, 0)
      },
    })
    repo.setFacetRuntime(resolveFacetRuntimeSync([
      kernelDataExtension,
      queriesFacet.of(subtreeLen, {source: 'plugin'}),
    ]))
    await seedTree()

    const handle = repo.query['plugin:subtreeLenNone']({id: 'r'})
    expect(await handle.load()).toBe(9)
    expect(resolves).toBe(1)

    const unsub = handle.subscribe(() => {})
    try {
      // Grandchild content edit: core.subtree would declare row:gc, but
      // deps:'none' dropped it — so this must NOT re-resolve.
      await setContent('gc', 'cccccc') // 2 → 6 (not yet reflected)
      // Tracer: edit the root, which IS the caller's declared dep.
      await setContent('r', 'aaaaaa') // 4 → 6 → re-resolve
      // After the tracer re-resolve the resolver reads live DB, so it now
      // sees both edits: 6 + 3 + 6 = 15.
      await vi.waitFor(() => expect(handle.peek()).toBe(15))
      // Exactly one re-resolve (the tracer). If the gc edit had folded a
      // dep, this would be 3.
      expect(resolves).toBe(2)
    } finally {
      unsub()
    }
  })

  it('snapshots a helper swap: the old handle keeps its version; a fresh lookup gets the new one', async () => {
    const makeHelper = (marker: string) =>
      defineQuery<{tag: string}, string>({
        name: 'plugin:composedHelper',
        argsSchema: z.object({tag: z.string()}),
        resultSchema: z.string(),
        resolve: async ({tag}) => `${marker}:${tag}`,
      })
    // Same outer instance across both swaps — only the helper changes. The
    // swap bumps the global epoch, so a *fresh* lookup re-keys to a new
    // handle over the new registry while the held handle keeps its snapshot.
    const outer = defineQuery<{tag: string}, string>({
      name: 'plugin:composedOuter',
      argsSchema: z.object({tag: z.string()}),
      resultSchema: z.string(),
      resolve: async ({tag}, ctx) => ctx.run('plugin:composedHelper', {tag}),
    })

    repo.__setQueriesForTesting([makeHelper('v1'), outer])
    const v1Handle = repo.query['plugin:composedOuter']({tag: 'a'})
    expect(await v1Handle.load()).toBe('v1:a')

    const unsub = v1Handle.subscribe(() => {})
    try {
      repo.__setQueriesForTesting([makeHelper('v2'), outer])
      // The already-subscribed handle is a consistent snapshot — it keeps
      // serving v1 and is NOT live-migrated to the new helper.
      expect(v1Handle.peek()).toBe('v1:a')
      // A fresh lookup re-keys (the swap bumped the global epoch) → a new
      // handle over the new snapshot.
      const v2Handle = repo.query['plugin:composedOuter']({tag: 'a'})
      expect(v2Handle).not.toBe(v1Handle)
      expect(await v2Handle.load()).toBe('v2:a')
    } finally {
      unsub()
    }
  })

  it('snapshots transitively through deps:none: swapping the deepest query re-keys the root', async () => {
    // outer --(deps:'none')--> helper --(inherit)--> nested. A swap bumps
    // the global epoch, so a fresh lookup re-keys to the fully-new snapshot
    // regardless of the deps mode, while the held handle keeps its old one.
    const makeNested = (marker: string) =>
      defineQuery<{tag: string}, string>({
        name: 'plugin:composedNested',
        argsSchema: z.object({tag: z.string()}),
        resultSchema: z.string(),
        resolve: async ({tag}) => `${marker}:${tag}`,
      })
    const helper = defineQuery<{tag: string}, string>({
      name: 'plugin:composedHelper',
      argsSchema: z.object({tag: z.string()}),
      resultSchema: z.string(),
      resolve: async ({tag}, ctx) => ctx.run('plugin:composedNested', {tag}),
    })
    const outer = defineQuery<{tag: string}, string>({
      name: 'plugin:composedOuter',
      argsSchema: z.object({tag: z.string()}),
      resultSchema: z.string(),
      resolve: async ({tag}, ctx) =>
        ctx.run('plugin:composedHelper', {tag}, {deps: 'none'}),
    })

    repo.__setQueriesForTesting([makeNested('v1'), helper, outer])
    const v1Handle = repo.query['plugin:composedOuter']({tag: 'a'})
    expect(await v1Handle.load()).toBe('v1:a')

    const unsub = v1Handle.subscribe(() => {})
    try {
      // Only the deepest (nested) query instance changes.
      repo.__setQueriesForTesting([makeNested('v2'), helper, outer])
      expect(v1Handle.peek()).toBe('v1:a')
      const v2Handle = repo.query['plugin:composedOuter']({tag: 'a'})
      expect(v2Handle).not.toBe(v1Handle)
      expect(await v2Handle.load()).toBe('v2:a')
    } finally {
      unsub()
    }
  })

  it('a never-loaded (idle) handle does not leak its pre-swap snapshot to a fresh lookup', async () => {
    // The old composition-graph scheme recorded edges only during resolve,
    // so a handle created but never loaded before a helper swap left the
    // outer's key un-bumped and a fresh lookup reused the stale handle. The
    // global epoch re-keys regardless of whether the handle ever ran.
    const makeHelper = (marker: string) =>
      defineQuery<{tag: string}, string>({
        name: 'plugin:composedHelper',
        argsSchema: z.object({tag: z.string()}),
        resultSchema: z.string(),
        resolve: async ({tag}) => `${marker}:${tag}`,
      })
    const outer = defineQuery<{tag: string}, string>({
      name: 'plugin:composedOuter',
      argsSchema: z.object({tag: z.string()}),
      resultSchema: z.string(),
      resolve: async ({tag}, ctx) => ctx.run('plugin:composedHelper', {tag}),
    })

    repo.__setQueriesForTesting([makeHelper('v1'), outer])
    // Create the handle but never load or subscribe it.
    const idle = repo.query['plugin:composedOuter']({tag: 'a'})

    repo.__setQueriesForTesting([makeHelper('v2'), outer])
    const fresh = repo.query['plugin:composedOuter']({tag: 'a'})
    expect(fresh).not.toBe(idle)
    expect(await fresh.load()).toBe('v2:a')
  })

  it('swapping BOTH an outer and its helper yields a consistent new snapshot (no version mixing)', async () => {
    const makeHelper = (marker: string) =>
      defineQuery<{tag: string}, string>({
        name: 'plugin:composedHelper',
        argsSchema: z.object({tag: z.string()}),
        resultSchema: z.string(),
        resolve: async ({tag}) => `${marker}:${tag}`,
      })
    const makeOuter = (marker: string) =>
      defineQuery<{tag: string}, string>({
        name: 'plugin:composedOuter',
        argsSchema: z.object({tag: z.string()}),
        resultSchema: z.string(),
        resolve: async ({tag}, ctx) =>
          `${marker}(${await ctx.run('plugin:composedHelper', {tag})})`,
      })

    repo.__setQueriesForTesting([makeHelper('h1'), makeOuter('o1')])
    const v1Handle = repo.query['plugin:composedOuter']({tag: 'a'})
    expect(await v1Handle.load()).toBe('o1(h1:a)')

    const unsub = v1Handle.subscribe(() => {})
    try {
      repo.__setQueriesForTesting([makeHelper('h2'), makeOuter('o2')])
      // Held handle keeps its fully-old snapshot — never o1(h2:a) / o2(h1:a).
      expect(v1Handle.peek()).toBe('o1(h1:a)')
      // Fresh lookup is fully-new and consistent.
      const v2Handle = repo.query['plugin:composedOuter']({tag: 'a'})
      expect(v2Handle).not.toBe(v1Handle)
      expect(await v2Handle.load()).toBe('o2(h2:a)')
    } finally {
      unsub()
    }
  })

  it('a fresh lookup sees a swapped branch the handle never composed before the swap', async () => {
    // condRoot composes branch A or branch B depending on block x. It
    // resolves A first (B is never observed), then B is swapped while x
    // still selects A. After x flips to B, a fresh lookup must see the NEW
    // B — a graph that only recorded observed edges would miss this.
    const branchA = defineQuery<{tag: string}, string>({
      name: 'plugin:composedHelper',
      argsSchema: z.object({tag: z.string()}),
      resultSchema: z.string(),
      resolve: async ({tag}) => `A:${tag}`,
    })
    const makeBranchB = (marker: string) =>
      defineQuery<{tag: string}, string>({
        name: 'plugin:composedNested',
        argsSchema: z.object({tag: z.string()}),
        resultSchema: z.string(),
        resolve: async ({tag}) => `${marker}:${tag}`,
      })
    const condRoot = defineQuery<{tag: string}, string>({
      name: 'plugin:composedOuter',
      argsSchema: z.object({tag: z.string()}),
      resultSchema: z.string(),
      resolve: async ({tag}, ctx) => {
        const [x] = await ctx.run('core.subtree', {id: 'x'})
        return x?.content === 'b'
          ? ctx.run('plugin:composedNested', {tag})
          : ctx.run('plugin:composedHelper', {tag})
      },
    })
    // Use setFacetRuntime (not __setQueriesForTesting) so `core.subtree` is
    // available; only branch B's instance changes between installs.
    const install = (branchB: Query<{tag: string}, string>) =>
      repo.setFacetRuntime(resolveFacetRuntimeSync([
        kernelDataExtension,
        queriesFacet.of(branchA, {source: 'plugin'}),
        queriesFacet.of(branchB, {source: 'plugin'}),
        queriesFacet.of(condRoot, {source: 'plugin'}),
      ]))

    install(makeBranchB('B1'))
    await create('x', 'a', null)
    const v1Handle = repo.query['plugin:composedOuter']({tag: 't'})
    expect(await v1Handle.load()).toBe('A:t')

    const unsub = v1Handle.subscribe(() => {})
    try {
      // Swap only branch B (never composed yet), then steer x to branch B.
      install(makeBranchB('B2'))
      await setContent('x', 'b')
      // Held handle re-resolves on the data change but against ITS captured
      // registry → intentionally the old B1 (immutable-handle rule).
      await vi.waitFor(() => expect(v1Handle.peek()).toBe('B1:t'))
      // A fresh lookup re-keys to the new epoch → the swapped B2.
      const fresh = repo.query['plugin:composedOuter']({tag: 't'})
      expect(fresh).not.toBe(v1Handle)
      expect(await fresh.load()).toBe('B2:t')
    } finally {
      unsub()
    }
  })

  it('a no-op swap (same instances) does not bump the epoch — handle slot survives', () => {
    const helper = defineQuery<{tag: string}, string>({
      name: 'plugin:composedHelper',
      argsSchema: z.object({tag: z.string()}),
      resultSchema: z.string(),
      resolve: async ({tag}) => `v:${tag}`,
    })
    const outer = defineQuery<{tag: string}, string>({
      name: 'plugin:composedOuter',
      argsSchema: z.object({tag: z.string()}),
      resultSchema: z.string(),
      resolve: async ({tag}, ctx) => ctx.run('plugin:composedHelper', {tag}),
    })
    repo.__setQueriesForTesting([helper, outer])
    const h1 = repo.query['plugin:composedOuter']({tag: 'a'})
    // Re-install the SAME instances → registry unchanged → no epoch bump,
    // so a cached handle survives a setFacetRuntime that didn't touch it.
    repo.__setQueriesForTesting([helper, outer])
    expect(repo.query['plugin:composedOuter']({tag: 'a'})).toBe(h1)
  })

  it('an additive swap (new name only) does NOT re-key existing queries', () => {
    const a = defineQuery<{tag: string}, string>({
      name: 'plugin:composedHelper',
      argsSchema: z.object({tag: z.string()}),
      resultSchema: z.string(),
      resolve: async ({tag}) => `a:${tag}`,
    })
    const b = defineQuery<{tag: string}, string>({
      name: 'plugin:composedNested',
      argsSchema: z.object({tag: z.string()}),
      resultSchema: z.string(),
      resolve: async ({tag}) => `b:${tag}`,
    })
    repo.__setQueriesForTesting([a])
    const aHandle = repo.query['plugin:composedHelper']({tag: 'x'})
    // Purely additive: `a`'s instance is untouched, only a new name appears.
    // It cannot invalidate `a`'s snapshot, so the epoch must NOT bump and
    // `a`'s handle survives — this is the cold-start base→next shape that
    // must not re-resolve the visible tree's unchanged kernel queries.
    repo.__setQueriesForTesting([a, b])
    expect(repo.query['plugin:composedHelper']({tag: 'x'})).toBe(aHandle)
  })

  it('a mutating swap (replace/remove) re-keys even an unrelated query', () => {
    const a = defineQuery<{tag: string}, string>({
      name: 'plugin:composedHelper',
      argsSchema: z.object({tag: z.string()}),
      resultSchema: z.string(),
      resolve: async ({tag}) => `a:${tag}`,
    })
    const makeB = (marker: string) =>
      defineQuery<{tag: string}, string>({
        name: 'plugin:composedNested',
        argsSchema: z.object({tag: z.string()}),
        resultSchema: z.string(),
        resolve: async ({tag}) => `${marker}:${tag}`,
      })
    repo.__setQueriesForTesting([a, makeB('b1')])
    const aHandle = repo.query['plugin:composedHelper']({tag: 'x'})
    // REPLACE B's instance; A is untouched and composes nothing — yet A
    // re-keys too, because a replace bumps the global epoch. This pins the
    // deliberate correctness-over-precision tradeoff: a same-handle result
    // here would mean someone reintroduced a per-name scheme (which
    // under-invalidates composed queries — see the idle/conditional cases).
    repo.__setQueriesForTesting([a, makeB('b2')])
    expect(repo.query['plugin:composedHelper']({tag: 'x'})).not.toBe(aHandle)
  })
})
