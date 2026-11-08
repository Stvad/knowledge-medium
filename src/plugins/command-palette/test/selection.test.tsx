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
import {captureSelection, restoreSelection} from '../selection.ts'

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
  it.each(['number', 'date', 'email'])('opens from a focused %s input without native selection support', async type => {
    render(<><input aria-label="Property value" type={type}/><CommandPalette/></>)
    const prior = screen.getByLabelText('Property value')
    prior.focus()
    expect(document.activeElement).toBe(prior)
    expect((prior as HTMLInputElement).selectionStart).toBeNull()

    act(() => commandPaletteToggle.open())

    const input = await screen.findByPlaceholderText('Type a command or search...')
    expect(document.activeElement).toBe(input)
    fireEvent.click(await screen.findByText('Inspect selection'))
    expect(state.selected).toHaveBeenCalledWith('')
  })

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

  it.each(['start', 'end'] as const)('rejects a range relocated by removing and reinserting its %s node', endpoint => {
    render(<p><span>start</span><span>end</span></p>)
    const start = screen.getByText('start').firstChild!
    const end = screen.getByText('end').firstChild!
    document.getSelection()!.setBaseAndExtent(start, 0, end, 3)
    const saved = captureSelection()!
    const node = endpoint === 'start' ? start : end
    const parent = node.parentNode!
    parent.removeChild(node)
    // Native Ranges relocate when nodes are removed; happy-dom does not.
    if (endpoint === 'start') saved.range.setStart(parent, 0)
    else saved.range.setEnd(parent, 0)
    parent.appendChild(node)
    expect(node.isConnected).toBe(true)
    expect(saved.range.commonAncestorContainer.isConnected).toBe(true)
    expect(endpoint === 'start' ? saved.range.startContainer : saved.range.endContainer).not.toBe(node)

    restoreSelection(saved)

    expect(document.getSelection()!.rangeCount).toBe(0)
  })

  it('preserves the search input native selection when visibility refreshes', async () => {
    const {view, input} = await openWithSelection()
    const search = input as HTMLInputElement
    fireEvent.change(search, {target: {value: 'selected'}})
    search.setSelectionRange(2, 5, 'backward')
    const addRange = Selection.prototype.addRange
    // Chromium resets native input offsets when a document range is restored.
    vi.spyOn(Selection.prototype, 'addRange').mockImplementation(function(this: Selection, range) {
      addRange.call(this, range)
      search.setSelectionRange(0, 0)
    })
    state.active = new Map(state.active)

    view.rerender(<><p>Some selected words here</p><CommandPalette/></>)

    expect(search.selectionStart).toBe(2)
    expect(search.selectionEnd).toBe(5)
    expect(search.selectionDirection).toBe('backward')
    expect(document.activeElement).toBe(search)
  })

  it.each(['start', 'end', 'both'])('leaves a selection with editable %s to editor state', async endpoint => {
    render(<>
      <span contentEditable={endpoint !== 'end'} suppressContentEditableWarning>selected </span>
      <span contentEditable={endpoint !== 'start'} suppressContentEditableWarning>words</span>
      <CommandPalette/>
    </>)
    const start = screen.getByText('selected').firstChild!
    const end = screen.getByText('words').firstChild!
    document.getSelection()!.setBaseAndExtent(start, 0, end, 5)
    act(() => commandPaletteToggle.open())
    const input = await screen.findByPlaceholderText('Type a command or search...')
    // Model the document-selection collapse even though happy-dom does not.
    document.getSelection()!.collapse(input.parentNode, 0)

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
