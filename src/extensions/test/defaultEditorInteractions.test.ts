// @vitest-environment jsdom

import type { MouseEvent } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import type { BlockContentSurfaceProps, BlockInteractionContext } from '@/extensions/blockInteraction'
import { blockSelectionContentSurfaceBehavior } from '@/extensions/defaultEditorInteractions'

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

const selectionMouseDown = (
  target: EventTarget,
  modifiers: Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'shiftKey'>,
) => ({
  target,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
  ...modifiers,
}) as unknown as MouseEvent<HTMLDivElement>

const selectionSurfaceProps = (): BlockContentSurfaceProps => {
  const props = blockSelectionContentSurfaceBehavior(context)
  if (!props) throw new Error('Expected block selection surface props')
  return props
}

describe('default editor interactions', () => {
  it('prevents native text selection when a block selection gesture starts', () => {
    const props = selectionSurfaceProps()
    const target = document.createElement('span')
    const event = selectionMouseDown(target, {
      ctrlKey: false,
      metaKey: false,
      shiftKey: true,
    })

    props.onMouseDownCapture?.(event)

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(event.stopPropagation).not.toHaveBeenCalled()
  })

  it('leaves interactive descendants to their native mouse handling', () => {
    const props = selectionSurfaceProps()
    const button = document.createElement('button')
    const target = document.createElement('span')
    button.appendChild(target)
    const event = selectionMouseDown(target, {
      ctrlKey: false,
      metaKey: false,
      shiftKey: true,
    })

    props.onMouseDownCapture?.(event)

    expect(event.preventDefault).not.toHaveBeenCalled()
  })
})
