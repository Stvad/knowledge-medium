/**
 * A children view a plugin contributes is the list every "as drawn" gesture
 * reads, on the surface it answers for and nowhere else.
 *
 *   page
 *     owner      in scope `elsewhere` draws [c, a]; in scope `bare`, nothing
 *       a
 *       b
 *       c
 *     other
 *       x
 *     after
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ChangeScope, defineQuery, type User } from '@/data/api'
import { childrenViewFacet } from '@/data/childrenView'
import { queriesFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { outlineSurfaceOf } from '@/data/outlineSurface'
import type { PropertyDisplayScopeLevels } from '@/data/propertyDisplayMode'
import type { Repo } from '@/data/repo'
import { structuralEditPolicyForBlock } from '@/data/structuralEditPolicy'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { visibleChildIds } from '@/data/visibleChildren'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { bothShowIndependentChildren } from '@/shortcuts/blockMergeGesture'
import { getLastVisibleDescendant, nextVisibleBlock, previousVisibleBlock } from '@/utils/selection'

const USER: User = {id: 'user-1', name: 'Alice'}
const WS = 'ws-children-view'
const DISPLAY: PropertyDisplayScopeLevels = {childBacked: true, workspace: 'none', panel: 'inherit'}
const IDS_QUERY = 'test.ids'

declare module '@/data/api' {
  interface QueryRegistry {
    [IDS_QUERY]: typeof idsQuery
  }
}

const idsQuery = defineQuery<{ids: string[]}, string[]>({
  name: IDS_QUERY,
  argsSchema: z.object({ids: z.array(z.string())}),
  resultSchema: z.array(z.string()),
  resolve: async ({ids}) => ids,
})

/** What `owner` draws, by render scope. */
const DRAWN: Record<string, string[]> = {elsewhere: ['c', 'a'], bare: []}

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: USER}).repo
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    queriesFacet.of(idsQuery, {source: 'test'}),
    childrenViewFacet.of(({parent, surface}) => {
      const ids = parent.id === 'owner' && surface.renderScopeId !== undefined ? DRAWN[surface.renderScopeId] : undefined
      return ids && {id: 'test.drawn', read: () => parent.repo.query[IDS_QUERY]({ids})}
    }, {source: 'test'}),
  ]))
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'page'})
    await tx.create({id: 'owner', workspaceId: WS, parentId: 'page', orderKey: 'a0', content: 'owner'})
    await tx.create({id: 'a', workspaceId: WS, parentId: 'owner', orderKey: 'a0', content: 'a'})
    await tx.create({id: 'b', workspaceId: WS, parentId: 'owner', orderKey: 'a1', content: 'b'})
    await tx.create({id: 'c', workspaceId: WS, parentId: 'owner', orderKey: 'a2', content: 'c'})
    await tx.create({id: 'other', workspaceId: WS, parentId: 'page', orderKey: 'a1', content: 'other'})
    await tx.create({id: 'x', workspaceId: WS, parentId: 'other', orderKey: 'a0', content: 'x'})
    await tx.create({id: 'after', workspaceId: WS, parentId: 'page', orderKey: 'a2', content: 'after'})
  }, {scope: ChangeScope.BlockDefault})
})

const surfaceIn = (renderScopeId: string) =>
  outlineSurfaceOf({scopeRootId: 'page', propertyDisplay: DISPLAY, renderScopeId})!

const walk = async (from: string, renderScopeId: string, step: typeof nextVisibleBlock) => {
  const ids: string[] = []
  for (let at = await step(repo.block(from), surfaceIn(renderScopeId)); at; at = await step(at, surfaceIn(renderScopeId))) {
    ids.push(at.id)
  }
  return ids
}

describe('childrenViewFacet', () => {
  it('is the order the walkers take on the surface it answers for, both ways', async () => {
    expect(await visibleChildIds(repo.block('owner'), surfaceIn('elsewhere'))).toEqual(['c', 'a'])
    expect(await walk('page', 'elsewhere', nextVisibleBlock)).toEqual(['owner', 'c', 'a', 'other', 'x', 'after'])
    expect(await walk('after', 'elsewhere', previousVisibleBlock)).toEqual(['x', 'other', 'a', 'c', 'owner', 'page'])
    expect((await getLastVisibleDescendant(repo.block('owner'), surfaceIn('elsewhere'))).id).toBe('a')
  })

  it('leaves every other surface on the property-display default', async () => {
    expect(await walk('page', 'outline', nextVisibleBlock)).toEqual(['owner', 'a', 'b', 'c', 'other', 'x', 'after'])
  })

  it('decides whether a block shows children for the edit policy and the merge rule', async () => {
    const owner = repo.block('owner')
    const carrier = {scopeRootId: 'page', propertyDisplay: DISPLAY}
    expect((await structuralEditPolicyForBlock(owner, {...carrier, renderScopeId: 'bare'})).createBelowPlacement).toBe('sibling-below')
    expect((await structuralEditPolicyForBlock(owner, {...carrier, renderScopeId: 'outline'})).createBelowPlacement).toBe('child-first')
    expect(await bothShowIndependentChildren({into: repo.block('other'), from: owner}, surfaceIn('bare'))).toBe(false)
    expect(await bothShowIndependentChildren({into: repo.block('other'), from: owner}, surfaceIn('outline'))).toBe(true)
  })
})
