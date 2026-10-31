// @vitest-environment happy-dom
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react'
import {afterEach, describe, expect, it, vi} from 'vitest'

const state = vi.hoisted(() => ({
  active: new Map([['global', {}]]),
  selected: vi.fn<(text: string) => void>(),
}))

vi.mock('@/shortcuts/useActionDiscovery.js', () => {
  const actions = [{
      id: 'selection', description: 'Use selected text', context: 'global',
      isVisible: () => document.getSelection()?.toString() === 'selected words',
    }, {
      id: 'inspect', description: 'Inspect selection', context: 'global',
    }]
  return {useActionDiscovery: () => ({
    active: state.active,
    actions,
    activeContexts: [{config: {type: 'global', displayName: 'Global'}, dependencies: {}}],
    bindingsFor: () => [],
  })}
})
vi.mock('@/shortcuts/useActionContext.js', () => ({useActionContext: () => {}}))
vi.mock('@/shortcuts/runAction.js', () => ({
  useRunAction: () => () => {
    state.selected(document.getSelection()?.toString() ?? '')
    document.getSelection()?.removeAllRanges()
  },
}))
vi.mock('@/shortcuts/ActiveContexts.js', () => ({
  useActiveContextsState: () => state.active,
  editorViewFromActiveContexts: () => undefined,
}))

import {CommandPalette} from '../CommandPalette.tsx'
import {commandPaletteToggle} from '../toggleStore.ts'

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never
Element.prototype.scrollIntoView ??= () => {}

afterEach(() => {
  cleanup()
  commandPaletteToggle.close()
  document.getSelection()?.removeAllRanges()
  vi.restoreAllMocks()
  state.selected.mockClear()
})

const openWithSelection = async () => {
  const view = render(<><p>Some selected words here</p><CommandPalette/></>)
  const text = screen.getByText('Some selected words here').firstChild!
  document.getSelection()!.setBaseAndExtent(text, 5, text, 19)
  expect(document.getSelection()!.toString()).toBe('selected words')

  // happy-dom keeps the range on focus; Chromium replaces it with a caret.
  const focus = HTMLElement.prototype.focus
  vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function(this: HTMLElement, options) {
    focus.call(this, options)
    if (this.hasAttribute('cmdk-input')) document.getSelection()!.collapse(this.parentNode, 0)
  })
  act(() => commandPaletteToggle.open())
  const input = await screen.findByPlaceholderText('Type a command or search...')
  expect(document.activeElement).toBe(input)
  expect(document.getSelection()!.isCollapsed).toBe(true)
  return {view, input, text}
}

describe('command palette document selection', () => {
  it('lists and runs a selection action after autofocus, context updates and searching', async () => {
    const {view, input} = await openWithSelection()
    // Context activation can invalidate discovery after the input took focus.
    state.active = new Map(state.active)
    view.rerender(<><p>Some selected words here</p><CommandPalette/></>)
    fireEvent.change(input, {target: {value: 'Use selected'}})
    const command = await screen.findByText('Use selected text')
    expect(document.activeElement).toBe(input)
    expect(document.getSelection()!.isCollapsed).toBe(true)

    fireEvent.click(command)

    expect(state.selected).toHaveBeenCalledWith('selected words')
    expect(commandPaletteToggle.isOpen()).toBe(false)
    expect(document.getSelection()!.isCollapsed).toBe(true)
  })

  it('does not restore a range whose selected nodes were removed', async () => {
    const {text} = await openWithSelection()
    text.parentNode!.removeChild(text)
    expect(text.isConnected).toBe(false)

    fireEvent.click(await screen.findByText('Inspect selection'))

    expect(state.selected).toHaveBeenCalledWith('')
  })

  it('captures a fresh selection each time the palette opens', async () => {
    const {input} = await openWithSelection()
    fireEvent.keyDown(input, {key: 'Escape'})
    expect(commandPaletteToggle.isOpen()).toBe(false)
    document.getSelection()!.removeAllRanges()
    act(() => commandPaletteToggle.open())
    await screen.findByText('Inspect selection')

    expect(screen.queryByText('Use selected text')).toBeNull()
  })
})
