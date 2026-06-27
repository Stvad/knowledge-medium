// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { Block } from '../../../data/block'
import type { Repo } from '../../../data/repo'
import {
  BlockInteractionContext,
  shortcutSurfaceActivationsFacet,
} from '@/extensions/blockInteraction.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionTrigger,
  type BlockPointerDependencies,
} from '@/shortcuts/types.js'
import { ENTER_BLOCK_EDIT_MODE_ACTION_ID } from '@/plugins/plain-outliner/clickToEditAction.js'
import {
  enterBlockEditModeOnGestureAction,
  vimClickToFocusTransform,
  vimNormalModeActivation,
} from '../interactions.ts'

// Vim contributes only actions/transforms now — the double-click/tap gestures
// are recognised and dispatched by core's `blockContentPointerGestures`
// (covered in editor/test/defaultInteractions.test.ts), so this suite mocks the edit
// helpers and exercises the action handler + transform directly.
const enterEditModeForBlock = vi.hoisted(() => vi.fn())
const focusBlockWithoutEditing = vi.hoisted(() => vi.fn())
vi.mock('@/extensions/blockInteraction.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/extensions/blockInteraction.js')>()),
  enterEditModeForBlock,
  focusBlockWithoutEditing,
}))

const context = {
  block: {id: 'block-1'} as Block,
  repo: {} as Repo,
  uiStateBlock: {id: 'panel'} as Block,
  types: [],
  topLevelBlockId: 'root',
  inFocus: true,
  inEditMode: false,
  isSelected: false,
  isTopLevel: false,
  contentRenderers: [],
} satisfies BlockInteractionContext

describe('vim normal mode interactions', () => {
  describe('enterBlockEditModeOnGestureAction', () => {
    it('binds both a double-click and a tap', () => {
      expect(enterBlockEditModeOnGestureAction.context).toBe(ActionContextTypes.BLOCK_POINTER)
      expect(enterBlockEditModeOnGestureAction.pointerBinding).toEqual([
        {kind: 'mouse', detail: 2, phase: 'pointerdown'},
        {kind: 'touch', phase: 'tap'},
      ])
    })

    it('enters edit mode at the mouse coordinates a double-click carries', () => {
      enterEditModeForBlock.mockClear()
      const deps: BlockPointerDependencies = {
        block: {id: 'b'} as Block,
        uiStateBlock: {id: 'panel'} as Block,
        targetElement: document.createElement('div'),
        renderScopeId: 'scope-a',
      }
      enterBlockEditModeOnGestureAction.handler(
        deps,
        {clientX: 12, clientY: 34} as unknown as ActionTrigger,
      )
      expect(enterEditModeForBlock).toHaveBeenCalledWith(deps.block, deps.uiStateBlock, 'scope-a', {x: 12, y: 34})
    })

    it('enters edit mode at the changed-touch coordinates a tap carries', () => {
      enterEditModeForBlock.mockClear()
      const deps: BlockPointerDependencies = {
        block: {id: 'b'} as Block,
        uiStateBlock: {id: 'panel'} as Block,
        targetElement: document.createElement('div'),
      }
      enterBlockEditModeOnGestureAction.handler(
        deps,
        {changedTouches: [{clientX: 9, clientY: 11}]} as unknown as ActionTrigger,
      )
      expect(enterEditModeForBlock).toHaveBeenCalledWith(deps.block, deps.uiStateBlock, undefined, {x: 9, y: 11})
    })
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
