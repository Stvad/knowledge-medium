// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import type { BlockPointerDependencies } from '@/shortcuts/types.js'
import { swipeRightCloseAction } from '../gestureActions.ts'
import { SWIPE_QUICK_ACTION_CLOSE_EVENT } from '../events.ts'

/** Minimal deps the close handler reads: a block id, the surface element it
 *  dispatches the CLOSE event on, and (optionally) a render scope. */
const depsFor = (targetElement: HTMLElement): BlockPointerDependencies =>
  ({block: {id: 'block-1'}, targetElement} as unknown as BlockPointerDependencies)

describe('swipeRightCloseAction', () => {
  it('declines (returns false) when no open menu cancels the CLOSE event', () => {
    const element = document.createElement('div')
    // No listener preventDefaults the event → no menu was open → the action must
    // decline so the run-until-handled loop falls through to the todo cycle.
    expect(swipeRightCloseAction.handler(depsFor(element), new CustomEvent('x'))).toBe(false)
  })

  it('handles (returns void) when an open menu cancels the CLOSE event', () => {
    const element = document.createElement('div')
    // An open menu listens on an ancestor and preventDefaults the bubbling event.
    const parent = document.createElement('div')
    parent.appendChild(element)
    parent.addEventListener(SWIPE_QUICK_ACTION_CLOSE_EVENT, event => event.preventDefault())
    expect(swipeRightCloseAction.handler(depsFor(element), new CustomEvent('x'))).toBeUndefined()
  })
})
