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

// jsdom defaults innerWidth to 1024; our gesture handler gates on the
// `(max-width: 767px)` mobile breakpoint, so mock matchMedia to return
// `matches: true` for all tests by default. The non-mobile case is
// asserted explicitly in its own test.
const setMobileViewport = (matches: boolean): void => {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

describe('swipe-quick-actions gesture', () => {
  beforeEach(() => {
    setActiveSwipeBlockId(null)
    setMobileViewport(true)
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

  it('does not open the menu on non-mobile viewports', () => {
    setMobileViewport(false)
    const props = handlers(makeContext('b6'))
    const end = touchEvent('changedTouches', touch(120, 102))
    props.onTouchStart?.(touchEvent('touches', touch(200, 100)))
    props.onTouchMove?.(touchEvent('touches', touch(150, 102)))
    props.onTouchEnd?.(end)
    expect(getActiveSwipeBlockId()).toBeNull()
    // Crucially, the gesture must not be consumed: no preventDefault /
    // stopPropagation, so native scroll / back-swipe stays intact.
    expect(end.preventDefault).not.toHaveBeenCalled()
    expect(end.stopPropagation).not.toHaveBeenCalled()
  })
})
