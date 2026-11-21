// @vitest-environment happy-dom
import type { MouseEvent as ReactMouseEvent } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBulletHover } from '../BulletHoverCard.tsx'

// The open delay is 350ms; advance past it to let the card open.
const PAST_OPEN_DELAY = 400

const enterAnchor = (
  onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => void,
  anchor: HTMLElement,
) => {
  act(() => {
    onMouseEnter({currentTarget: anchor} as unknown as ReactMouseEvent<HTMLElement>)
  })
}

describe('useBulletHover', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does not resurrect an open card after a disable→enable cycle', () => {
    const anchor = document.createElement('a')
    const {result, rerender} = renderHook(({enabled}) => useBulletHover(enabled), {
      initialProps: {enabled: true},
    })

    enterAnchor(result.current.anchorHoverProps.onMouseEnter, anchor)
    act(() => vi.advanceTimersByTime(PAST_OPEN_DELAY))
    expect(result.current.open).toBe(true)

    // Disabled mid-hover (e.g. window shrinks below the mobile breakpoint).
    rerender({enabled: false})
    expect(result.current.open).toBe(false)

    // Re-enabled (widened back): the stale card must NOT pop back open.
    rerender({enabled: true})
    expect(result.current.open).toBe(false)
  })

  it('drops an in-flight open timer when disabled before it fires', () => {
    const anchor = document.createElement('a')
    const {result, rerender} = renderHook(({enabled}) => useBulletHover(enabled), {
      initialProps: {enabled: true},
    })

    enterAnchor(result.current.anchorHoverProps.onMouseEnter, anchor)
    rerender({enabled: false}) // disable before the open delay elapses
    act(() => vi.advanceTimersByTime(PAST_OPEN_DELAY))
    rerender({enabled: true})
    expect(result.current.open).toBe(false)
  })

  it('is inert when disabled', () => {
    const anchor = document.createElement('a')
    const {result} = renderHook(() => useBulletHover(false))

    enterAnchor(result.current.anchorHoverProps.onMouseEnter, anchor)
    act(() => vi.advanceTimersByTime(PAST_OPEN_DELAY))
    expect(result.current.open).toBe(false)
  })
})
