// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { ChangeScope, type User } from '@/data/api'
import { childrenViewFacet, surfaceOwnerFacet, type NestedSurface } from '@/data/childrenView'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { outlineSurfaceOf } from '@/data/outlineSurface'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { createSharedBlockActions } from '@/shortcuts/blockActions'
import { getDefaultActions } from '@/shortcuts/defaultShortcuts'
import { ActionContextTypes, type ActionConfig, type ActionTrigger } from '@/shortcuts/types'

const USER: User = {id: 'user-1', name: 'Alice'}
const WS = 'ws-structural-key-races'
const SCOPE = 'test.outline'
const BLOCKS = ['page', 'a', 'b', 'b1', 'c'] as const
type ChildLists = Record<typeof BLOCKS[number], readonly string[]>
const INITIAL: ChildLists = {page: ['a', 'b', 'c'], a: [], b: ['b1'], b1: [], c: []}

let db: TestDb
let repo: Repo
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
afterEach(() => { vi.unstubAllGlobals() })
beforeEach(async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)',
    addListener: () => {},
    removeListener: () => {},
  }))
  await resetTestDb(db.db)
  repo = createTestRepo({db: db.db, user: USER}).repo
  repo.setFacetRuntime(resolveFacetRuntimeSync([kernelDataExtension]))
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
    await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0'})
    await tx.create({id: 'a', workspaceId: WS, parentId: 'page', orderKey: 'a0', content: 'a'})
    await tx.create({id: 'b', workspaceId: WS, parentId: 'page', orderKey: 'a1', content: 'b'})
    await tx.create({id: 'b1', workspaceId: WS, parentId: 'b', orderKey: 'a0', content: 'b1'})
    await tx.create({id: 'c', workspaceId: WS, parentId: 'page', orderKey: 'a2', content: 'c'})
  }, {scope: ChangeScope.BlockDefault})
  // A rendered outline has already read the blocks and their child lists.
  await Promise.all(BLOCKS.flatMap(id => [repo.load(id), childIds(id).load()]))
})

const childIds = (id: string) => repo.query.childIds({id, propertyChildren: 'none'})
const storedChildren = async (id: string) => (await db.db.getAll<{id: string}>(
  'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id', [id],
)).map(row => row.id)

const expectStoredTree = async (changes: Partial<ChildLists>) => {
  const expected = {...INITIAL, ...changes}
  for (const id of BLOCKS) expect(await storedChildren(id), `children of ${id}`).toEqual(expected[id])
}

const deps = (id: string) => ({block: repo.block(id), uiStateBlock: repo.block('ui'), scopeRootId: 'page', renderScopeId: SCOPE})
const trigger = {preventDefault: vi.fn()} as unknown as ActionTrigger

async function queueBoth(first: () => void | Promise<void>, second: () => void | Promise<void>) {
  let releaseWrite!: () => void
  const writeReleased = new Promise<void>(resolve => { releaseWrite = resolve })
  const runTx = repo.tx.bind(repo)
  let firstWriting = false
  const writes = vi.spyOn(repo, 'tx').mockImplementationOnce((fn, options) => runTx(async tx => {
    firstWriting = true
    await writeReleased
    return fn(tx)
  }, options))
  const pending: (void | Promise<void>)[] = []
  try {
    pending.push(first())
    await vi.waitFor(() => expect(firstWriting).toBe(true), {interval: 5})
    pending.push(second())
    await vi.waitFor(() => expect(writes).toHaveBeenCalledTimes(2), {interval: 5})
  } finally {
    releaseWrite()
    writes.mockRestore()
    await Promise.all(pending)
  }
}

async function changeBeforeWrite(change: () => void, press: () => void | Promise<void>) {
  const runTx = repo.tx.bind(repo)
  const write = vi.spyOn(repo, 'tx').mockImplementationOnce((fn, options) => {
    change()
    return runTx(fn, options)
  })
  try {
    await press()
    expect(write).toHaveBeenCalledOnce()
  } finally {
    write.mockRestore()
  }
}

const RACES = [
  {
    name: 'Tab twice', subject: 'c', first: 'indentBlock', second: 'indentBlock',
    plain: {page: ['a', 'b'], b1: ['c']},
    custom: {page: ['a', 'b'], b: ['b1', 'c']},
  },
  {
    name: 'Move up twice', subject: 'c', first: 'moveBlockUp', second: 'moveBlockUp',
    plain: {page: ['c', 'a', 'b']},
    custom: {page: ['a', 'c', 'b']},
  },
  {
    name: 'Move up then Tab', subject: 'c', first: 'moveBlockUp', second: 'indentBlock',
    plain: {page: ['a', 'b'], a: ['c']},
    custom: {page: ['a', 'c', 'b']},
  },
  {
    name: 'Move down then Shift+Tab', subject: 'b1', first: 'moveBlockDown', second: 'outdentBlock',
    plain: {page: ['a', 'b', 'c', 'b1'], b: []},
    custom: {page: ['a', 'b', 'c'], b: [], c: ['b1']},
  },
] as const

it.each([
  {label: 'at a workspace root without a scope root', hasOuterView: false},
  {label: 'inside a plain zoomed outline with a custom outer view', hasOuterView: true},
])('resolves both queued Tabs $label', async ({hasOuterView}) => {
  if (hasOuterView) {
    await repo.tx(async tx => {
      await tx.create({id: 'outside', workspaceId: WS, parentId: null, orderKey: 'a1'})
      await tx.move('page', {parentId: 'outside', orderKey: 'a0'})
    }, {scope: ChangeScope.BlockDefault})
    repo.setRuntimeContributions(childrenViewFacet, 'test.outside', [({parent}) =>
      parent.id === 'outside' && {id: 'test.outside', order: 'derived', read: () => childIds(parent.id)}])
  }

  const {indentBlock} = createSharedBlockActions({repo})
  const tabDeps = hasOuterView ? deps('c') : {...deps('c'), scopeRootId: undefined, renderScopeId: undefined}
  const tab = () => indentBlock.handler(tabDeps, trigger)
  await queueBoth(tab, tab)

  await expectStoredTree({page: ['a', 'b'], b1: ['c']})
})

function filterChildrenOfB() {
  repo.setRuntimeContributions(childrenViewFacet, 'test.filtered-destination', [({parent}) =>
    parent.id === 'b' && {id: 'test.filtered-destination', order: 'derived', read: () => ({
      load: async () => (await childIds(parent.id).load()).filter(id => id === 'c'),
      peek: () => childIds(parent.id).peek()?.filter(id => id === 'c'),
    })}])
}

it('refuses the second queued Tab when the new parent’s plugin view hides the previous sibling', async () => {
  filterChildrenOfB()
  const {indentBlock} = createSharedBlockActions({repo})
  const tab = () => indentBlock.handler(deps('c'), trigger)
  await queueBoth(tab, tab)

  expect(await storedChildren('b1')).toEqual([])
  await expectStoredTree({page: ['a', 'b'], b: ['b1', 'c']})
})

it('reads the stored parent when the rendered cache still shows the block elsewhere', async () => {
  filterChildrenOfB()
  const runTx = repo.tx.bind(repo)
  vi.spyOn(repo, 'tx').mockImplementationOnce((fn, options) => runTx(async tx => {
    await tx.move('c', {parentId: 'b', orderKey: 'a1'})
    expect(repo.block('c').peek()?.parentId).toBe('page')
    return fn(tx)
  }, options))

  await createSharedBlockActions({repo}).indentBlock.handler(deps('c'), trigger)

  await expectStoredTree({page: ['a', 'b'], b: ['b1', 'c']})
})

it('preserves a deleted block’s stored placement when Tab was queued before deletion committed', async () => {
  const {indentBlock} = createSharedBlockActions({repo})
  await queueBoth(
    () => repo.tx(tx => tx.delete('c'), {scope: ChangeScope.BlockDefault}),
    () => indentBlock.handler(deps('c'), trigger),
  )

  expect(await db.db.getOptional(
    "SELECT parent_id, order_key, deleted FROM blocks WHERE id = 'c'",
  )).toEqual({parent_id: 'page', order_key: 'a2', deleted: 1})
})

describe.each(['plain', 'custom'] as const)('%s outline', kind => {
  beforeEach(() => {
    if (kind === 'custom') repo.setRuntimeContributions(childrenViewFacet, 'test.outline', [({parent, surface}) =>
      surface.renderScopeId === SCOPE && {id: 'test.outline', order: 'outline', read: () => childIds(parent.id)}])
  })

  it.each(RACES)('queues $name before the first write commits', async race => {
    const actions = createSharedBlockActions({repo})
    await queueBoth(
      () => actions[race.first].handler(deps(race.subject), trigger),
      () => actions[race.second].handler(deps(race.subject), trigger),
    )
    await expectStoredTree(race[kind])
  })

  if (kind === 'custom') it.each([
    ['same parent', 'a'],
    ['different parents', 'b1'],
  ] as const)('refuses a stale move between siblings with %s', async (_, subject) => {
    const {moveBlockUp, moveBlockDown} = createSharedBlockActions({repo})
    await queueBoth(
      () => moveBlockUp.handler(deps('c'), trigger),
      () => moveBlockDown.handler(deps(subject), trigger),
    )
    await expectStoredTree({page: ['a', 'c', 'b']})
  })

  it('reads the new neighbour for sequential Move up then Tab', async () => {
    const {moveBlockUp, indentBlock} = createSharedBlockActions({repo})
    await moveBlockUp.handler(deps('c'), trigger)
    await expectStoredTree({page: ['a', 'c', 'b']})
    await indentBlock.handler(deps('c'), trigger)
    await expectStoredTree({page: ['a', 'b'], a: ['c']})
  })

  it('indents the new sibling after sequential Enter then Tab', async () => {
    const enter = getDefaultActions({repo}).find(
      (action): action is ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> =>
        action.id === 'split_block_cm' && action.context === ActionContextTypes.EDIT_MODE_CM,
    )!
    const editorView = new EditorView({doc: 'a', selection: {anchor: 1}})
    try {
      await enter.handler({...deps('a'), editorView}, trigger)
      const inserted = (await storedChildren('page'))[1]!
      expect(await repo.load(inserted)).toMatchObject({parentId: 'page', content: ''})
      await expectStoredTree({page: ['a', inserted, 'b', 'c']})
      await createSharedBlockActions({repo}).indentBlock.handler(deps(inserted), trigger)
      await expectStoredTree({a: [inserted]})
    } finally {
      editorView.destroy()
    }
  })
})

it('refuses a queued indent when a derived view changes its preceding sibling', async () => {
  const owned = childIds('page')
  const sort = (ids: readonly string[]) => ids.toSorted((a, b) =>
    repo.block(a).peek()!.content.localeCompare(repo.block(b).peek()!.content))
  const sortedChildIds = async () => {
    const ids = await owned.load()
    await Promise.all(ids.map(childId => repo.load(childId)))
    return sort(ids)
  }
  repo.setRuntimeContributions(childrenViewFacet, 'test.derived', [({parent, surface}) =>
    parent.id === 'page' && surface.renderScopeId === SCOPE && {
      id: 'test.derived', order: 'derived', read: () => ({
        load: sortedChildIds,
        peek: () => {
          const ids = owned.peek()
          return ids && sort(ids)
        },
      }),
    }])
  expect(await sortedChildIds()).toEqual(['a', 'b', 'c'])

  const {indentBlock} = createSharedBlockActions({repo})
  await queueBoth(
    () => repo.tx(tx => tx.update('b', {content: 'z'}), {scope: ChangeScope.BlockDefault}),
    () => indentBlock.handler(deps('c'), trigger),
  )

  await expectStoredTree({})
  expect(await sortedChildIds()).toEqual(['a', 'c', 'b'])
})

it('refuses an outdated list that is still published after the preceding sibling changes in storage', async () => {
  const members = ['a', 'b', 'c']
  repo.setRuntimeContributions(childrenViewFacet, 'test.lagging-order', [({parent, surface}) =>
    parent.id === 'page' && surface.renderScopeId === SCOPE && {
      id: 'test.lagging-order', order: 'outline', read: () => ({
        load: async () => members,
        peek: () => members,
      }),
    }])
  const {indentBlock} = createSharedBlockActions({repo})
  await queueBoth(
    async () => { await repo.mutate.move({id: 'c', parentId: 'page', position: {kind: 'before', siblingId: 'b'}}) },
    () => indentBlock.handler(deps('c'), trigger),
  )

  await expectStoredTree({page: ['a', 'c', 'b']})
})

it.each([
  ['its order changes', ['a', 'c', 'b']],
  ['the subject stops being drawn', ['a', 'b']],
] as const)('refuses a queued indent without a block edit when %s', async (_, next) => {
  let members: readonly string[] = ['a', 'b', 'c']
  repo.setRuntimeContributions(childrenViewFacet, 'test.presentation-order', [({parent, surface}) =>
    parent.id === 'page' && surface.renderScopeId === SCOPE && {
      id: 'test.presentation-order', order: 'derived', read: () => ({
        load: async () => members,
        peek: () => members,
      }),
    }])
  await changeBeforeWrite(
    () => { members = next },
    () => createSharedBlockActions({repo}).indentBlock.handler(deps('c'), trigger),
  )

  await expectStoredTree({})
})

it.each([
  {label: 'the order becomes derived', change: {order: 'derived'}, action: 'moveBlockUp', subject: 'c'},
  {label: 'the editing root becomes the member', change: {scopeRootId: undefined}, action: 'outdentBlock', subject: 'b1'},
  {label: 'the nested list becomes unavailable', change: {members: undefined}, action: 'moveBlockUp', subject: 'c'},
] as const)('refuses a queued nested edit when $label', async ({change, action, subject}) => {
  const outer = outlineSurfaceOf({scopeRootId: 'page', renderScopeId: 'test.owner'})!
  let nested: NestedSurface = {kind: 'nested-surface', scopeRootId: 'page', renderScopeId: SCOPE, order: 'outline', members: ['a', 'b', 'c']}
  repo.setRuntimeContributions(surfaceOwnerFacet, 'test.mutable-owner', [({renderScopeId}) =>
    renderScopeId === SCOPE && {blockId: 'page', surface: outer}])
  repo.setRuntimeContributions(childrenViewFacet, 'test.mutable-nested', [({parent, surface}) =>
    parent.id === 'page' && surface.renderScopeId === outer.renderScopeId && {
      id: 'test.mutable-nested', read: () => ({load: async () => [nested], peek: () => [nested]}),
    }])

  await changeBeforeWrite(
    () => { nested = {...nested, ...change} },
    () => createSharedBlockActions({repo})[action].handler(deps(subject), trigger),
  )

  await expectStoredTree({})
})

it.each([
  {label: 'the layout owner leaves the cache', evict: true},
  {label: 'the render scope changes owners', evict: false},
])('refuses a queued nested Tab when $label', async ({evict}) => {
  const outer = outlineSurfaceOf({scopeRootId: 'page', renderScopeId: 'test.owner'})!
  const nested: NestedSurface = {kind: 'nested-surface', scopeRootId: 'page', renderScopeId: SCOPE, order: 'outline', members: ['a', 'b', 'c']}
  let ownerId = 'page'
  repo.setRuntimeContributions(surfaceOwnerFacet, 'test.owner', [({renderScopeId}) =>
    renderScopeId === SCOPE && {blockId: ownerId, surface: outer}])
  repo.setRuntimeContributions(childrenViewFacet, 'test.published-grid', [({parent, surface}) =>
    (parent.id === 'page' || parent.id === 'a') && surface.renderScopeId === outer.renderScopeId && {
      id: 'test.published-grid', read: () => ({load: async () => [nested], peek: () => [nested]}),
    }])

  await changeBeforeWrite(() => {
    if (evict) expect(repo.cache.deleteSnapshot('page')).toBe(true)
    else ownerId = 'a'
  }, () => createSharedBlockActions({repo}).indentBlock.handler(deps('c'), trigger))

  await expectStoredTree({})
})

it.each([
  ['Tab', 'indentBlock', 'c'],
  ['Move up', 'moveBlockUp', 'c'],
  ['Shift+Tab', 'outdentBlock', 'b1'],
] as const)('%s refuses to anchor a write to a load-only view', async (_, action, subject) => {
  const load = vi.fn(async () => ['a', 'b', 'c'])
  repo.setRuntimeContributions(childrenViewFacet, 'test.load-only', [({parent, surface}) =>
    parent.id === 'page' && surface.renderScopeId === SCOPE && {
      id: 'test.load-only', order: 'outline', read: () => ({load}),
    }])

  await createSharedBlockActions({repo})[action].handler(deps(subject), trigger)

  expect(load).toHaveBeenCalled()
  await expectStoredTree({})
})
