// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { ChangeScope } from '@/data/api'
import type { Repo } from '@/data/repo'
import type { Block } from '@/data/block'
import { focusedBlockLocationProp } from '@/data/properties'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { useFocusedChild, useFocusWithin } from './focusedChild'

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
    for (const [id, parentId] of [['ui', null], ['owner', null], ['other', null], ['field', 'owner'], ['value', 'field']] as const) {
      await tx.create({id, parentId, workspaceId: 'test-workspace', orderKey: 'a0', content: id})
    }
  }, {scope: ChangeScope.BlockDefault})
  current.ui = repo.block('ui')
  await current.ui.load()
  setFocus('value')
})

describe('useFocusWithin', () => {
  it('includes the owner and descendants but excludes another scope or an outside block', async () => {
    setFocus('owner')
    const {result} = renderHook(() => useFocusWithin(repo.block('owner'), 'outline'))
    expect(result.current).toBe(true)
    act(() => setFocus('field'))
    expect(result.current).toBe(true)
    act(() => setFocus('value'))
    await waitFor(() => expect(result.current).toBe(true))
    act(() => setFocus('value', 'another-outline'))
    expect(result.current).toBe(false)
    act(() => setFocus('other'))
    await waitFor(() => expect(result.current).toBe(false))
  })

  it('does not report outside while the new focused descendants chain is loading', async () => {
    setFocus('owner')
    repo.cache.deleteSnapshot('field')
    repo.cache.deleteSnapshot('value')
    const observed: (boolean | undefined)[] = []
    const {result} = renderHook(() => {
      const within = useFocusWithin(repo.block('owner'), 'outline')
      observed.push(within)
      return within
    })
    expect(result.current).toBe(true)
    act(() => setFocus('value'))
    expect(result.current).toBeUndefined()
    await waitFor(() => expect(result.current).toBe(true))
    expect(observed).not.toContain(false)
  })

  it('publishes an outside answer when an empty ancestor chain finishes loading', async () => {
    setFocus('other')
    const {result} = renderHook(() => useFocusWithin(repo.block('owner'), 'outline'))
    expect(result.current).toBeUndefined()
    await waitFor(() => expect(result.current).toBe(false))
  })
})

const setFocus = (id: string, scope = 'outline') => {
  const before = current.ui!.peek()!
  repo.cache.setSnapshot({...before, properties: {
    ...before.properties,
    [focusedBlockLocationProp.name]: focusedBlockLocationProp.codec.encode({blockId: id, renderScopeId: scope}),
  }})
}

describe('useFocusedChild', () => {
  it('reveals the containing row when the focused leaf loads after its ancestors', async () => {
    repo.cache.deleteSnapshot('value')
    const focused = repo.block('value')
    const originalLoad = focused.load.bind(focused)
    let release = () => {}
    const ready = new Promise<void>(resolve => { release = resolve })
    const load = vi.spyOn(focused, 'load').mockImplementation(async () => {
      await ready
      return originalLoad()
    })
    try {
      const {result} = renderHook(() => useFocusedChild(repo.block('owner'), 'outline'))
      await waitFor(() => expect(repo.query.ancestors({id: 'value'}).status()).toBe('ready'))
      expect(focused.peek()).toBeUndefined()
      expect(result.current).toBeNull()
      await act(async () => { release() })
      await waitFor(() => expect(result.current?.id).toBe('field'))
    } finally {
      release()
      load.mockRestore()
    }
  })

  it('follows an ancestor move without a parent component rerender', async () => {
    await repo.query.ancestors({id: 'value'}).load()
    const {result} = renderHook(() => useFocusedChild(repo.block('owner'), 'outline'))
    await waitFor(() => expect(result.current?.id).toBe('field'))
    const value = repo.block('value').peek()
    await act(async () => {
      await repo.tx(tx => tx.move('field', {parentId: 'other', orderKey: 'a0'}), {scope: ChangeScope.BlockDefault})
    })
    expect(repo.block('value').peek()).toBe(value)
    await waitFor(() => expect(result.current).toBeNull())
  })

  it('loads an uncached ancestor before revealing the containing row', async () => {
    repo.cache.deleteSnapshot('value')
    repo.cache.deleteSnapshot('field')
    expect(repo.block('field').peek()).toBeUndefined()
    const {result} = renderHook(() => useFocusedChild(repo.block('owner'), 'outline'))
    await waitFor(() => expect(result.current?.id).toBe('field'))
    expect(repo.block('field').peek()?.parentId).toBe('owner')
    expect(repo.block('value').peek()?.parentId).toBe('field')
  })

  it('returns the focused row itself for direct children and observes scope changes', async () => {
    setFocus('field')
    const {result} = renderHook(() => useFocusedChild(repo.block('owner'), 'outline'))
    await waitFor(() => expect(result.current?.id).toBe('field'))
    act(() => setFocus('field', 'another-outline'))
    expect(result.current).toBeNull()
    act(() => setFocus('owner'))
    expect(result.current).toBeNull()
  })

  it('keeps the containing row stable when unrelated UI state changes', async () => {
    const {result} = renderHook(() => useFocusedChild(repo.block('owner'), 'outline'))
    await waitFor(() => expect(result.current?.id).toBe('field'))
    const before = result.current
    const ancestors = repo.query.ancestors({id: 'value'})
    const load = vi.spyOn(ancestors, 'load')
    const readAncestor = vi.spyOn(repo.block('field'), 'peek')
    act(() => {
      const ui = current.ui!.peek()!
      repo.cache.setSnapshot({...ui, properties: {...ui.properties, 'test:caret': 2}})
    })
    expect(result.current).toBe(before)
    expect(load).not.toHaveBeenCalled()
    expect(readAncestor).not.toHaveBeenCalled()
  })

  it('does not rerender a listing when focus moves within the same child', async () => {
    await repo.query.ancestors({id: 'value'}).load()
    await repo.query.ancestors({id: 'field'}).load()
    let renders = 0
    const {result} = renderHook(() => {
      renders++
      return useFocusedChild(repo.block('owner'), 'outline')
    })
    await waitFor(() => expect(result.current?.id).toBe('field'))
    const before = renders
    act(() => setFocus('field'))
    expect(result.current?.id).toBe('field')
    expect(renders).toBe(before)
  })
})
