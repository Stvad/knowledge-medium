import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TouchEvent } from 'react'
import type { Block } from '../../../data/block'
import type { Repo } from '../../../data/repo'
import type { PropertySchema } from '@/data/api'
import {
  blockContentSurfacePropsFacet,
  type BlockInteractionContext,
} from '@/extensions/blockInteraction.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { swipeQuickActionsContentSurface } from '../swipeGesture.ts'
import { swipeActiveBlockIdProp } from '../property.ts'

/** Minimal stand-in for the panel UI-state block. Backs `peekProperty`
 *  / `set` against an in-memory map keyed by schema name, mirroring how
 *  the real Block stores property values. The async `set` matches the
 *  real signature; tests await it for state assertions. */
const makeFakeUiStateBlock = (): Block => {
  const props = new Map<string, unknown>()
  return {
    peekProperty: vi.fn((schema: PropertySchema<unknown>) => props.get(schema.name)),
    set: vi.fn(async (schema: PropertySchema<unknown>, value: unknown) => {
      if (value === undefined) props.delete(schema.name)
      else props.set(schema.name, value)
    }),
  } as unknown as Block
}

const makeContext = (id = 'block-1', uiStateBlock = makeFakeUiStateBlock()): BlockInteractionContext => ({
  block: {id} as Block,
  repo: {} as Repo,
  uiStateBlock,
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
    setMobileViewport(true)
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('exposes touch handlers via the surface facet', () => {
    const props = handlers()
    expect(props.onTouchStart).toBeDefined()
    expect(props.onTouchMove).toBeDefined()
    expect(props.onTouchEnd).toBeDefined()
    expect(props.onTouchCancel).toBeDefined()
  })

  it('writes the swiped block id to the panel UI-state on a leftward swipe', async () => {
    const uiState = makeFakeUiStateBlock()
    const props = handlers(makeContext('b1', uiState))
    props.onTouchStart?.(touchEvent('touches', touch(200, 100)))
    props.onTouchMove?.(touchEvent('touches', touch(150, 102)))
    props.onTouchEnd?.(touchEvent('changedTouches', touch(120, 102)))
    expect(uiState.peekProperty(swipeActiveBlockIdProp)).toBe('b1')
  })

  it('only writes to the active panel\'s UI-state, leaving other panels alone', async () => {
    // Two panels: gestures in panel A must not touch panel B's state.
    const panelA = makeFakeUiStateBlock()
    const panelB = makeFakeUiStateBlock()
    const propsA = handlers(makeContext('b-shared', panelA))
    propsA.onTouchStart?.(touchEvent('touches', touch(200, 100)))
    propsA.onTouchEnd?.(touchEvent('changedTouches', touch(120, 100)))
    expect(panelA.peekProperty(swipeActiveBlockIdProp)).toBe('b-shared')
    expect(panelB.peekProperty(swipeActiveBlockIdProp)).toBeUndefined()
  })

  it('ignores small horizontal movement (taps)', () => {
    const uiState = makeFakeUiStateBlock()
    const props = handlers(makeContext('b2', uiState))
    props.onTouchStart?.(touchEvent('touches', touch(200, 100)))
    props.onTouchEnd?.(touchEvent('changedTouches', touch(195, 101)))
    expect(uiState.peekProperty(swipeActiveBlockIdProp)).toBeUndefined()
  })

  it('ignores predominantly vertical drags (scrolls)', () => {
    const uiState = makeFakeUiStateBlock()
    const props = handlers(makeContext('b3', uiState))
    props.onTouchStart?.(touchEvent('touches', touch(200, 100)))
    props.onTouchEnd?.(touchEvent('changedTouches', touch(180, 220)))
    expect(uiState.peekProperty(swipeActiveBlockIdProp)).toBeUndefined()
  })

  it('clears the panel UI-state on swipe-right when the same block is the active one', async () => {
    const uiState = makeFakeUiStateBlock()
    await uiState.set(swipeActiveBlockIdProp, 'b4')
    const props = handlers(makeContext('b4', uiState))
    props.onTouchStart?.(touchEvent('touches', touch(50, 100)))
    props.onTouchEnd?.(touchEvent('changedTouches', touch(140, 100)))
    expect(uiState.peekProperty(swipeActiveBlockIdProp)).toBeUndefined()
  })

  it('does not consume swipe-right when no menu is open in this panel', () => {
    const uiState = makeFakeUiStateBlock()
    const props = handlers(makeContext('b5', uiState))
    const end = touchEvent('changedTouches', touch(140, 100))
    props.onTouchStart?.(touchEvent('touches', touch(50, 100)))
    props.onTouchEnd?.(end)
    expect(end.preventDefault).not.toHaveBeenCalled()
    expect(uiState.peekProperty(swipeActiveBlockIdProp)).toBeUndefined()
  })

  it('does not dismiss when the active id in this panel belongs to a different block', async () => {
    // Panel has menu open for block X; user swipes right on block Y in
    // the same panel — Y's menu isn't open, so nothing should change.
    const uiState = makeFakeUiStateBlock()
    await uiState.set(swipeActiveBlockIdProp, 'X')
    const props = handlers(makeContext('Y', uiState))
    props.onTouchStart?.(touchEvent('touches', touch(50, 100)))
    props.onTouchEnd?.(touchEvent('changedTouches', touch(140, 100)))
    expect(uiState.peekProperty(swipeActiveBlockIdProp)).toBe('X')
  })

  it('does not open the menu on non-mobile viewports', () => {
    setMobileViewport(false)
    const uiState = makeFakeUiStateBlock()
    const props = handlers(makeContext('b6', uiState))
    const end = touchEvent('changedTouches', touch(120, 102))
    props.onTouchStart?.(touchEvent('touches', touch(200, 100)))
    props.onTouchMove?.(touchEvent('touches', touch(150, 102)))
    props.onTouchEnd?.(end)
    expect(uiState.peekProperty(swipeActiveBlockIdProp)).toBeUndefined()
    // Crucially, the gesture must not be consumed: no preventDefault /
    // stopPropagation, so native scroll / back-swipe stays intact.
    expect(end.preventDefault).not.toHaveBeenCalled()
    expect(end.stopPropagation).not.toHaveBeenCalled()
  })
})
