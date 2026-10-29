// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { armCut, disarmCut, getArmedCut } from '@/paste/armedCut'
import { ArmedCutMount } from './armedCutAppMount'

beforeEach(() => disarmCut())
afterEach(() => cleanup())

describe('ArmedCutMount', () => {
  it('dims the armed blocks and stops when the cut is disarmed', async () => {
    const view = render(<ArmedCutMount/>)
    await act(() => armCut('- a', {workspaceId: 'ws-1', rootIds: ['block-a']}))

    expect(view.container.querySelector('style')?.textContent)
      .toContain('[data-block-shell][data-block-id="block-a"]')
    act(() => disarmCut())
    expect(view.container.querySelector('style')).toBeNull()
  })

  it.each(['copy', 'cut'])('a native %s in the page disarms the cut', async eventType => {
    render(<ArmedCutMount/>)
    await act(() => armCut('- a', {workspaceId: 'ws-1', rootIds: ['block-a']}))

    act(() => { document.body.dispatchEvent(new Event(eventType, {bubbles: true})) })

    expect(getArmedCut()).toBeNull()
  })
})
