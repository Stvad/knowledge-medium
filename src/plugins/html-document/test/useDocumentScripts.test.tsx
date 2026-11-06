// @vitest-environment happy-dom
import {act, renderHook, waitFor} from '@testing-library/react'
import {beforeEach, describe, expect, it} from 'vitest'
import type {Block} from '@/data/block'
import {useDocumentScripts} from '../useDocumentScripts.ts'

const block = {id: 'doc'} as unknown as Block
const SCRIPTED = '<script>x()</script>'

const open = (source = SCRIPTED) => renderHook(({text}) => useDocumentScripts(block, text), {initialProps: {text: source}})

describe('useDocumentScripts', () => {
  beforeEach(() => localStorage.clear())

  it('holds a document until the viewer allows it, and stops when told', async () => {
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

  it('decides nothing until it has the hash, so an allowed document never loads held first', async () => {
    const first = open()
    await waitFor(() => expect(first.result.current.mode).toBe('hold'))
    act(() => first.result.current.allow?.())

    const reopened = open()
    expect(reopened.result.current).toEqual({mode: undefined})
    await waitFor(() => expect(reopened.result.current.mode).toBe('run'))
  })

  it('stops when another tab does', async () => {
    const {result} = open()
    await waitFor(() => expect(result.current.mode).toBe('hold'))
    act(() => result.current.allow?.())
    await waitFor(() => expect(result.current.mode).toBe('run'))

    localStorage.clear()
    act(() => { window.dispatchEvent(new StorageEvent('storage')) })
    await waitFor(() => expect(result.current.mode).toBe('hold'))
  })

  it('offers nothing to run in a static document', async () => {
    const {result} = open('<p>static</p>')
    await waitFor(() => expect(result.current.mode).toBe('hold'))
    expect(result.current).toEqual({mode: 'hold'})
  })
})
