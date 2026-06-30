// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The bug under test lives purely in how each cmdk `value` is derived in
// CommandPalette, so stub the data hook with two actions that share a
// description (mirrors the real move_up_from_cm_start / move_left_from_cm_start
// CodeMirror-nav pair, which differ only by binding) plus the surrounding
// context hooks the surface doesn't need here.
vi.mock('../useCommandPaletteActions.ts', () => ({
  useCommandPaletteActions: () => ({
    actions: [
      {id: 'move_up_from_cm_start', description: 'Move to previous block', context: 'edit_mode_cm'},
      {id: 'move_left_from_cm_start', description: 'Move to previous block', context: 'edit_mode_cm'},
    ],
    activeContexts: [{config: {type: 'edit_mode_cm', displayName: 'Editing'}, dependencies: {}}],
    bindingsFor: (action: {id: string}) => [
      {keys: action.id === 'move_up_from_cm_start' ? 'ArrowUp' : 'ArrowLeft'},
    ],
  }),
}))
vi.mock('@/shortcuts/useActionContext.js', () => ({useActionContext: () => {}}))
vi.mock('@/shortcuts/runAction.js', () => ({useRunAction: () => () => {}}))
vi.mock('@/shortcuts/ActiveContexts.js', () => ({
  useActiveContextsState: () => new Map(),
  editorViewFromActiveContexts: () => undefined,
}))

import { CommandPalette } from '../CommandPalette.tsx'
import { commandPaletteToggle } from '../toggleStore.ts'

// cmdk's CommandList observes its size and scrolls the active item into view —
// neither API exists in jsdom, so stub them to no-ops.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never
Element.prototype.scrollIntoView ??= () => {}

const items = () => Array.from(document.querySelectorAll<HTMLElement>('[cmdk-item]'))
const selectedItems = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[cmdk-item][aria-selected="true"]'))

afterEach(() => {
  cleanup()
  commandPaletteToggle.close()
})

describe('CommandPalette item identity', () => {
  it('gives same-description actions distinct values so only one is ever selected', async () => {
    commandPaletteToggle.open()
    render(<CommandPalette/>)

    // Both same-description actions render as separate, independently-keyed items.
    await waitFor(() => expect(items()).toHaveLength(2))
    const values = items().map(el => el.getAttribute('data-value'))
    expect(new Set(values).size).toBe(2)
    expect(values).toEqual(['move_up_from_cm_start', 'move_left_from_cm_start'])

    // cmdk auto-selects the first item; a shared value would mark BOTH selected.
    await waitFor(() => expect(selectedItems()).toHaveLength(1))
    expect(selectedItems()[0].getAttribute('data-value')).toBe('move_up_from_cm_start')

    // ArrowDown advances to the second item rather than looping on the first.
    const input = document.querySelector('[cmdk-input]')!
    fireEvent.keyDown(input, {key: 'ArrowDown'})
    await waitFor(() => {
      expect(selectedItems()).toHaveLength(1)
      expect(selectedItems()[0].getAttribute('data-value')).toBe('move_left_from_cm_start')
    })
  })

  it('still filters same-description actions by their human description text', async () => {
    commandPaletteToggle.open()
    render(<CommandPalette/>)
    await waitFor(() => expect(items()).toHaveLength(2))

    const input = document.querySelector('[cmdk-input]')!
    fireEvent.change(input, {target: {value: 'previous block'}})

    // Description text must remain searchable even though the value is now the id.
    await waitFor(() => expect(items()).toHaveLength(2))
  })
})
