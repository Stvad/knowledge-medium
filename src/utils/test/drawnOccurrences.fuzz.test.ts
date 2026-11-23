// @vitest-environment node
import fc from 'fast-check'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { childrenViewFacet, surfaceOwnerFacet, type DrawnChild } from '@/data/childrenView'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { outlineSurfaceOf, type OutlineSurface } from '@/data/outlineSurface'
import { isCollapsedProp, type FocusedBlockLocation } from '@/data/properties'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { fuzzParams, fuzzTestTimeout, statefulFuzzGuard } from '@/test/fuzz'
import { getBlocksInRange, lastDrawnStep, nextDrawnStep, previousDrawnStep, selectionBoundaryOf } from '@/utils/selection'

const shape = fc.array(fc.record({
  parent: fc.nat(),
  drawnRank: fc.nat(20),
  inNestedSurface: fc.boolean(),
  collapsed: fc.boolean(),
  projects: fc.boolean(),
  sharedRoot: fc.constantFrom('owner', 'foreign-page', 'individual'),
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
    const external = input.length + 1
    const note = external + 1
    const tail = note + 1
    const dataParent = new Map<string, string | null>([
      [rootId, null], ['foreign-page', null], [idOf(external), 'foreign-page'],
      [idOf(note), idOf(external)], [idOf(tail), rootId],
    ])
    const children = Array.from({length: tail + 1}, (): number[] => [])
    input.forEach(({parent}, index) => {
      const owner = parent % (index + 1)
      children[owner]!.push(index + 1)
      dataParent.set(idOf(index + 1), idOf(owner))
    })
    children[external]!.push(note)

    type Occurrence = {index: number; scope: OutlineSurface; boundary: FocusedBlockLocation | null}
    const views = new Map<string, DrawnChild[]>()
    const owners = new Map<string, {blockId: string; surface: OutlineSurface}>()
    const expected: Occurrence[] = []

    // The renderer places data children and projections in preorder. Independently
    // encode the same placements into the plugin's grouped member lists below.
    const render = (index: number, scope: OutlineSurface, boundary: Occurrence['boundary']) => {
      const id = idOf(index)
      expected.push({index, scope, boundary})
      const row = input[index - 1]
      if (row?.collapsed) return
      const ordered = [...children[index]!].sort((a, b) => input[a - 1]!.drawnRank - input[b - 1]!.drawnRank)
      const nested = ordered.filter(child => input[child - 1]?.inNestedSurface)
      // The same foreign row and its note appear in distinct scopes.
      if (index === 0 || index === 1 || row?.projects) {
        nested.splice((row?.drawnRank ?? 0) % (nested.length + 1), 0, external)
      }
      const positions = ordered.filter(child => !nested.includes(child)).map(child => [child])
      const groupStart = ordered.findIndex(child => nested.includes(child))
      if (nested.length) positions.splice(groupStart < 0 ? positions.length : groupStart, 0, nested)
      if (index === 0) positions.push([tail])
      const renderScopeId = `surface:${id}`
      const sharedRoot = (row ?? input[0])!.sharedRoot
      const scopeRootId = sharedRoot === 'owner' ? id : sharedRoot === 'foreign-page' ? 'foreign-page' : undefined

      for (const group of positions) {
        for (const child of group) {
          if (group !== nested) {
            render(child, scope, boundary)
            continue
          }
          const blockId = idOf(child)
          const shared = sharedRoot === 'owner' && dataParent.get(blockId) === id
          const memberScope = {...scope, renderScopeId, scopeRootForcesOpen: false, scopeRootId: shared ? id : blockId}
          render(child, memberScope, shared ? boundary : {blockId, renderScopeId})
        }
      }

      views.set(id, positions.flatMap((group): DrawnChild[] => group === nested
        ? [{kind: 'nested-surface', renderScopeId, scopeRootId, members: group.map(idOf)}]
        : group.map(idOf)))
      if (nested.length) owners.set(renderScopeId, {blockId: id, surface: scope})
    }
    render(0, panel, null)

    repo.setFacetRuntime(resolveFacetRuntimeSync([
      kernelDataExtension,
      childrenViewFacet.of(({parent}) => ({
        id: 'test.drawnOccurrences',
        read: () => ({load: async () => views.get(parent.id) ?? []}),
      }), {source: 'test'}),
      surfaceOwnerFacet.of(({renderScopeId}) => owners.get(renderScopeId) ?? null, {source: 'test'}),
    ]))
    repo.setActiveWorkspaceId(workspaceId)
    await repo.tx(async tx => {
      for (const [id, parentId] of dataParent) {
        await tx.create({id, workspaceId, parentId, orderKey: 'a0'})
      }
      for (const [index, node] of input.entries()) {
        if (node.collapsed) await tx.setProperty(idOf(index + 1), isCollapsedProp, true)
      }
    }, {scope: ChangeScope.BlockDefault})

    const walk = async (direction: 'forward' | 'backward') => {
      const forward = direction === 'forward'
      const step = forward ? nextDrawnStep : previousDrawnStep
      const order = forward ? expected : [...expected].reverse()
      let at = forward ? {block: repo.block(rootId), surface: panel} : await lastDrawnStep(repo.block(rootId), panel)
      for (const [index, occurrence] of order.entries()) {
        expect(at.block.id).toEqual(idOf(occurrence.index))
        expect(at.surface).toEqual(occurrence.scope)
        expect(await selectionBoundaryOf(at.block, at.surface.renderScopeId)).toEqual(occurrence.boundary)
        const next = await step(at.block, at.surface)
        const destination = order[index + 1]
        if (!destination) {
          expect(next.block).toBeNull()
          break
        }
        expect(next.crossed).toBe(
          occurrence.scope.renderScopeId !== destination.scope.renderScopeId || occurrence.boundary !== destination.boundary,
        )
        expect(next.block).not.toBeNull()
        at = {block: next.block!, surface: next.surface}
      }
    }

    await walk('forward')
    await walk('backward')

    // Range membership depends on stored ancestry and the two endpoint
    // boundaries. A selected ancestor subsumes its descendants.
    const checkRange = async (start: number, end: number) => {
      const from = expected[start]!
      const to = expected[end]!
      const span = expected.slice(Math.min(start, end), Math.max(start, end) + 1)
      const ids = new Set(span.filter(each => each.boundary === from.boundary).map(each => idOf(each.index)))
      const topLevel = [...ids].filter(id => {
        for (let parent = dataParent.get(id); parent; parent = dataParent.get(parent)) {
          if (ids.has(parent)) return false
        }
        return true
      })
      expect(await getBlocksInRange(idOf(from.index), idOf(to.index), from.scope, repo, to.scope.renderScopeId))
        .toEqual(from.boundary === to.boundary ? topLevel : [])
    }
    await checkRange(1, expected.length - 1)
    const copies = expected.flatMap((each, index) => each.index === external ? [index] : [])
    await checkRange(copies[0]!, expected.length - 1)
    await checkRange(copies[0]!, copies.at(-1)!)
    await checkRange(input[0]!.parent % expected.length, input[1]!.parent % expected.length)
  })), fuzzParams(18))
}, fuzzTestTimeout())
