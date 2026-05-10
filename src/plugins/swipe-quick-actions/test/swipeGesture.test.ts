import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TouchEvent } from 'react'
import type { Block } from '../../../data/block'
import type { Repo } from '../../../data/repo'
import {
  blockContentSurfacePropsFacet,
  type BlockInteractionContext,
} from '@/extensions/blockInteraction.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { swipeQuickActionsContentSurface } from '../swipeGesture.ts'
import { getActiveSwipeBlockId, setActiveSwipeBlockId } from '../store.ts'

const fakeUiStateBlock = {
  peekProperty: vi.fn().mockReturnValue(undefined),
} as unknown as Block

const makeContext = (id = 'block-1'): BlockInteractionContext => ({
  block: {id} as Block,
  repo: {} as Repo,
  uiStateBlock: fakeUiStateBlock,
  types: [],
  topLevelBlockId: 'root',
  inFocus: true,
  inEditMode: false,
  isSelected: false,
  isTopLevel: false,
  contentRenderers: [],
})

const runtime = () => resolveFacetRuntimeSync([
  blockContentSurfacePropsFacet.of(swipeQuickActionsContentSurface),
])

const handlers = (context = makeContext()) =>
  runtime().read(blockContentSurfacePropsFacet)(context)

const touch = (x: number, y: number) => ({clientX: x, clientY: y})

const touchEvent = (
  list: 'touches' | 'changedTouches',
  point: { clientX: number; clientY: number },
  target: EventTarget = document.createElement('div'),
): TouchEvent<HTMLDivElement> => ({
  target,
  [list]: [point],
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
} as unknown as TouchEvent<HTMLDivElement>)

describe('swipe-quick-actions gesture', () => {
  beforeEach(() => {
    setActiveSwipeBlockId(null)
  })
  afterEach(() => {
    setActiveSwipeBlockId(null)
  })

  it('exposes touch handlers via the surface facet', () => {
    const props = handlers()
    expect(props.onTouchStart).toBeDefined()
    expect(props.onTouchMove).toBeDefined()
    expect(props.onTouchEnd).toBeDefined()
    expect(props.onTouchCancel).toBeDefined()
  })

  it('opens the menu on a sufficient leftward swipe', () => {
    const props = handlers(makeContext('b1'))
    props.onTouchStart?.(touchEvent('touches', touch(200, 100)))
    props.onTouchMove?.(touchEvent('touches', touch(150, 102)))
    props.onTouchEnd?.(touchEvent('changedTouches', touch(120, 102)))
    expect(getActiveSwipeBlockId()).toBe('b1')
  })

  it('ignores small horizontal movement (taps)', () => {
    const props = handlers(makeContext('b2'))
    props.onTouchStart?.(touchEvent('touches', touch(200, 100)))
    props.onTouchEnd?.(touchEvent('changedTouches', touch(195, 101)))
    expect(getActiveSwipeBlockId()).toBeNull()
  })

  it('ignores predominantly vertical drags (scrolls)', () => {
    const props = handlers(makeContext('b3'))
    props.onTouchStart?.(touchEvent('touches', touch(200, 100)))
    props.onTouchEnd?.(touchEvent('changedTouches', touch(180, 220)))
    expect(getActiveSwipeBlockId()).toBeNull()
  })

  it('dismisses the active menu on swipe-right of the same block', () => {
    setActiveSwipeBlockId('b4')
    const props = handlers(makeContext('b4'))
    props.onTouchStart?.(touchEvent('touches', touch(50, 100)))
    props.onTouchEnd?.(touchEvent('changedTouches', touch(140, 100)))
    expect(getActiveSwipeBlockId()).toBeNull()
  })

  it('does not consume swipe-right when no menu is open', () => {
    const props = handlers(makeContext('b5'))
    const end = touchEvent('changedTouches', touch(140, 100))
    props.onTouchStart?.(touchEvent('touches', touch(50, 100)))
    props.onTouchEnd?.(end)
    expect(end.preventDefault).not.toHaveBeenCalled()
    expect(getActiveSwipeBlockId()).toBeNull()
  })
})
