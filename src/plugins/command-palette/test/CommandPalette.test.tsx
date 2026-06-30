// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The bug under test lives purely in how each cmdk `value` is derived in
// CommandPalette, so stub the data hook with the two collision shapes plus the
// surrounding context hooks the surface doesn't need here:
//  - same description, different id, same context — the real
//    move_up_from_cm_start / move_left_from_cm_start CM-nav pair (↑ vs ←).
//  - same id, different context, both active at once — the real global vs vim
//    normal-mode `undo` pair (a bare-id value would still collide on these).
vi.mock('../useCommandPaletteActions.ts', () => ({
  useCommandPaletteActions: () => ({
    actions: [
      {id: 'move_up_from_cm_start', description: 'Move to previous block', context: 'edit_mode_cm'},
      {id: 'move_left_from_cm_start', description: 'Move to previous block', context: 'edit_mode_cm'},
      {id: 'undo', description: 'Undo', context: 'global'},
      {id: 'undo', description: 'Undo', context: 'normal_mode'},
    ],
    activeContexts: [
      {config: {type: 'edit_mode_cm', displayName: 'Editing'}, dependencies: {}},
      {config: {type: 'global', displayName: 'Global'}, dependencies: {}},
      {config: {type: 'normal_mode', displayName: 'Normal mode'}, dependencies: {}},
    ],
    bindingsFor: (action: {id: string}) =>
      action.id === 'move_up_from_cm_start' ? [{keys: 'ArrowUp'}]
        : action.id === 'move_left_from_cm_start' ? [{keys: 'ArrowLeft'}]
          : [],
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
  it('gives every action a distinct value so only one row is ever selected', async () => {
    commandPaletteToggle.open()
    render(<CommandPalette/>)

    // Every action renders as a separate item with a unique (context-qualified) value...
    await waitFor(() => expect(items()).toHaveLength(4))
    const values = items().map(el => el.getAttribute('data-value'))
    expect(new Set(values).size).toBe(4)
    // ...including same-id actions that are live in two contexts at once.
    expect(values).toContain('global:undo')
    expect(values).toContain('normal_mode:undo')

    // Exactly ONE row is selected; a shared value would mark several at once.
    await waitFor(() => expect(selectedItems()).toHaveLength(1))
    const firstSelected = selectedItems()[0].getAttribute('data-value')

    // ArrowDown advances to a different single item rather than looping/sticking.
    const input = document.querySelector('[cmdk-input]')!
    fireEvent.keyDown(input, {key: 'ArrowDown'})
    await waitFor(() => {
      expect(selectedItems()).toHaveLength(1)
      expect(selectedItems()[0].getAttribute('data-value')).not.toBe(firstSelected)
    })
  })

  it('still filters actions by their human description text', async () => {
    commandPaletteToggle.open()
    render(<CommandPalette/>)
    await waitFor(() => expect(items()).toHaveLength(4))

    const input = document.querySelector('[cmdk-input]')!
    fireEvent.change(input, {target: {value: 'previous block'}})

    // Description text must remain searchable even though the value is now an id.
    await waitFor(() => {
      const shown = items().map(el => el.getAttribute('data-value'))
      expect(shown).toEqual([
        'edit_mode_cm:move_up_from_cm_start',
        'edit_mode_cm:move_left_from_cm_start',
      ])
    })
  })
})
