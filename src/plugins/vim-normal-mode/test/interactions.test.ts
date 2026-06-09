import { describe, expect, it, vi } from 'vitest'
import type { MouseEvent, TouchEvent } from 'react'
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
  enterBlockEditModeOnGestureAction,
  vimClickToFocusTransform,
  vimContentSurfaceBehavior,
  vimNormalModeActivation,
} from '../interactions.ts'

const dispatchPointerAction = vi.hoisted(() =>
  vi.fn<(event: unknown, deps: unknown) => boolean>(() => true),
)
vi.mock('@/shortcuts/pointerAction.js', () => ({dispatchPointerAction}))

const enterEditModeForBlock = vi.hoisted(() => vi.fn())
const focusBlockWithoutEditing = vi.hoisted(() => vi.fn())
vi.mock('@/extensions/blockInteraction.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/extensions/blockInteraction.js')>()),
  enterEditModeForBlock,
  focusBlockWithoutEditing,
}))

// isBlockInEditMode short-circuits on isFocusedBlock, so this gate alone decides
// whether the surface treats the block as currently editing.
const isFocusedBlock = vi.hoisted(() => vi.fn(() => false))
vi.mock('@/data/properties.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/data/properties.js')>()),
  isFocusedBlock,
}))

const context = {
  block: {id: 'block-1'} as Block,
  repo: {} as Repo,
  uiStateBlock: {id: 'panel', peekProperty: () => true} as unknown as Block,
  types: [],
  topLevelBlockId: 'root',
  scopeRootId: 'root',
  inFocus: true,
  inEditMode: false,
  isSelected: false,
  isTopLevel: false,
  contentRenderers: [],
} satisfies BlockInteractionContext

const surfaceProps = () => {
  const runtime = resolveFacetRuntimeSync([
    blockContentSurfacePropsFacet.of(vimContentSurfaceBehavior),
  ])
  return runtime.read(blockContentSurfacePropsFacet)(context)
}

const mouseDown = (overrides: Partial<MouseEvent<HTMLDivElement>> = {}): MouseEvent<HTMLDivElement> => ({
  type: 'mousedown',
  detail: 2,
  defaultPrevented: false,
  currentTarget: document.createElement('div'),
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
  ...overrides,
}) as unknown as MouseEvent<HTMLDivElement>

const touchAt = (x: number, y: number) => ({
  currentTarget: document.createElement('div'),
  touches: [{clientX: x, clientY: y}],
  changedTouches: [{clientX: x, clientY: y}],
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
}) as unknown as TouchEvent<HTMLDivElement>

describe('vim normal mode interactions', () => {
  it('contributes content-surface props for double-click and tap detection', () => {
    const props = surfaceProps()
    expect(props.onMouseDownCapture).toBeDefined()
    expect(props.onTouchStart).toBeDefined()
    expect(props.onTouchEnd).toBeDefined()
  })

  describe('double-click dispatch', () => {
    it('dispatches a block-pointer gesture with the clicked block deps supplied', () => {
      dispatchPointerAction.mockClear()
      isFocusedBlock.mockReturnValue(false)
      const props = surfaceProps()
      const event = mouseDown({detail: 2})

      props.onMouseDownCapture?.(event)

      expect(dispatchPointerAction).toHaveBeenCalledTimes(1)
      const [dispatchedEvent, deps] = dispatchPointerAction.mock.calls[0] as [
        MouseEvent<HTMLDivElement>,
        BlockPointerDependencies,
      ]
      expect(dispatchedEvent).toBe(event)
      expect(deps.block).toBe(context.block)
      expect(deps.uiStateBlock).toBe(context.uiStateBlock)
      expect(deps.scopeRootId).toBe('root')
      expect(deps.targetElement).toBe(event.currentTarget)
    })

    it('ignores a single click (only detail === 2 is a double-click)', () => {
      dispatchPointerAction.mockClear()
      isFocusedBlock.mockReturnValue(false)
      surfaceProps().onMouseDownCapture?.(mouseDown({detail: 1}))
      expect(dispatchPointerAction).not.toHaveBeenCalled()
    })

    it('does not dispatch while the block is already being edited', () => {
      dispatchPointerAction.mockClear()
      isFocusedBlock.mockReturnValue(true) // + peekProperty isEditing → true
      surfaceProps().onMouseDownCapture?.(mouseDown({detail: 2}))
      expect(dispatchPointerAction).not.toHaveBeenCalled()
    })
  })

  describe('tap dispatch', () => {
    it('dispatches when touchstart→touchend stays within the tap thresholds', () => {
      dispatchPointerAction.mockClear()
      isFocusedBlock.mockReturnValue(false)
      const props = surfaceProps()
      props.onTouchStart?.(touchAt(5, 5))
      const end = touchAt(6, 6)
      props.onTouchEnd?.(end)

      expect(dispatchPointerAction).toHaveBeenCalledTimes(1)
      expect(dispatchPointerAction.mock.calls[0]?.[0]).toBe(end)
    })

    it('does not dispatch when the touch moves beyond the tap threshold (a drag)', () => {
      dispatchPointerAction.mockClear()
      isFocusedBlock.mockReturnValue(false)
      const props = surfaceProps()
      props.onTouchStart?.(touchAt(5, 5))
      props.onTouchEnd?.(touchAt(80, 80))
      expect(dispatchPointerAction).not.toHaveBeenCalled()
    })
  })

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
