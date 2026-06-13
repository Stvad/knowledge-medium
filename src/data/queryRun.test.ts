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
import { ChangeScope, defineQuery } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { queriesFacet } from '@/data/facets'
import { Repo } from '@/data/repo'

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
})
