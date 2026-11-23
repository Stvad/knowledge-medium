// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHysteresis } from '../useHysteresis.ts'

describe('useHysteresis', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const mount = (initial: boolean) =>
    renderHook(({active}) => useHysteresis(active, 2_000, 1_000), {initialProps: {active: initial}})

  it('turns on only after the input has stayed on for the enter delay', () => {
    const {result, rerender} = mount(false)
    rerender({active: true})
    act(() => vi.advanceTimersByTime(1_999))
    expect(result.current).toBe(false)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe(true)
  })

  it('never turns on for a blip shorter than the enter delay', () => {
    const {result, rerender} = mount(false)
    rerender({active: true})
    act(() => vi.advanceTimersByTime(1_500))
    rerender({active: false})
    act(() => vi.advanceTimersByTime(5_000))
    expect(result.current).toBe(false)
  })

  it('restarts the enter delay when the input flaps', () => {
    const {result, rerender} = mount(false)
    rerender({active: true})
    act(() => vi.advanceTimersByTime(1_500))
    rerender({active: false})
    rerender({active: true})
    act(() => vi.advanceTimersByTime(1_500))
    expect(result.current).toBe(false)
    act(() => vi.advanceTimersByTime(500))
    expect(result.current).toBe(true)
  })

  it('stays on for the exit delay after the input turns off', () => {
    const {result, rerender} = mount(false)
    rerender({active: true})
    act(() => vi.advanceTimersByTime(2_000))
    rerender({active: false})
    act(() => vi.advanceTimersByTime(999))
    expect(result.current).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe(false)
  })

  it('stays on through a gap shorter than the exit delay', () => {
    const {result, rerender} = mount(false)
    rerender({active: true})
    act(() => vi.advanceTimersByTime(2_000))
    rerender({active: false})
    act(() => vi.advanceTimersByTime(500))
    rerender({active: true})
    act(() => vi.advanceTimersByTime(5_000))
    expect(result.current).toBe(true)
  })
})
