import { describe, expect, it, vi } from 'vitest'
import type { MouseEvent, TouchEvent } from 'react'
import type { Block } from '../../../data/block'
import type { Repo } from '../../../data/repo'
import {
  blockContentSurfacePropsFacet,
  BlockInteractionContext,
  shortcutSurfaceActivationsFacet,
} from '@/extensions/blockInteraction.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { ActionContextTypes } from '@/shortcuts/types.ts'
import {
  vimBlockClickBehavior,
  vimContentSurfaceBehavior,
  vimNormalModeActivation,
} from '../interactions.ts'

const context = {
  block: {id: 'block-1'} as Block,
  repo: {} as Repo,
  uiStateBlock: {} as Block,
  topLevelBlockId: 'root',
  inFocus: true,
  inEditMode: false,
  isSelected: false,
  isTopLevel: false,
  contentRenderers: [],
} satisfies BlockInteractionContext

describe('vim normal mode interactions', () => {
  it('contributes content-surface props for double-click and tap detection', () => {
    const runtime = resolveFacetRuntimeSync([
      blockContentSurfacePropsFacet.of(vimContentSurfaceBehavior),
    ])

    const props = runtime.read(blockContentSurfacePropsFacet)(context)

    expect(props.onMouseDownCapture).toBeDefined()
    expect(props.onTouchStart).toBeDefined()
    expect(props.onTouchEnd).toBeDefined()
  })

  it('leaves anchor clicks to browser navigation', async () => {
    const link = document.createElement('a')
    link.href = 'https://example.com'
    const child = document.createElement('span')
    link.appendChild(child)

    const event = {
      target: child,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as MouseEvent

    const handler = vimBlockClickBehavior(context)
    if (!handler) throw new Error('Expected Vim block click handler')

    await handler(event)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
  })

  it('does not turn link taps into edit-mode taps', () => {
    const runtime = resolveFacetRuntimeSync([
      blockContentSurfacePropsFacet.of(vimContentSurfaceBehavior),
    ])
    const props = runtime.read(blockContentSurfacePropsFacet)(context)
    const link = document.createElement('a')
    link.href = 'https://example.com'
    const child = document.createElement('span')
    link.appendChild(child)

    const startEvent = {
      target: child,
      touches: [{clientX: 1, clientY: 1}],
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as TouchEvent<HTMLDivElement>
    const endEvent = {
      target: child,
      changedTouches: [{clientX: 1, clientY: 1}],
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as TouchEvent<HTMLDivElement>

    props.onTouchStart?.(startEvent)
    props.onTouchEnd?.(endEvent)

    expect(startEvent.preventDefault).not.toHaveBeenCalled()
    expect(startEvent.stopPropagation).not.toHaveBeenCalled()
    expect(endEvent.preventDefault).not.toHaveBeenCalled()
    expect(endEvent.stopPropagation).not.toHaveBeenCalled()
  })

  it('defines Vim normal mode as a shortcut surface activation', () => {
    const runtime = resolveFacetRuntimeSync([
      shortcutSurfaceActivationsFacet.of(vimNormalModeActivation),
    ])

    const resolveActivations = runtime.read(shortcutSurfaceActivationsFacet)

    expect(resolveActivations({
      ...context,
      surface: 'block',
    })).toEqual([{
      context: ActionContextTypes.NORMAL_MODE,
      dependencies: {
        block: context.block,
      },
    }])
    expect(resolveActivations({
      ...context,
      inEditMode: true,
      surface: 'block',
    })).toEqual([])
  })
})
