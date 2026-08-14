// @vitest-environment happy-dom
import type { MouseEvent, RefObject, TouchEvent } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import type {
  BlockContentSurfaceProps,
  BlockInteractionContext,
  BlockResolveContext,
  BlockShellState,
} from '@/extensions/blockInteraction'
import {
  blockContentPointerGestures,
  createBlockSelectionShellState,
} from '../defaultInteractions'
import { dispatchPointerAction } from '@/shortcuts/pointerAction'

// All block clicks route through the unified pointer dispatcher; mock it so
// these unit tests don't need a mounted coordinator. Returning true = "a
// pointer-bound action handled it"; false exercises the facet fallback branch.
// (Interactive-target exclusion now lives on the block-pointer context's
// pointerTargetFilter — exercised in HotkeyReconciler's dispatch tests, not at
// the shell, which dispatches uniformly.)
vi.mock('@/shortcuts/pointerAction', () => ({
  dispatchPointerAction: vi.fn(() => true),
}))

const mockDispatchPointerAction = vi.mocked(dispatchPointerAction)

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

  it('leaves interactive descendants to their native mouse handling on mousedown', () => {
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

  it('routes a click through the pointer dispatcher with the clicked block supplied', () => {
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
    // A handled gesture never reaches the residual plugin click handler.
    expect(pluginClick).not.toHaveBeenCalled()
  })

  it('dispatches plain and modifier clicks uniformly (no shell-level branching)', () => {
    // shift (extend), ctrl/cmd (toggle), and plain (edit/focus) all resolve
    // through the same dispatch — the shell no longer special-cases by modifier.
    const nextState = createBlockSelectionShellState(context, shellState())
    for (const modifiers of [
      {ctrlKey: false, metaKey: false, shiftKey: true},
      {ctrlKey: true, metaKey: false, shiftKey: false},
      {ctrlKey: false, metaKey: false, shiftKey: false},
    ]) {
      mockDispatchPointerAction.mockClear()
      nextState.shellProps.onClick?.(selectionMouseEvent(document.createElement('span'), modifiers))
      expect(mockDispatchPointerAction).toHaveBeenCalledTimes(1)
    }
  })

  it('supplies scope + render-scope deps derived from a nested surface context', () => {
    // The deps the pointer actions consume — scopeRootId, scopeRootForcesOpen
    // (= !isNestedSurface), renderScopeId — must be forwarded faithfully, not
    // just block/uiStateBlock/targetElement.
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

  it('falls back to the plugin click handler when no pointer action claims the click', () => {
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

describe('blockContentPointerGestures (content-surface pointer gestures)', () => {
  beforeEach(() => {
    mockDispatchPointerAction.mockClear()
    mockDispatchPointerAction.mockReturnValue(true)
  })

  const mouseDown = (overrides: Partial<MouseEvent<HTMLDivElement>> = {}): MouseEvent<HTMLDivElement> => ({
    type: 'mousedown',
    detail: 2,
    defaultPrevented: false,
    currentTarget: document.createElement('div'),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  }) as unknown as MouseEvent<HTMLDivElement>

  const touchAt = (x: number, y: number): TouchEvent<HTMLDivElement> => ({
    currentTarget: document.createElement('div'),
    touches: [{clientX: x, clientY: y}],
    changedTouches: [{clientX: x, clientY: y}],
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  }) as unknown as TouchEvent<HTMLDivElement>

  const props = () =>
    blockContentPointerGestures(context as BlockResolveContext) as BlockContentSurfaceProps

  it('routes a content mousedown through the pointer dispatcher with the block supplied', () => {
    const event = mouseDown({detail: 2})
    props().onMouseDownCapture?.(event)

    expect(mockDispatchPointerAction).toHaveBeenCalledTimes(1)
    const [dispatchedEvent, supplied] = mockDispatchPointerAction.mock.calls[0]!
    expect(dispatchedEvent).toBe(event)
    expect(supplied).toMatchObject({
      block: context.block,
      uiStateBlock: context.uiStateBlock,
      targetElement: event.currentTarget,
    })
  })

  it('skips a mousedown a shell selection gesture already preventDefaulted', () => {
    props().onMouseDownCapture?.(mouseDown({defaultPrevented: true}))
    expect(mockDispatchPointerAction).not.toHaveBeenCalled()
  })

  it('ignores a single press (only a multi-click is a pointerdown gesture)', () => {
    props().onMouseDownCapture?.(mouseDown({detail: 1}))
    expect(mockDispatchPointerAction).not.toHaveBeenCalled()
  })

  it('routes a tap when touchstart→touchend stays within the tap thresholds', () => {
    const surface = props()
    surface.onTouchStart?.(touchAt(5, 5))
    const end = touchAt(6, 6)
    surface.onTouchEnd?.(end)

    expect(mockDispatchPointerAction).toHaveBeenCalledTimes(1)
    expect(mockDispatchPointerAction.mock.calls[0]![0]).toBe(end)
  })

  it('ignores a touch that moves beyond the tap threshold (a drag, not a tap)', () => {
    const surface = props()
    surface.onTouchStart?.(touchAt(5, 5))
    surface.onTouchEnd?.(touchAt(80, 80))
    expect(mockDispatchPointerAction).not.toHaveBeenCalled()
  })
})
