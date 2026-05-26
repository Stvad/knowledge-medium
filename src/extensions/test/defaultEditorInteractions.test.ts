import type { MouseEvent, RefObject } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import type {
  BlockInteractionContext,
  BlockShellState,
} from '@/extensions/blockInteraction'
import {
  createBlockSelectionShellState,
} from '@/extensions/defaultEditorInteractions'

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

  it('routes selection clicks to the block selection owner instead of plugin click handlers', () => {
    const pluginClick = vi.fn()
    const applySelectionClick = vi.fn()
    const target = document.createElement('span')
    const event = selectionMouseEvent(target, {
      ctrlKey: false,
      metaKey: false,
      shiftKey: true,
    })
    const nextState = createBlockSelectionShellState(
      context,
      shellState({onClick: pluginClick}),
      applySelectionClick,
    )

    nextState.shellProps.onClick?.(event)

    expect(applySelectionClick).toHaveBeenCalledWith(context, event)
    expect(pluginClick).not.toHaveBeenCalled()
  })

  it('passes non-selection clicks through to the plugin click handler', () => {
    const pluginClick = vi.fn()
    const applySelectionClick = vi.fn()
    const target = document.createElement('span')
    const event = selectionMouseEvent(target, {
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    })
    const nextState = createBlockSelectionShellState(
      context,
      shellState({onClick: pluginClick}),
      applySelectionClick,
    )

    nextState.shellProps.onClick?.(event)

    expect(pluginClick).toHaveBeenCalledWith(event)
    expect(applySelectionClick).not.toHaveBeenCalled()
  })
})
