// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMemo, useRef } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { resolveFacetRuntimeSync } from '@/extensions/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import {
  continuousGestureRecognizersFacet,
  useContinuousGestures,
  GESTURE_IDLE,
  type GestureRecognizer,
} from '@/extensions/continuousGestures'
import type { BlockResolveContext } from '@/extensions/blockInteraction'

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
})
