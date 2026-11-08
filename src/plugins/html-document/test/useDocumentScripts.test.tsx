// @vitest-environment happy-dom
import {act, renderHook} from '@testing-library/react'
import {beforeEach, describe, expect, it} from 'vitest'
import {hasScripts, useDocumentScripts} from '../useDocumentScripts.ts'

const SCRIPTED = '<script>x()</script>'

const open = (source = SCRIPTED) => renderHook(({text}) => useDocumentScripts('doc', text), {initialProps: {text: source}})

describe('useDocumentScripts', () => {
  beforeEach(() => localStorage.clear())

  it('holds a document until the viewer allows it, and stops when told', () => {
    const {result} = open()
    expect(result.current.mode).toBe('hold')
    expect(result.current.stop).toBeUndefined()

    act(() => result.current.allow?.())
    expect(result.current.mode).toBe('run')
    expect(result.current.allow).toBeUndefined()

    act(() => result.current.stop?.())
    expect(result.current.mode).toBe('hold')
  })

  it('remembers the allowed version, and holds again when the source changes', () => {
    const first = open()
    act(() => first.result.current.allow?.())
    expect(first.result.current.mode).toBe('run')

    const reopened = open()
    expect(reopened.result.current.mode).toBe('run')

    reopened.rerender({text: `${SCRIPTED}<script>y()</script>`})
    expect(reopened.result.current.mode).toBe('hold')
  })

  it('stops when another tab does', () => {
    const {result} = open()
    act(() => result.current.allow?.())
    expect(result.current.mode).toBe('run')

    localStorage.clear()
    act(() => { window.dispatchEvent(new StorageEvent('storage')) })
    expect(result.current.mode).toBe('hold')
  })

  it('offers nothing to run in a static document', () => {
    expect(open('<p>static</p>').result.current).toEqual({mode: 'hold'})
  })
})

describe('hasScripts', () => {
  it.each([
    '<script>x()</script>',
    '<SCRIPT src="x"></SCRIPT>',
    '<img src=x onerror=x()>',
    '<svg ONLOAD = "x()">',
    '<a href="javascript:x()">x</a>',
  ])('offers to run %s', source => {
    expect(hasScripts(source)).toBe(true)
  })

  it.each([
    '',
    '<p>Plain text about scripts and online things</p>',
    '<style>a{color:red}</style><div style="height:9px"></div>',
  ])('has nothing to offer for %j', source => {
    expect(hasScripts(source)).toBe(false)
  })
})
