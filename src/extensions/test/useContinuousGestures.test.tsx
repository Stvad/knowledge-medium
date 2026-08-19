// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMemo, useRef } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import {
  continuousGestureRecognizersFacet,
  useContinuousGestures,
  suppressNextClick,
  GESTURE_IDLE,
  type GestureRecognizer,
} from '@/extensions/continuousGestures'
import type { BlockResolveContext } from '@/extensions/blockInteraction'
import { MOBILE_BREAKPOINT_QUERY } from '@/utils/viewport.js'

const resolveContext = {} as unknown as BlockResolveContext

// Renders a single content div whose identity is forced to change with `which`
// (via `key`) — the remount the reviewer flagged: ContentSlot swapping the node
// while the recognizer list stays the same.
const Harness = ({which}: {which: 'a' | 'b'}) => {
  const elementRef = useRef<HTMLElement | null>(null)
  const context = useMemo(() => resolveContext, [])
  const gestureRef = useContinuousGestures(context, elementRef)
  return <div key={which} data-testid={which} ref={gestureRef}/>
}

const firePointerDown = (el: HTMLElement): void => {
  const event = new Event('pointerdown', {bubbles: true})
  Object.assign(event, {pointerId: 1, clientX: 5, clientY: 5, pointerType: 'touch'})
  act(() => {
    el.dispatchEvent(event)
  })
}

afterEach(cleanup)

describe('useContinuousGestures', () => {
  it('reattaches listeners to the new node when the content surface remounts', () => {
    // A stable ref object alone wouldn't re-trigger the listener effect on a
    // node swap, leaving listeners bound to the detached old node. The callback
    // ref tracks node identity so the new surface keeps recognizing gestures.
    const onPointerDown = vi.fn(() => GESTURE_IDLE)
    const recognizer: GestureRecognizer = {id: 'r', onPointerDown}
    const runtime = resolveFacetRuntimeSync([
      continuousGestureRecognizersFacet.of(() => recognizer),
    ])

    const {rerender, getByTestId} = render(
      <AppRuntimeContextProvider value={runtime}>
        <Harness which="a"/>
      </AppRuntimeContextProvider>,
    )

    firePointerDown(getByTestId('a'))
    expect(onPointerDown).toHaveBeenCalledTimes(1)

    // Remount the content node (new div identity), recognizers unchanged.
    rerender(
      <AppRuntimeContextProvider value={runtime}>
        <Harness which="b"/>
      </AppRuntimeContextProvider>,
    )

    firePointerDown(getByTestId('b'))
    expect(onPointerDown).toHaveBeenCalledTimes(2)
  })

  it('re-applies touch-action when the viewport crosses a recognizer breakpoint', () => {
    // The host re-renders on edit-mode but NOT on a breakpoint cross (its
    // useIsMobile lives in child slots), so without a viewport subscription a
    // recognizer that becomes enabled/disabled by width would strand a stale
    // (or missing) pan-y. The hook subscribes to resizes to recompute.
    const original = window.matchMedia
    let mobile = false
    window.matchMedia = ((query: string) => ({
      matches: mobile,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia

    const recognizer: GestureRecognizer = {
      id: 'swipe',
      isEnabled: () => window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches,
      touchAction: 'pan-y',
    }
    const runtime = resolveFacetRuntimeSync([
      continuousGestureRecognizersFacet.of(() => recognizer),
    ])

    const {getByTestId} = render(
      <AppRuntimeContextProvider value={runtime}>
        <Harness which="a"/>
      </AppRuntimeContextProvider>,
    )
    const el = getByTestId('a')
    expect(el.style.touchAction).toBe('') // desktop: recognizer disabled → no pan-y

    mobile = true
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(el.style.touchAction).toBe('pan-y') // crossed into mobile → applied

    mobile = false
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(el.style.touchAction).toBe('') // crossed back out → removed

    window.matchMedia = original
  })
})

describe('suppressNextClick', () => {
  it('swallows the next click (capture + stopPropagation) then disarms', () => {
    const el = document.createElement('div')
    const child = document.createElement('button')
    el.appendChild(child)
    document.body.appendChild(el)
    const childClick = vi.fn()
    child.addEventListener('click', childClick)

    suppressNextClick(el)

    const first = new MouseEvent('click', {bubbles: true, cancelable: true})
    child.dispatchEvent(first)
    expect(first.defaultPrevented).toBe(true) // synthesized click eaten
    expect(childClick).not.toHaveBeenCalled() // stopPropagation kept it off the child

    // One-shot: a later, legitimate click is untouched.
    const second = new MouseEvent('click', {bubbles: true, cancelable: true})
    child.dispatchEvent(second)
    expect(second.defaultPrevented).toBe(false)
    expect(childClick).toHaveBeenCalledTimes(1)

    el.remove()
  })
})
