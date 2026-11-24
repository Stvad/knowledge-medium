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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ChangeScope, defineQuery, type User } from '@/data/api'
import { childrenViewFacet, surfaceOwnerFacet, type ChildrenOrder, type ChildrenView, type DrawnChild, type NestedSurface } from '@/data/childrenView'
import { queriesFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { split } from '@/data/mutators'
import { outlineSurfaceOf } from '@/data/outlineSurface'
import type { PropertyDisplayScopeLevels } from '@/data/propertyDisplayMode'
import type { Repo } from '@/data/repo'
import { indentDrawnBlock, memberMergePlacement, moveDrawnBlock, outdentDrawnBlock } from '@/data/structuralEditPolicy'
import { insertDrawnBlock, type InsertGesture } from '@/data/structuralInsert'
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

  it.each([
    ['bare', 'page'],
    ['outline', 'owner'],
  ])('places a new block below the owner in the %s surface under %s', async (scope, parentId) => {
    const inserted = await insertDrawnBlock(repo.block('owner'), surfaceIn(scope), {kind: 'below'})
    expect(await repo.load(inserted!.id)).toMatchObject({parentId, content: ''})
  })

  it('decides whether both merge blocks show children', async () => {
    const owner = repo.block('owner')
    expect(await bothShowIndependentChildren({into: repo.block('other'), from: owner}, surfaceIn('bare'))).toBe(false)
    expect(await bothShowIndependentChildren({into: repo.block('other'), from: owner}, surfaceIn('outline'))).toBe(true)
  })

  it('passes placement to the winning insert hook and focuses its returned id in the source scope', async () => {
    repo.setRuntimeContributions(childrenViewFacet, 'test.insert', [({parent}) => parent.id === 'owner' && {
      id: 'test.insert',
      read: () => ({load: async () => ['a', 'b', 'c']}),
      insert: async (ctx, request) => {
        expect(request).toMatchObject({block: {id: 'a'}, gesture: 'below', position: 'after'})
        return ctx.parent.repo.mutate.createChild({parentId: ctx.parent.id, position: {kind: 'last'}, content: 'Custom insertion'})
      },
    }])

    const inserted = await insertDrawnBlock(repo.block('a'), surfaceIn('outline'), {kind: 'below'})
    expect(inserted?.renderScopeId).toBe('outline')
    expect(await repo.query.childIds({id: 'owner', propertyChildren: 'none'}).load()).toEqual(['a', 'b', 'c', inserted?.id])
    expect((await repo.load(inserted!.id))?.content).toBe('Custom insertion')
  })

  it.each(['create', 'split'] as const)('anchors a first child on the first drawn member during %s', async kind => {
    const owner = repo.block('owner')
    const carrier = {...surfaceIn('elsewhere'), scopeRootId: owner.id}
    const gesture: InsertGesture = kind === 'create'
      ? {kind: 'below'}
      : {kind: 'split', write: (_placement, commit) => commit('ow', 'ner')}
    const inserted = await insertDrawnBlock(owner, carrier, gesture)

    // The custom view begins at c, with b hidden and a drawn later.
    expect(await repo.query.childIds({id: 'owner', propertyChildren: 'none'}).load()).toEqual(['a', 'b', inserted?.id, 'c'])
    expect((await repo.load(inserted!.id))?.content).toBe(kind === 'split' ? 'ner' : '')
    expect(owner.peek()?.content).toBe(kind === 'split' ? 'ow' : 'owner')
  })

  it('refuses first-child split when the first drawn child has moved', async () => {
    await repo.mutate.move({id: 'c', parentId: 'other', position: {kind: 'last'}})
    const owner = repo.block('owner')
    const carrier = {...surfaceIn('elsewhere'), scopeRootId: owner.id}
    const split: InsertGesture = {kind: 'split', write: (_placement, commit) => commit('ow', 'ner')}

    expect(await insertDrawnBlock(owner, carrier, split)).toBeNull()
    expect(owner.peek()?.content).toBe('owner')
    expect(await repo.query.childIds({id: 'owner', propertyChildren: 'none'}).load()).toEqual(['a', 'b'])
    expect(await repo.query.childIds({id: 'other', propertyChildren: 'none'}).load()).toEqual(['x', 'c'])
  })

  it.each(['move', 'delete'] as const)('refuses create and split after the anchor changes by %s', async change => {
    let release!: () => void
    let announce!: () => void
    const resolveView = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { announce = resolve })
    let waiting = 0
    repo.setRuntimeContributions(childrenViewFacet, 'test.delayed-insert', [({parent}) => parent.id === 'owner' && {
      id: 'test.delayed-insert',
      read: () => ({load: async () => ['a', 'b', 'c']}),
      insert: async () => {
        if (++waiting === 2) announce()
        await resolveView
        return undefined
      },
    }])
    const source = repo.block('a')
    const surface = surfaceIn('outline')
    const create = insertDrawnBlock(source, surface, {kind: 'above'})
    const split: InsertGesture = {kind: 'split', write: (_placement, commit) => commit('a', '')}
    const splitWrite = insertDrawnBlock(source, surface, split)
    await ready
    if (change === 'move') {
      await repo.mutate.move({id: source.id, parentId: 'other', position: {kind: 'last'}})
    } else {
      await repo.tx(tx => tx.delete(source.id), {scope: ChangeScope.BlockDefault})
    }
    release()
    expect(await create).toBeNull()
    expect(await splitWrite).toBeNull()
    expect(await repo.query.childIds({id: 'owner', propertyChildren: 'none'}).load()).toEqual(['b', 'c'])
    expect(await repo.query.childIds({id: 'other', propertyChildren: 'none'}).load()).toEqual(change === 'move' ? ['x', 'a'] : ['x'])
    if (change === 'move') expect(source.peek()?.content).toBe('a')
  })

  it('tells an insert hook its origin is no longer current once the block moves', async () => {
    let release!: () => void
    const resolveView = new Promise<void>(resolve => { release = resolve })
    const seen: boolean[] = []
    repo.setRuntimeContributions(childrenViewFacet, 'test.checked-insert', [({parent}) => parent.id === 'owner' && {
      id: 'test.checked-insert',
      read: () => ({load: async () => ['a', 'b', 'c']}),
      insert: async (ctx, request) => {
        seen.push(await ctx.parent.repo.tx(tx => request.stillCurrent(tx), {scope: ChangeScope.BlockDefault}))
        await resolveView
        seen.push(await ctx.parent.repo.tx(tx => request.stillCurrent(tx), {scope: ChangeScope.BlockDefault}))
        return null
      },
    }])
    const write = insertDrawnBlock(repo.block('a'), surfaceIn('outline'), {kind: 'below'})
    await vi.waitFor(() => expect(seen).toEqual([true]))
    await repo.mutate.move({id: 'a', parentId: 'other', position: {kind: 'last'}})
    release()
    expect(await write).toBeNull()
    expect(seen).toEqual([true, false])
  })

  it.each(['before', 'during'] as const)('refuses to split when the editor changes %s the insert hook', async timing => {
    const source = repo.block('a')
    await source.setContent('left right')
    const before = await structure()
    let current = timing === 'during'
    let release!: () => void
    const resume = new Promise<void>(resolve => { release = resolve })
    const insert = vi.fn<NonNullable<ChildrenView['insert']>>(async (_ctx, request) => {
      await resume
      return repo.tx(async tx => {
        if (!await request.stillCurrent(tx)) return null
        return tx.run(split, {id: request.block.id, before: 'left ', after: 'right', placement: 'siblingBefore'})
      }, {scope: ChangeScope.BlockDefault})
    })
    repo.setRuntimeContributions(childrenViewFacet, 'test.checked-split', [({parent}) => parent.id === 'owner' && {
      id: 'test.checked-split',
      read: () => ({load: async () => ['a', 'b', 'c']}),
      insert,
    }])

    const write = insertDrawnBlock(source, surfaceIn('outline'), {
      kind: 'split',
      isCurrent: () => current,
      write: (_placement, commit) => commit('left ', 'right'),
    })
    try {
      if (timing === 'during') {
        await vi.waitFor(() => expect(insert).toHaveBeenCalledTimes(1))
        current = false
      }
    } finally {
      release()
    }

    expect(await write).toBeNull()
    expect(insert).toHaveBeenCalledTimes(timing === 'during' ? 1 : 0)
    expect(await structure()).toEqual(before)
    expect((await source.load())?.content).toBe('left right')
  })

  it('refuses a nested write when a higher ancestor leaves the projected member', async () => {
    await repo.tx(async tx => {
      await tx.create({id: 'branch', workspaceId: WS, parentId: 'x', orderKey: 'a0'})
      await tx.create({id: 'leaf', workspaceId: WS, parentId: 'branch', orderKey: 'a0', content: 'leaf'})
    }, {scope: ChangeScope.BlockDefault})
    const outer = surfaceIn('outline')
    const nested: NestedSurface = {kind: 'nested-surface', renderScopeId: 'nested', members: ['x'], order: 'query'}
    repo.setRuntimeContributions(surfaceOwnerFacet, 'test.nested', [({renderScopeId}) => renderScopeId === 'nested' && {
      blockId: 'owner', surface: outer,
    }])
    let release!: () => void
    let announce!: () => void
    const resolveInsert = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { announce = resolve })
    repo.setRuntimeContributions(childrenViewFacet, 'test.nested', [({parent}) => {
      if (parent.id === 'owner') return {id: 'test.nested', read: () => ({load: async () => [nested]})}
      if (parent.id !== 'branch') return undefined
      return {
        id: 'test.branch',
        read: () => ({load: async () => ['leaf']}),
        insert: async () => {
          announce()
          await resolveInsert
          return undefined
        },
      }
    }])

    const carrier = {...outer, renderScopeId: 'nested', scopeRootId: 'x'}
    const leaf = repo.block('leaf')
    const write = insertDrawnBlock(leaf, carrier, {kind: 'above'})
    await ready
    await repo.mutate.move({id: 'branch', parentId: 'other', position: {kind: 'last'}})
    release()
    expect(await write).toBeNull()
    expect(await insertDrawnBlock(leaf, carrier, {kind: 'above'})).toBeNull()
    expect(await repo.query.childIds({id: 'branch', propertyChildren: 'none'}).load()).toEqual(['leaf'])
  })
})

const customList = (owner: string, members: readonly DrawnChild[], order: ChildrenOrder = 'outline') => {
  repo.setRuntimeContributions(childrenViewFacet, 'test.custom-list', [({parent}) => parent.id === owner && {
    id: 'custom', order, read: () => ({load: async () => members, peek: () => members}),
  }])
}

const board = (members: string[], order: ChildrenOrder = 'outline', shared = false, allowsNewMember?: () => boolean, insert?: ChildrenView['insert']) => {
  repo.setRuntimeContributions(surfaceOwnerFacet, 'test.owner', [({renderScopeId}) =>
    renderScopeId === 'board' && {blockId: 'owner', surface: surfaceIn('outline')}])
  const drawn: readonly DrawnChild[] = [{
    kind: 'nested-surface', renderScopeId: 'board', order, members, scopeRootId: shared ? 'owner' : undefined,
    allowsNewMember,
  }]
  repo.setRuntimeContributions(childrenViewFacet, 'test.board', [({parent, surface}) =>
    parent.id === 'owner' && surface.renderScopeId === 'outline' && {
      id: 'board', insert, read: () => ({load: async () => drawn, peek: () => drawn}),
    }])
  return surfaceIn('board')
}
const structure = () => sharedDb.db.getAll<{id: string; parent_id: string | null; order_key: string}>(
  'SELECT id, parent_id, order_key FROM blocks WHERE workspace_id = ? AND deleted = 0 ORDER BY parent_id, order_key, id', [WS],
)

describe('structural writes on a custom view', () => {
  it.each([
    ['above', 'a', 'above'],
    ['below', 'a', 'below'],
    ['empty Enter', 'a', 'empty-enter'],
    ['split', 'a', 'split'],
    ['scope-root split', 'owner', 'split'],
  ] as const)('keeps a same-scope query list intact for default %s placement', async (_, id, kind) => {
    customList('owner', ['a'], 'query')
    const block = repo.block(id)
    const content = kind === 'empty-enter' ? '' : 'prefix tail'
    await block.setContent(content)
    const before = await structure()
    const gesture: InsertGesture = kind === 'split'
      ? {kind, write: (_placement, commit) => commit('prefix ', 'tail')}
      : {kind}

    const surface = surfaceIn('outline')
    expect(await insertDrawnBlock(block, id === 'owner' ? {...surface, scopeRootId: id} : surface, gesture)).toBeNull()
    expect(await structure()).toEqual(before)
    expect((await block.load())?.content).toBe(content)
  })

  it('requires the same-scope query hook to create a sibling result', async () => {
    const owner = repo.block('owner')
    let insert: NonNullable<ChildrenView['insert']> = async () => ({position: 'after'})
    repo.setRuntimeContributions(childrenViewFacet, 'test.query-insert', [({parent}) => parent.id === owner.id && {
      id: 'query-insert', order: 'query', read: () => ({load: async () => ['a']}),
      insert: (ctx, request) => insert(ctx, request),
    }])
    const block = repo.block('a')
    const surface = surfaceIn('outline')
    expect(await insertDrawnBlock(block, surface, {kind: 'below'})).toBeNull()

    insert = ({parent}) => parent.repo.mutate.createChild({parentId: parent.id, content: 'New result'})
    const result = await insertDrawnBlock(block, surface, {kind: 'below'})
    expect(await repo.load(result!.id)).toMatchObject({parentId: owner.id, content: 'New result'})
  })

  it('uses an outline list inside a query view', async () => {
    const scope = board(['a', 'b'], 'outline', true)
    repo.setRuntimeContributions(childrenViewFacet, 'test.board', [({parent, surface}) =>
      parent.id === 'owner' && surface.renderScopeId === 'outline' && {
        id: 'board', order: 'query', read: () => ({load: async () => [{
          kind: 'nested-surface', renderScopeId: 'board', order: 'outline', members: ['a', 'b'], scopeRootId: 'owner',
        }]}),
      }])

    const inserted = await insertDrawnBlock(repo.block('a'), scope, {kind: 'below'})

    expect(inserted).toMatchObject({renderScopeId: 'board'})
    expect(await repo.query.childIds({id: 'owner', propertyChildren: 'none'}).load()).toEqual(['a', inserted!.id, 'b', 'c'])
  })

  it.each([
    ['foreign result', 'outline', 'x', 'after', {kind: 'below'}],
    ['own query result', 'query', 'b', 'before', {kind: 'above'}],
    ['foreign result split', 'outline', 'x', 'first', {
      kind: 'split', write: (_placement, commit) => commit('', 'x'),
    } satisfies InsertGesture],
  ] as const)('refuses delegated placement for %s', async (_label, order, id, position, gesture) => {
    const insert = vi.fn(async () => ({position}))
    const surface = board([id], order, false, undefined, insert)
    const before = await structure()
    const writes = vi.spyOn(repo, 'tx')

    expect(await insertDrawnBlock(repo.block(id), surface, gesture)).toBeNull()
    expect(insert).toHaveBeenCalledOnce()
    expect(writes).not.toHaveBeenCalled()
    expect(await structure()).toEqual(before)
    expect((await repo.load(id))?.content).toBe(id)
  })

  it('uses an explicit board insertion for a projected member', async () => {
    const surface = board(['x'], 'query', false, undefined, ({parent}) => parent.repo.mutate.createChild({parentId: parent.id}))
    const result = await insertDrawnBlock(repo.block('x'), surface, {kind: 'below'})
    expect(result).toMatchObject({renderScopeId: 'board'})
    expect((await repo.load(result!.id))?.parentId).toBe('owner')
  })

  it.each([false, true])('keeps default create within the row scope when shared scope is %s', async shared => {
    const surface = board(['a', 'b'], 'outline', shared)
    const result = await insertDrawnBlock(repo.block('a'), surface, {kind: 'above'})
    expect((await repo.load(result!.id))?.parentId).toBe(shared ? 'owner' : 'a')
    expect((await repo.query.childIds({id: shared ? 'owner' : 'a', propertyChildren: 'none'}).load())[0]).toBe(result!.id)
  })

  it('a stale occurrence cannot fall back to its ordinary source siblings', async () => {
    await repo.mutate.createChild({parentId: 'other', id: 'y'})
    const surface = board(['x'])
    const before = await structure()
    await indentDrawnBlock(repo.block('y'), surface)
    expect(await structure()).toEqual(before)
    expect(await memberMergePlacement(repo.block('y'), surface)).toBeNull()
  })

  it('ignores a subject or data parent missing from a partial local tree', async () => {
    await sharedDb.db.execute("UPDATE blocks SET parent_id = 'missing-parent' WHERE id = 'b'")
    repo = createTestRepo({db: sharedDb.db, user: USER}).repo
    repo.setActiveWorkspaceId(WS)
    expect((await repo.load('b'))?.parentId).toBe('missing-parent')
    const resolveView = vi.fn(() => null)
    repo.setRuntimeContributions(childrenViewFacet, 'test.live-parents', [resolveView])
    const before = await structure()
    await indentDrawnBlock(repo.block('absent'), surfaceIn('outline'))
    await indentDrawnBlock(repo.block('b'), surfaceIn('outline'))
    expect(resolveView).not.toHaveBeenCalled()
    expect(await structure()).toEqual(before)
  })

  it.each([
    ['foreign member', 'x', ['a', 'x'], 'outline'],
    ['query member owned by its host', 'b', ['a', 'b'], 'query'],
  ] as const)('refuses a %s before opening a write transaction', async (_, id, ids, order) => {
    const surface = board([...ids], order)
    const writes = vi.spyOn(repo, 'tx')
    await indentDrawnBlock(repo.block(id), surface)
    expect(writes).not.toHaveBeenCalled()
    expect(await memberMergePlacement(repo.block(id), surface)).toBeNull()
  })

  it('keeps a foreign nested board slot as a boundary for Tab', async () => {
    const surface = {...board(['a', 'x', 'b']), scopeRootId: 'b'}
    const before = await structure()

    await indentDrawnBlock(repo.block('b'), surface)

    expect(await structure()).toEqual(before)
  })

  it('refuses a queued Tab inside a nested board result that is no longer drawn', async () => {
    await repo.tx(async tx => {
      await tx.create({id: 'first-note', workspaceId: WS, parentId: 'x', orderKey: 'a0'})
      await tx.create({id: 'second-note', workspaceId: WS, parentId: 'x', orderKey: 'a1'})
    }, {scope: ChangeScope.BlockDefault})
    const surface = {...board(['a', 'x', 'b']), scopeRootId: 'x'}
    const before = await structure()
    const runTx = repo.tx.bind(repo)
    const writes = vi.spyOn(repo, 'tx').mockImplementationOnce((fn, options) => runTx(tx => {
      board(['a', 'b'])
      return fn(tx)
    }, options))
    try {
      await indentDrawnBlock(repo.block('second-note'), surface)
      expect(writes).toHaveBeenCalledOnce()
    } finally {
      writes.mockRestore()
    }

    expect(await structure()).toEqual(before)
  })

  it('refuses a queued Tab on a nested board member moved into a hidden branch', async () => {
    await repo.mutate.createChild({parentId: 'c', id: 'preceding-note'})
    const surface = {...board(['a', 'b']), scopeRootId: 'b'}
    const runTx = repo.tx.bind(repo)
    let afterMove: Awaited<ReturnType<typeof structure>> | undefined
    const writes = vi.spyOn(repo, 'tx').mockImplementationOnce(async (fn, options) => {
      await runTx(tx => tx.move('b', {parentId: 'c', orderKey: 'a1'}), {scope: ChangeScope.BlockDefault})
      afterMove = await structure()
      return runTx(fn, options)
    })
    try {
      await indentDrawnBlock(repo.block('b'), surface)
      expect(writes).toHaveBeenCalledOnce()
    } finally {
      writes.mockRestore()
    }

    expect(afterMove).toEqual(expect.arrayContaining([
      {id: 'b', parent_id: 'c', order_key: 'a1'},
    ]))
    expect(await structure()).toEqual(afterMove)
  })

  it.each([
    {gesture: 'outdent', subject: 'note', root: 'b', expected: ['a', 'b', 'note', 'c']},
    {gesture: 'move down', subject: 'a', root: 'a', expected: ['b', 'a', 'c']},
  ])('places a board $gesture before an undrawn row tied with the anchor', async ({gesture, subject, root, expected}) => {
    await repo.tx(async tx => {
      await tx.move('c', {parentId: 'owner', orderKey: 'a1'})
      await tx.create({id: 'note', workspaceId: WS, parentId: 'b', orderKey: 'a0'})
    }, {scope: ChangeScope.BlockDefault})
    const surface = {...board(['a', 'b'], 'outline', false, () => true), scopeRootId: root}
    const block = repo.block(subject)

    const moved = gesture === 'outdent'
      ? await outdentDrawnBlock(block, surface)
      : await moveDrawnBlock(block, surface, 1)

    expect(moved).toBe(true)
    expect((await structure()).filter(row => row.parent_id === 'owner').map(row => row.id)).toEqual(expected)
  })

  it('a same-scope query refuses reparenting even when all its members are data children', async () => {
    customList('owner', ['a', 'b', 'c'], 'query')
    const before = await structure()
    await indentDrawnBlock(repo.block('b'), surfaceIn('outline'))
    expect(await memberMergePlacement(repo.block('b'), surfaceIn('outline'))).toBeNull()
    expect(await structure()).toEqual(before)
  })

  it('an omitted member stays omitted from a custom list for both indent and move', async () => {
    customList('owner', ['a', 'c'])
    const before = await structure()
    await indentDrawnBlock(repo.block('b'), surfaceIn('outline'))
    expect(await moveDrawnBlock(repo.block('b'), surfaceIn('outline'), 1)).toBe(false)
    expect(await structure()).toEqual(before)
  })

  it('refuses Tab on the visible root even when it has a stored preceding sibling', async () => {
    const before = await structure()
    const scope = {...surfaceIn('outline'), scopeRootId: 'b'}
    await indentDrawnBlock(repo.block('b'), scope)
    expect(await outdentDrawnBlock(repo.block('b'), scope)).toBe(false)
    expect(await structure()).toEqual(before)
  })

  it('plain empty Enter refuses an outdent when the block moves before its write', async () => {
    const block = repo.block('a')
    await block.setContent('')
    const runTx = repo.tx.bind(repo)
    let afterMove: Awaited<ReturnType<typeof structure>> | undefined
    vi.spyOn(repo, 'tx').mockImplementationOnce(async (fn, options) => {
      await runTx(tx => tx.move(block.id, {parentId: 'other', orderKey: 'a1'}), {scope: ChangeScope.BlockDefault})
      afterMove = await structure()
      return runTx(fn, options)
    })

    expect(await insertDrawnBlock(block, surfaceIn('outline'), {kind: 'empty-enter'})).toBeNull()
    expect(await repo.load(block.id)).toMatchObject({parentId: 'other', content: ''})
    expect(await structure()).toEqual(afterMove)
  })

  it('refuses to outdent a direct child beyond a root-level panel or projected root', async () => {
    await repo.tx(async tx => {
      await tx.create({id: 'result', parentId: null, workspaceId: WS, orderKey: 'a1'})
      await tx.create({id: 'note', parentId: 'result', workspaceId: WS, orderKey: 'a0'})
    }, {scope: ChangeScope.BlockDefault})
    const before = await structure()
    expect(await outdentDrawnBlock(repo.block('owner'), surfaceIn('outline'))).toBe(false)
    const projected = board(['result'])
    expect(await outdentDrawnBlock(repo.block('note'), {...projected, scopeRootId: 'owner'})).toBe(false)
    expect(await structure()).toEqual(before)
  })

  it('a workspace root has no data parent to resolve as a block', async () => {
    const root = repo.block('page')
    const getBlock = vi.spyOn(repo, 'block')
    await indentDrawnBlock(root, {...surfaceIn('outline'), scopeRootId: undefined})
    expect(getBlock).not.toHaveBeenCalledWith(null)
  })

  it('a hidden non-root parent has no workspace-root fallback on outdent', async () => {
    customList('page', ['other', 'after'])
    const before = await structure()
    expect(await outdentDrawnBlock(repo.block('a'), surfaceIn('outline'))).toBe(false)
    expect(await moveDrawnBlock(repo.block('c'), surfaceIn('outline'), 1)).toBe(false)
    expect(await structure()).toEqual(before)
  })

  it('a full member list refuses to promote a note into it', async () => {
    const surface = board(['a', 'b'], 'outline', false, () => false)
    await repo.mutate.createChild({parentId: 'b', id: 'note'})
    const before = await structure()
    expect(await outdentDrawnBlock(repo.block('note'), {...surface, scopeRootId: 'b'})).toBeNull()
    expect(await structure()).toEqual(before)
  })

  it('a nested member cannot move past the list just because the view also projects its owner’s ancestor', async () => {
    const surface = board(['page', 'a', 'b'])
    const before = await structure()
    expect(await moveDrawnBlock(repo.block('b'), surface, 1)).toBe(false)
    expect(await outdentDrawnBlock(repo.block('a'), surface)).toBe(false)
    expect(await structure()).toEqual(before)
  })

  it('the last note cannot move across the root to the next grid member', async () => {
    const surface = board(['a', 'b'])
    await repo.mutate.createChild({parentId: 'a', id: 'note'})
    const before = await structure()
    expect(await moveDrawnBlock(repo.block('note'), {...surface, scopeRootId: 'a'}, 1)).toBe(false)
    expect(await structure()).toEqual(before)
  })

  it('an opaque next slot cannot send a row into its parent’s next sibling', async () => {
    customList('owner', ['a', 'b', {kind: 'nested-surface', renderScopeId: 'opaque'}])
    const before = await structure()
    expect(await moveDrawnBlock(repo.block('b'), surfaceIn('outline'), 1)).toBe(false)
    expect(await structure()).toEqual(before)
  })

  it('only a drawn outline parent order permits a cross-parent move', async () => {
    customList('page', ['owner', 'other', 'after'], 'derived')
    const before = await structure()
    expect(await moveDrawnBlock(repo.block('c'), surfaceIn('outline'), 1)).toBe(false)
    customList('page', ['owner'])
    expect(await moveDrawnBlock(repo.block('c'), surfaceIn('outline'), 1)).toBe(false)
    expect(await structure()).toEqual(before)
  })

  it('a dispatch without a root has no cross-parent destination', async () => {
    const before = await structure()
    expect(await moveDrawnBlock(repo.block('c'), {...surfaceIn('outline'), scopeRootId: undefined}, 1)).toBe(false)
    expect(await structure()).toEqual(before)
  })

  it('refuses missing or foreign merge predecessors and delegates shared-root notes to the outline', async () => {
    let surface = board(['a', 'x', 'b'])
    const load = vi.spyOn(repo, 'load')
    expect(await memberMergePlacement(repo.block('a'), surface)).toBeNull()
    expect(load).not.toHaveBeenCalledWith(undefined)
    expect(await memberMergePlacement(repo.block('b'), surface)).toBeNull()
    surface = board(['a', 'b'], 'outline', true)
    expect(await memberMergePlacement(repo.block('a'), surface)).toBeUndefined()
    expect(await memberMergePlacement(repo.block('b'), surface)).toBeUndefined()
    await repo.mutate.createChild({parentId: 'a', id: 'nested-note'})
    expect(await memberMergePlacement(repo.block('nested-note'), surface)).toBeUndefined()
    expect(await memberMergePlacement(repo.block('b'), surfaceIn('outline'))).toBeUndefined()
  })
})
