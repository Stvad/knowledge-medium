// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { ChangeScope } from '@/data/api'
import type { Repo } from '@/data/repo'
import type { Block } from '@/data/block'
import { focusedBlockLocationProp } from '@/data/properties'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { useFocusPlacedChildIds } from './focusedChild'
import { useRetainedFieldRows } from './useRetainedFieldRows'

const current = vi.hoisted(() => ({ui: undefined as Block | undefined}))
vi.mock('@/data/globalState', () => ({useUIStateBlock: () => current.ui!}))

let db: TestDb
let repo: Repo
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
afterEach(cleanup)
beforeEach(async () => {
  await resetTestDb(db.db)
  repo = createTestRepo({db: db.db, user: {id: 'test-user'}}).repo
  repo.setActiveWorkspaceId('test-workspace')
  await repo.tx(async tx => {
    for (const [id, parentId, orderKey] of [['ui', null, 'a0'], ['page', null, 'a1'], ['a', 'page', 'a0'], ['b', 'page', 'a1']] as const) {
      await tx.create({id, parentId, workspaceId: 'test-workspace', orderKey, content: id})
    }
  }, {scope: ChangeScope.BlockDefault})
  current.ui = repo.block('ui')
  await current.ui.load()
  setFocus('b')
})

const setFocus = (blockId: string) => {
  const ui = current.ui!.peek()!
  repo.cache.setSnapshot({...ui, properties: {
    ...ui.properties,
    [focusedBlockLocationProp.name]: focusedBlockLocationProp.codec.encode({blockId, renderScopeId: 'outline'}),
  }})
}

/** What the indent's commit does before any listing's query reloads: the
 *  cache moves the row. Nothing here invalidates a childIds handle. */
const indentInCacheOnly = () => {
  const b = repo.block('b').peek()!
  repo.cache.setSnapshot({...b, parentId: 'a', orderKey: 'a0'})
}

const listings = (scope: string) => renderHook(() => ({
  page: useRetainedFieldRows(repo.block('page'), scope),
  a: useRetainedFieldRows(repo.block('a'), scope),
}))

describe('a focused row moved to another parent', () => {
  it('leaves its old listing in the same render that its new parent places it', async () => {
    const {result} = listings('outline')
    await waitFor(() => expect(result.current.page.childIds).toEqual(['a', 'b']))
    expect(result.current.a.childIds).toEqual([])

    act(indentInCacheOnly)

    const stale = repo.query.childIds({id: 'page', hydrate: true, propertyChildren: result.current.page.mode}).peek()
    expect(stale).toEqual(['a', 'b'])
    expect(result.current.a.childIds).toEqual(['b'])
    expect(result.current.page.childIds).toEqual(['a'])
  })

  it('stays where its listing has it in another render scope, which places nothing', async () => {
    const {result} = listings('embed')
    await waitFor(() => expect(result.current.page.childIds).toEqual(['a', 'b']))

    act(indentInCacheOnly)

    expect(result.current.page.childIds).toEqual(['a', 'b'])
    expect(result.current.a.childIds).toEqual([])
  })

  it('stays listed where the cache has it', async () => {
    const {result} = renderHook(() => useFocusPlacedChildIds(repo.block('a'), 'outline', ['b']))
    expect(result.current.listed).toEqual([])
    act(indentInCacheOnly)
    expect(result.current.listed).toEqual(['b'])
  })

  it('does not rerender a listing that shows none of the focused chain when focus moves', async () => {
    const listed = ['unrelated']
    let renders = 0
    renderHook(() => {
      renders++
      return useFocusPlacedChildIds(repo.block('a'), 'outline', listed)
    })
    await waitFor(() => expect(repo.block('b').peek()).toBeDefined())
    const before = renders
    act(() => setFocus('a'))
    await waitFor(() => expect(repo.block('a').peek()).toBeDefined())
    expect(renders).toBe(before)
  })
})
