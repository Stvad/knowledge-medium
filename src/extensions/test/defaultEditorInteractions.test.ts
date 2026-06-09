import type { MouseEvent, RefObject } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import type {
  BlockInteractionContext,
  BlockShellState,
} from '@/extensions/blockInteraction'
import {
  createBlockSelectionShellState,
} from '@/extensions/defaultEditorInteractions'
import { handleBlockSelectionClick } from '@/extensions/blockInteraction'
import { dispatchPointerAction } from '@/shortcuts/pointerAction'

// Selection clicks route through the unified pointer dispatcher; mock it so
// these unit tests don't need a mounted coordinator. Returning true = "a
// pointer-bound action handled it" (no structural fallback); false exercises
// the fallback branch.
vi.mock('@/shortcuts/pointerAction', () => ({
  dispatchPointerAction: vi.fn(() => true),
}))

// The structural fallback runs against real data; stub it so the fallback-
// wiring test can assert it's reached without standing up a repo/block.
vi.mock('@/extensions/blockInteraction', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/extensions/blockInteraction')>()),
  handleBlockSelectionClick: vi.fn(),
}))

const mockDispatchPointerAction = vi.mocked(dispatchPointerAction)
const mockHandleBlockSelectionClick = vi.mocked(handleBlockSelectionClick)

const context = {
  block: {id: 'block-1'} as Block,
  repo: {} as Repo,
  uiStateBlock: {} as Block,
  types: [],
  topLevelBlockId: 'root',
  inFocus: true,
  inEditMode: false,
  isSelected: false,
  isTopLevel: false,
  contentRenderers: [],
} satisfies BlockInteractionContext

const selectionMouseEvent = (
  target: EventTarget,
  modifiers: Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'shiftKey'>,
) => ({
  target,
  currentTarget: document.createElement('div'),
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
  ...modifiers,
}) as unknown as MouseEvent<HTMLDivElement>

const shellState = (
  overrides: Partial<BlockShellState['shellProps']> = {},
): BlockShellState => ({
  shellProps: {
    'data-block-id': context.block.id,
    'data-editing': 'false',
    tabIndex: 0,
    ref: {current: null} as RefObject<HTMLDivElement | null>,
    ...overrides,
  },
  shortcutSurfaceOptions: {},
})

describe('default editor interactions', () => {
  beforeEach(() => {
    mockDispatchPointerAction.mockClear()
    mockDispatchPointerAction.mockReturnValue(true)
    mockHandleBlockSelectionClick.mockClear()
  })

  it('prevents native text selection when a block selection gesture starts on the shell', () => {
    const target = document.createElement('span')
    const event = selectionMouseEvent(target, {
      ctrlKey: false,
      metaKey: false,
      shiftKey: true,
    })
    const nextState = createBlockSelectionShellState(context, shellState())

    nextState.shellProps.onMouseDownCapture?.(event)

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(event.stopPropagation).not.toHaveBeenCalled()
  })

  it('leaves interactive descendants to their native mouse handling', () => {
    const button = document.createElement('button')
    const target = document.createElement('span')
    button.appendChild(target)
    const event = selectionMouseEvent(target, {
      ctrlKey: false,
      metaKey: false,
      shiftKey: true,
    })
    const nextState = createBlockSelectionShellState(context, shellState())

    nextState.shellProps.onMouseDownCapture?.(event)

    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('routes selection clicks through the pointer dispatcher with the clicked block supplied', () => {
    const pluginClick = vi.fn()
    const target = document.createElement('span')
    const event = selectionMouseEvent(target, {
      ctrlKey: false,
      metaKey: false,
      shiftKey: true,
    })
    const nextState = createBlockSelectionShellState(context, shellState({onClick: pluginClick}))

    nextState.shellProps.onClick?.(event)

    expect(mockDispatchPointerAction).toHaveBeenCalledTimes(1)
    const [dispatchedEvent, supplied] = mockDispatchPointerAction.mock.calls[0]!
    expect(dispatchedEvent).toBe(event)
    expect(supplied).toMatchObject({
      block: context.block,
      uiStateBlock: context.uiStateBlock,
      targetElement: event.currentTarget,
    })
    // A handled gesture never reaches the plugin click handler.
    expect(pluginClick).not.toHaveBeenCalled()
  })

  it('falls back to the structural handler when no pointer action claims the gesture', () => {
    // ctrl/meta toggle and plain reset have no pointer binding, so the
    // dispatcher returns false and the structural handler runs — never the
    // plugin click handler.
    mockDispatchPointerAction.mockReturnValue(false)
    const pluginClick = vi.fn()
    const target = document.createElement('span')
    const event = selectionMouseEvent(target, {
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
    })
    const nextState = createBlockSelectionShellState(context, shellState({onClick: pluginClick}))

    nextState.shellProps.onClick?.(event)

    expect(mockDispatchPointerAction).toHaveBeenCalledTimes(1)
    expect(mockHandleBlockSelectionClick).toHaveBeenCalledWith(context, event)
    expect(pluginClick).not.toHaveBeenCalled()
  })

  it('supplies scope + render-scope deps derived from a nested surface context', () => {
    // The deps the spatial transform and structural handler actually consume —
    // scopeRootId, scopeRootForcesOpen (= !isNestedSurface), renderScopeId — must
    // be forwarded faithfully, not just block/uiStateBlock/targetElement.
    const nestedContext = {
      ...context,
      scopeRootId: 'scope-root',
      blockContext: {isNestedSurface: true, renderScopeId: 'scope-z'},
    } as unknown as BlockInteractionContext
    const target = document.createElement('span')
    const event = selectionMouseEvent(target, {
      ctrlKey: false,
      metaKey: false,
      shiftKey: true,
    })
    const nextState = createBlockSelectionShellState(nestedContext, shellState())

    nextState.shellProps.onClick?.(event)

    const [, supplied] = mockDispatchPointerAction.mock.calls[0]!
    expect(supplied).toMatchObject({
      scopeRootId: 'scope-root',
      scopeRootForcesOpen: false,
      renderScopeId: 'scope-z',
    })
  })

  it('routes plain clicks through the pointer dispatcher (click-to-edit) ahead of any plugin handler', () => {
    // Click-to-edit is now a pointer-bound action; a plain click dispatches it
    // with the clicked block supplied, and a handled gesture never reaches the
    // residual plugin click handler.
    const pluginClick = vi.fn()
    const target = document.createElement('span')
    const event = selectionMouseEvent(target, {
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    })
    const nextState = createBlockSelectionShellState(context, shellState({onClick: pluginClick}))

    nextState.shellProps.onClick?.(event)

    expect(mockDispatchPointerAction).toHaveBeenCalledTimes(1)
    const [dispatchedEvent, supplied] = mockDispatchPointerAction.mock.calls[0]!
    expect(dispatchedEvent).toBe(event)
    expect(supplied).toMatchObject({block: context.block, uiStateBlock: context.uiStateBlock})
    expect(pluginClick).not.toHaveBeenCalled()
  })

  it('falls back to the plugin click handler when no pointer action claims a plain click', () => {
    mockDispatchPointerAction.mockReturnValue(false)
    const pluginClick = vi.fn()
    const target = document.createElement('span')
    const event = selectionMouseEvent(target, {
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    })
    const nextState = createBlockSelectionShellState(context, shellState({onClick: pluginClick}))

    nextState.shellProps.onClick?.(event)

    expect(mockDispatchPointerAction).toHaveBeenCalledTimes(1)
    expect(pluginClick).toHaveBeenCalledWith(event)
  })
})
