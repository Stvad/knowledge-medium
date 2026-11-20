// @vitest-environment happy-dom
import {act, renderHook} from '@testing-library/react'
import {describe, expect, it} from 'vitest'
import {createKeyedToggleSet} from './toggleStore.ts'

describe('createKeyedToggleSet', () => {
  it('flips one key without touching another, and a reader re-renders on its key', () => {
    const set = createKeyedToggleSet()
    const a = renderHook(() => set.useHas('a'))
    const b = renderHook(() => set.useHas('b'))
    act(() => set.toggle('a'))
    expect([a.result.current, b.result.current]).toEqual([true, false])
    act(() => set.toggle('a'))
    expect(a.result.current).toBe(false)
  })
})
