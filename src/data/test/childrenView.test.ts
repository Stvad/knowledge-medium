/**
 * A children view a plugin contributes is the list every "as drawn" gesture
 * reads, on the surface it answers for and nowhere else.
 *
 *   page
 *     owner      (drawn in scope `elsewhere` with `lent`'s children)
 *       a
 *     lent
 *       x
 *       y
 *     empty
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { childrenViewFacet, type ChildrenView } from '@/data/childrenView'
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
import { getLastVisibleDescendant, nextVisibleBlock } from '@/utils/selection'

const USER: User = {id: 'user-1', name: 'Alice'}
const WS = 'ws-children-view'
const DISPLAY: PropertyDisplayScopeLevels = {childBacked: true, workspace: 'none', panel: 'inherit'}
const ELSEWHERE = 'elsewhere'

/** In scope `elsewhere`, `owner` draws `lender`'s children in place of its own. */
const lendingView = (lender: string): ChildrenView => ({
  id: 'test.lent',
  read: ({parent}) => parent.repo.query.childIds({id: lender, propertyChildren: 'none'}),
})

let sharedDb: TestDb
let repo: Repo
let lender = 'lent'
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: USER}).repo
  lender = 'lent'
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    childrenViewFacet.of(({parent, surface}) =>
      parent.id === 'owner' && surface.renderScopeId === ELSEWHERE && lendingView(lender), {source: 'test'}),
  ]))
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'page'})
    await tx.create({id: 'owner', workspaceId: WS, parentId: 'page', orderKey: 'a0', content: 'owner'})
    await tx.create({id: 'a', workspaceId: WS, parentId: 'owner', orderKey: 'a0', content: 'a'})
    await tx.create({id: 'lent', workspaceId: WS, parentId: 'page', orderKey: 'a1', content: 'lent'})
    await tx.create({id: 'x', workspaceId: WS, parentId: 'lent', orderKey: 'a0', content: 'x'})
    await tx.create({id: 'y', workspaceId: WS, parentId: 'lent', orderKey: 'a1', content: 'y'})
    await tx.create({id: 'empty', workspaceId: WS, parentId: 'page', orderKey: 'a2', content: 'empty'})
  }, {scope: ChangeScope.BlockDefault})
})

const surfaceIn = (renderScopeId: string) =>
  outlineSurfaceOf({scopeRootId: 'page', propertyDisplay: DISPLAY, renderScopeId})!

describe('childrenViewFacet', () => {
  it('is the list the walkers read on the surface it answers for', async () => {
    const owner = repo.block('owner')
    expect(await visibleChildIds(owner, surfaceIn(ELSEWHERE))).toEqual(['x', 'y'])
    expect((await nextVisibleBlock(owner, surfaceIn(ELSEWHERE)))?.id).toBe('x')
    expect((await getLastVisibleDescendant(owner, surfaceIn(ELSEWHERE))).id).toBe('y')
  })

  it('leaves every other surface on the property-display default', async () => {
    const owner = repo.block('owner')
    expect(await visibleChildIds(owner, surfaceIn('outline'))).toEqual(['a'])
    expect((await nextVisibleBlock(owner, surfaceIn('outline')))?.id).toBe('a')
  })

  it('decides whether a block shows children for the edit policy and the merge rule', async () => {
    lender = 'empty'
    const owner = repo.block('owner')
    const elsewhere = {scopeRootId: 'page', propertyDisplay: DISPLAY, renderScopeId: ELSEWHERE}
    expect((await structuralEditPolicyForBlock(owner, elsewhere)).createBelowPlacement).toBe('sibling-below')
    expect((await structuralEditPolicyForBlock(owner, {...elsewhere, renderScopeId: 'outline'})).createBelowPlacement)
      .toBe('child-first')
    expect(await bothShowIndependentChildren({into: repo.block('lent'), from: owner}, surfaceIn(ELSEWHERE))).toBe(false)
    expect(await bothShowIndependentChildren({into: repo.block('lent'), from: owner}, surfaceIn('outline'))).toBe(true)
  })
})
