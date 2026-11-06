// @vitest-environment happy-dom
import {act, renderHook, waitFor} from '@testing-library/react'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {Block} from '@/data/block'
import {useDocumentScripts} from '../useDocumentScripts.ts'

const state = vi.hoisted(() => ({
  workspaceId: 'ws',
  workspace: {data: [] as {had_other_members: number | null}[], isLoading: false},
  remoteSync: true,
}))

vi.mock('@powersync/react', () => ({useQuery: () => state.workspace}))
vi.mock('@/hooks/block.js', () => ({useWorkspaceId: () => state.workspaceId}))
vi.mock('@/data/repoProvider', () => ({isRemoteSyncActive: () => state.remoteSync}))

const block = {id: 'doc'} as unknown as Block
const SCRIPTED = '<script>x()</script>'

const open = (source = SCRIPTED) => renderHook(({text}) => useDocumentScripts(block, text), {initialProps: {text: source}})

describe('useDocumentScripts', () => {
  beforeEach(() => {
    localStorage.clear()
    state.workspaceId = 'ws'
    state.remoteSync = true
    state.workspace = {data: [{had_other_members: 1}], isLoading: false}
  })

  it('decides nothing until it knows the workspace', () => {
    state.workspace = {data: [{had_other_members: 0}], isLoading: false}
    state.workspaceId = ''
    expect(open().result.current.mode).toBeUndefined()
  })

  it('decides nothing while the workspace is loading, with the hash already known', async () => {
    const {result, rerender} = open()
    await waitFor(() => expect(result.current.mode).toBe('hold'))

    state.workspace = {data: [], isLoading: true}
    rerender({text: SCRIPTED})
    expect(result.current.mode).toBeUndefined()
  })

  it('runs on sight, with nothing to switch, where nobody else has ever been a member', () => {
    state.workspace = {data: [{had_other_members: 0}], isLoading: false}
    expect(open().result.current).toEqual({mode: 'run'})
  })

  it('holds in a synced workspace whose row has not arrived', async () => {
    state.workspace = {data: [], isLoading: false}
    const {result} = open()
    await waitFor(() => expect(result.current.mode).toBe('hold'))
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
