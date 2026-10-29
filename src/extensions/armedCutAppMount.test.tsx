// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { armCut, disarmCut, getArmedCut, markCutPasted } from '@/paste/armedCut'
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

  it('does not dim a cut whose blocks a paste already placed', async () => {
    const view = render(<ArmedCutMount/>)
    await act(() => armCut('- a', {workspaceId: 'ws-1', rootIds: ['block-a']}))
    act(() => markCutPasted(getArmedCut()!.cutId))

    expect(getArmedCut()).not.toBeNull()
    expect(view.container.querySelector('style')).toBeNull()
  })

  it.each(['copy', 'cut'])('a native %s that wrote the clipboard disarms the cut', async eventType => {
    render(<ArmedCutMount/>)
    await act(() => armCut('- a', {workspaceId: 'ws-1', rootIds: ['block-a']}))
    // A handler that writes its own data (CodeMirror) prevents the default.
    const writer = document.createElement('div')
    document.body.appendChild(writer)
    writer.addEventListener(eventType, event => event.preventDefault())

    act(() => { writer.dispatchEvent(new Event(eventType, {bubbles: true, cancelable: true})) })

    expect(getArmedCut()).toBeNull()
    writer.remove()
  })

  it.each(['copy', 'cut'])('a native %s with nothing selected leaves the cut armed', async eventType => {
    render(<ArmedCutMount/>)
    await act(() => armCut('- a', {workspaceId: 'ws-1', rootIds: ['block-a']}))

    act(() => { document.body.dispatchEvent(new Event(eventType, {bubbles: true, cancelable: true})) })

    expect(getArmedCut()).not.toBeNull()
  })

  it('a plain copy of selected page text disarms the cut', async () => {
    render(<ArmedCutMount/>)
    await act(() => armCut('- a', {workspaceId: 'ws-1', rootIds: ['block-a']}))
    const text = document.createElement('p')
    text.textContent = 'selected words'
    document.body.appendChild(text)
    document.getSelection()!.selectAllChildren(text)

    act(() => { text.dispatchEvent(new Event('copy', {bubbles: true, cancelable: true})) })

    expect(getArmedCut()).toBeNull()
    document.getSelection()!.removeAllRanges()
    text.remove()
  })

  it('a plain copy from a text field with a selection disarms the cut', async () => {
    render(<ArmedCutMount/>)
    await act(() => armCut('- a', {workspaceId: 'ws-1', rootIds: ['block-a']}))
    const field = document.createElement('textarea')
    field.value = 'field text'
    document.body.appendChild(field)
    field.setSelectionRange(0, 5)

    act(() => { field.dispatchEvent(new Event('copy', {bubbles: true, cancelable: true})) })

    expect(getArmedCut()).toBeNull()
    field.remove()
  })
})
