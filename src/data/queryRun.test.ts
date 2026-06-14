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
    // Same outer instance across both swaps — only the helper changes, so
    // the outer's generation never bumps on its own account. The
    // composition graph bumps it because it composes the swapped helper, so
    // a *fresh* lookup re-keys to the new snapshot.
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
      // A fresh lookup re-keys (the outer's generation bumped because it
      // composes the swapped helper) → a new handle over the new snapshot.
      const v2Handle = repo.query['plugin:composedOuter']({tag: 'a'})
      expect(v2Handle).not.toBe(v1Handle)
      expect(await v2Handle.load()).toBe('v2:a')
    } finally {
      unsub()
    }
  })

  it('snapshots transitively through deps:none: swapping the deepest query re-keys the root', async () => {
    // outer --(deps:'none')--> helper --(inherit)--> nested.
    // The child→root composition edge is recorded regardless of the deps
    // mode, so swapping only the deepest query bumps the root's generation
    // and a fresh lookup gets the fully-new snapshot, while the old handle
    // keeps its captured one.
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
})
