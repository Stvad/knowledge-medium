// @vitest-environment happy-dom
import {act, renderHook, waitFor} from '@testing-library/react'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {Block} from '@/data/block'
import {useDocumentScripts} from '../useDocumentScripts.ts'

const state = vi.hoisted(() => ({
  workspaceId: 'ws',
  members: {data: [] as {user_id: string}[], isLoading: false},
}))

vi.mock('@powersync/react', () => ({useQuery: () => state.members}))
vi.mock('@/hooks/block.js', () => ({useWorkspaceId: () => state.workspaceId}))

const ME = 'me'
const block = {id: 'doc', repo: {user: {id: ME}}} as unknown as Block
const SCRIPTED = '<script>x()</script>'

const open = (source = SCRIPTED) => renderHook(({text}) => useDocumentScripts(block, text), {initialProps: {text: source}})

describe('useDocumentScripts', () => {
  beforeEach(() => {
    localStorage.clear()
    state.workspaceId = 'ws'
    state.members = {data: [{user_id: ME}, {user_id: 'other'}], isLoading: false}
  })

  it('decides nothing until it knows the workspace', () => {
    state.members = {data: [{user_id: ME}], isLoading: false}
    state.workspaceId = ''
    expect(open().result.current.mode).toBeUndefined()
  })

  it('decides nothing while the members are loading, with the hash already known', async () => {
    const {result, rerender} = open()
    await waitFor(() => expect(result.current.mode).toBe('hold'))

    state.members = {data: [], isLoading: true}
    rerender({text: SCRIPTED})
    expect(result.current.mode).toBeUndefined()
  })

  it('runs on sight, with nothing to switch, for the only member', () => {
    state.members = {data: [{user_id: ME}], isLoading: false}
    expect(open().result.current).toEqual({mode: 'run'})
  })

  it('holds a shared document until the viewer allows it, and stops when told', async () => {
    const {result} = open()
    await waitFor(() => expect(result.current.mode).toBe('hold'))
    expect(result.current.stop).toBeUndefined()

    act(() => result.current.allow?.())
    await waitFor(() => expect(result.current.mode).toBe('run'))
    expect(result.current.allow).toBeUndefined()

    act(() => result.current.stop?.())
    await waitFor(() => expect(result.current.mode).toBe('hold'))
  })

  it('remembers the allowed version, and holds again when the source changes', async () => {
    const first = open()
    await waitFor(() => expect(first.result.current.mode).toBe('hold'))
    act(() => first.result.current.allow?.())
    await waitFor(() => expect(first.result.current.mode).toBe('run'))

    const reopened = open()
    await waitFor(() => expect(reopened.result.current.mode).toBe('run'))

    reopened.rerender({text: `${SCRIPTED}<script>y()</script>`})
    await waitFor(() => expect(reopened.result.current.mode).toBe('hold'))
  })

  it('offers nothing to run in a static document', async () => {
    const {result} = open('<p>static</p>')
    await waitFor(() => expect(result.current.mode).toBe('hold'))
    expect(result.current).toEqual({mode: 'hold'})
  })
})
