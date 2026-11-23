// @vitest-environment node
import fc from 'fast-check'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { z } from 'zod'
import { ChangeScope, defineQuery } from '@/data/api'
import { childrenViewFacet, surfaceOwnerFacet, type DrawnChild } from '@/data/childrenView'
import { queriesFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { outlineSurfaceOf, type OutlineSurface } from '@/data/outlineSurface'
import { isCollapsedProp } from '@/data/properties'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { fuzzParams, fuzzTestTimeout, statefulFuzzGuard } from '@/test/fuzz'
import { lastDrawnStep, nextDrawnStep, previousDrawnStep } from '@/utils/selection'

const MEMBERS = 'test.drawnOccurrences'

declare module '@/data/api' {
  interface QueryRegistry {
    [MEMBERS]: typeof membersQuery
  }
}

const membersQuery = defineQuery<{id: string; members: DrawnChild[]}, DrawnChild[]>({
  name: MEMBERS,
  argsSchema: z.object({
    id: z.string(),
    members: z.array(z.union([
      z.string(),
      z.object({kind: z.literal('nested-surface'), renderScopeId: z.string(), members: z.array(z.string())}),
    ])),
  }),
  resultSchema: {parse: input => input as DrawnChild[]},
  resolve: async ({members}) => members,
})

const shape = fc.array(fc.record({
  parent: fc.nat(),
  drawnRank: fc.nat(20),
  inNestedSurface: fc.boolean(),
  collapsed: fc.boolean(),
}), {minLength: 3, maxLength: 18})

const idOf = (index: number) => `block-${index}`

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
const guard = statefulFuzzGuard()

it('walks the exact rendered occurrences forward and backward through nested surfaces', async () => {
  await fc.assert(fc.asyncProperty(shape, input => guard.run(null, async () => {
    await resetTestDb(sharedDb.db)
    const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
    const workspaceId = 'workspace'
    const rootId = idOf(0)
    const panel = outlineSurfaceOf({scopeRootId: rootId, renderScopeId: 'panel'})!
    const children = Array.from({length: input.length + 1}, (): number[] => [])
    input.forEach(({parent}, index) => children[parent % (index + 1)]!.push(index + 1))

    const views = new Map<string, DrawnChild[]>()
    const owners = new Map<string, {blockId: string; surface: OutlineSurface}>()
    const expected: {id: string; renderScopeId: string | undefined; scopeRootId: string}[] = []

    // Render the generated tree into one occurrence list. Each group of
    // marked siblings is drawn under the same wrapper, at the first mark.
    const render = (index: number, surface: OutlineSurface) => {
      const id = idOf(index)
      const ordered = [...children[index]!].sort((a, b) => input[a - 1]!.drawnRank - input[b - 1]!.drawnRank)
      const nested = ordered.filter(child => input[child - 1]!.inNestedSurface)
      const firstNested = nested[0]
      const nestedScope = `surface:${id}`
      const members: DrawnChild[] = []
      views.set(id, members)
      expected.push({id, renderScopeId: surface.renderScopeId, scopeRootId: surface.scopeRootId})
      if (index !== 0 && input[index - 1]!.collapsed) return
      for (const child of ordered) {
        if (child === firstNested) {
          members.push({kind: 'nested-surface', renderScopeId: nestedScope, members: nested.map(idOf)})
          owners.set(nestedScope, {blockId: id, surface})
          for (const row of nested) {
            render(row, {...surface, renderScopeId: nestedScope, scopeRootId: idOf(row), scopeRootForcesOpen: false})
          }
        } else if (!input[child - 1]!.inNestedSurface) {
          members.push(idOf(child))
          render(child, surface)
        }
      }
    }
    render(0, panel)

    repo.setFacetRuntime(resolveFacetRuntimeSync([
      kernelDataExtension,
      queriesFacet.of(membersQuery, {source: 'test'}),
      childrenViewFacet.of(({parent}) => ({
        id: MEMBERS,
        read: () => parent.repo.query[MEMBERS]({id: parent.id, members: views.get(parent.id) ?? []}),
      }), {source: 'test'}),
      surfaceOwnerFacet.of(({renderScopeId}) => owners.get(renderScopeId) ?? null, {source: 'test'}),
    ]))
    repo.setActiveWorkspaceId(workspaceId)
    await repo.tx(async tx => {
      await tx.create({id: rootId, workspaceId, parentId: null, orderKey: 'a0'})
      for (const [index, node] of input.entries()) {
        const id = idOf(index + 1)
        await tx.create({id, workspaceId, parentId: idOf(node.parent % (index + 1)), orderKey: `a${String.fromCharCode(65 + index)}`})
        if (node.collapsed) await tx.setProperty(id, isCollapsedProp, true)
      }
    }, {scope: ChangeScope.BlockDefault})

    const walk = async (direction: 'forward' | 'backward') => {
      const forward = direction === 'forward'
      const step = forward ? nextDrawnStep : previousDrawnStep
      const order = forward ? expected : [...expected].reverse()
      let at = forward ? {block: repo.block(rootId), surface: panel} : await lastDrawnStep(repo.block(rootId), panel)
      for (const [index, occurrence] of order.entries()) {
        expect({id: at.block.id, renderScopeId: at.surface.renderScopeId, scopeRootId: at.surface.scopeRootId}).toEqual(occurrence)
        const next = await step(at.block, at.surface)
        const destination = order[index + 1]
        if (!destination) {
          expect(next.block).toBeNull()
          break
        }
        expect(next.crossed).toBe(
          occurrence.renderScopeId !== destination.renderScopeId || occurrence.scopeRootId !== destination.scopeRootId,
        )
        expect(next.block).not.toBeNull()
        at = {block: next.block!, surface: next.surface}
      }
    }

    await walk('forward')
    await walk('backward')
  })), fuzzParams(18))
}, fuzzTestTimeout())
