// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ArrowUp, Check } from 'lucide-react'
import { ActionContextTypes, type ActionConfig, type ActionContextType } from '@/shortcuts/types.js'

const mocks = vi.hoisted(() => ({
  activeContexts: new Map<string, unknown>(),
  pointerCoarse: true,
  readOnly: false,
  dispatch: vi.fn(),
}))

const moveUp = {
  id: 'multi_select.move_block_up',
  description: 'Move block up (Multiple Blocks)',
  context: 'multi-select-mode',
  icon: ArrowUp,
  handler: () => {},
} as unknown as ActionConfig
const done = {
  id: 'clear_selection',
  description: 'Clear selection',
  context: 'multi-select-mode',
  icon: Check,
  handler: () => {},
} as unknown as ActionConfig

vi.mock('@/shortcuts/ActiveContexts.js', () => ({useActiveContextsState: () => mocks.activeContexts}))
vi.mock('@/shortcuts/actionRefItems.js', async importOriginal => ({
  ...await importOriginal<typeof import('@/shortcuts/actionRefItems.js')>(),
  useActionRefItems: () => [
    {item: {id: 'move-up', actionId: moveUp.id}, action: moveUp},
    {item: {id: 'missing', actionId: 'not-registered'}, action: undefined},
    {item: {id: 'done', actionId: done.id}, action: done},
  ],
}))
vi.mock('@/shortcuts/runAction.js', () => ({dispatchActionWithDeps: mocks.dispatch}))
vi.mock('@/utils/react.js', () => ({usePointerCoarse: () => mocks.pointerCoarse}))
vi.mock('@/context/repo.js', () => ({useRepo: () => ({})}))
vi.mock('@/hooks/useIsReadOnly.js', () => ({useIsReadOnly: () => mocks.readOnly}))

const {TouchSelectionLayer} = await import('../TouchSelectionLayer.tsx')

const selectionDeps = {selectedBlocks: [], uiStateBlock: {}}
const activate = (...types: ActionContextType[]) => {
  for (const type of types) mocks.activeContexts.set(type, type === ActionContextTypes.MULTI_SELECT_MODE ? selectionDeps : {})
}
const toolbar = () => screen.queryByRole('toolbar', {name: 'Selected blocks'})

beforeEach(() => {
  mocks.activeContexts.clear()
  mocks.pointerCoarse = true
  mocks.readOnly = false
  mocks.dispatch.mockReset()
})
afterEach(cleanup)

describe('TouchSelectionLayer', () => {
  it('shows a button per resolved item while blocks are selected on a touch device', () => {
    activate(ActionContextTypes.MULTI_SELECT_MODE)
    render(<TouchSelectionLayer/>)

    expect(screen.getAllByRole('button').map(button => button.getAttribute('aria-label')))
      .toEqual(['Move block up (Multiple Blocks)', 'Clear selection'])
  })

  it('runs the tapped action with multi-select mode\'s deps', () => {
    activate(ActionContextTypes.MULTI_SELECT_MODE)
    render(<TouchSelectionLayer/>)

    fireEvent.click(screen.getByRole('button', {name: 'Move block up (Multiple Blocks)'}))

    expect(mocks.dispatch).toHaveBeenCalledTimes(1)
    expect(mocks.dispatch.mock.calls[0]?.slice(0, 2)).toEqual([moveUp.id, selectionDeps])
  })

  it('reserves its height in the panes while it shows, where no bottom nav does', () => {
    const clearance = () => [...document.querySelectorAll('style')]
      .some(style => style.textContent?.includes('--panel-bottom-clearance'))

    render(<TouchSelectionLayer/>)
    expect(clearance()).toBe(false)
    cleanup()

    activate(ActionContextTypes.MULTI_SELECT_MODE)
    render(<TouchSelectionLayer/>)
    expect(clearance()).toBe(true)
  })

  it('stays hidden with nothing selected', () => {
    render(<TouchSelectionLayer/>)
    expect(toolbar()).toBeNull()
  })

  it('stays hidden on a device whose primary pointer is fine', () => {
    mocks.pointerCoarse = false
    activate(ActionContextTypes.MULTI_SELECT_MODE)
    render(<TouchSelectionLayer/>)
    expect(toolbar()).toBeNull()
  })

  it('gives way to the keyboard while a block or a property is edited', () => {
    for (const editing of [ActionContextTypes.EDIT_MODE_CM, ActionContextTypes.PROPERTY_EDITING]) {
      mocks.activeContexts.clear()
      activate(ActionContextTypes.MULTI_SELECT_MODE, editing)
      render(<TouchSelectionLayer/>)
      expect(toolbar()).toBeNull()
      cleanup()
    }
  })

  it('takes read-mode text selection away only in a writable workspace', () => {
    const {container, rerender} = render(<TouchSelectionLayer/>)
    expect(container.querySelector('style')?.textContent).toContain('user-select: none')

    mocks.readOnly = true
    rerender(<TouchSelectionLayer/>)
    expect(container.querySelector('style')).toBeNull()
  })
})
