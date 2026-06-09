import { describe, expect, it, vi } from 'vitest'
import type { TouchEvent } from 'react'
import type { Block } from '../../../data/block'
import type { Repo } from '../../../data/repo'
import {
  blockContentSurfacePropsFacet,
  BlockInteractionContext,
  shortcutSurfaceActivationsFacet,
} from '@/extensions/blockInteraction.js'
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionTrigger,
  type BlockPointerDependencies,
} from '@/shortcuts/types.js'
import { ENTER_BLOCK_EDIT_MODE_ACTION_ID } from '@/plugins/plain-outliner/clickToEditAction.js'
import {
  vimClickToFocusTransform,
  vimContentSurfaceBehavior,
  vimNormalModeActivation,
} from '../interactions.ts'

const focusBlockWithoutEditing = vi.hoisted(() => vi.fn())
vi.mock('@/extensions/blockInteraction.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/extensions/blockInteraction.js')>()),
  focusBlockWithoutEditing,
}))

const interactiveTargets: Array<[string, () => HTMLElement]> = [
  ['anchor', () => {
    const link = document.createElement('a')
    link.href = 'https://example.com'
    return link
  }],
  ['button', () => document.createElement('button')],
  ['ARIA button', () => {
    const button = document.createElement('span')
    button.setAttribute('role', 'button')
    return button
  }],
  ['controlled video', () => {
    const video = document.createElement('video')
    video.controls = true
    return video
  }],
]

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

  describe('click-to-focus transform (single click focuses, does not edit)', () => {
    const editAction: ActionConfig = {
      id: ENTER_BLOCK_EDIT_MODE_ACTION_ID,
      description: 'Enter edit mode on click',
      context: ActionContextTypes.BLOCK_POINTER,
      handler: vi.fn(),
    }
    const transformed = vimClickToFocusTransform.apply(editAction)
    if (!transformed) throw new Error('expected vim transform to return a decorated action')
    const focusHandler = transformed.handler

    const deps: BlockPointerDependencies = {
      block: {id: 'block-1'} as Block,
      uiStateBlock: {id: 'panel'} as Block,
      targetElement: document.createElement('div'),
      renderScopeId: 'scope-a',
    }

    it('focuses the clicked block without entering edit mode', () => {
      // Interactive-target exclusion is the block-pointer context's job; the
      // transform just replaces the edit handler with focus-without-editing.
      focusBlockWithoutEditing.mockClear()
      focusHandler(deps, {} as ActionTrigger)

      expect(editAction.handler).not.toHaveBeenCalled()
      expect(focusBlockWithoutEditing).toHaveBeenCalledWith(deps.block, deps.uiStateBlock, 'scope-a')
    })
  })

  it.each(interactiveTargets)('does not turn %s taps into edit-mode taps', (_label, createTarget) => {
    const runtime = resolveFacetRuntimeSync([
      blockContentSurfacePropsFacet.of(vimContentSurfaceBehavior),
    ])
    const props = runtime.read(blockContentSurfacePropsFacet)(context)
    const interactive = createTarget()
    const child = document.createElement('span')
    interactive.appendChild(child)

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
