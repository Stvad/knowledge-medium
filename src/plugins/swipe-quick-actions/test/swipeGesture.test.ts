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

interface TestTouch {
  identifier: number
  clientX: number
  clientY: number
}

const touch = (x: number, y: number, identifier = 1): TestTouch => ({
  identifier,
  clientX: x,
  clientY: y,
})

const touchEvent = (
  list: 'touches' | 'changedTouches',
  points: TestTouch | readonly TestTouch[],
  target: EventTarget = document.createElement('div'),
): TouchEvent<HTMLDivElement> => ({
  target,
  [list]: Array.isArray(points) ? points : [points],
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
    props.onTouchStart?.(touchEvent('changedTouches', touch(200, 100)))
    props.onTouchMove?.(touchEvent('touches', touch(150, 102)))
    props.onTouchEnd?.(touchEvent('changedTouches', touch(120, 102)))
    expect(uiState.peekProperty(swipeActiveBlockIdProp)).toBe('b1')
  })

  it('opens the menu when the swipe starts on a rendered link', () => {
    const uiState = makeFakeUiStateBlock()
    const props = handlers(makeContext('b-link-source', uiState))
    const link = document.createElement('a')
    link.href = 'https://example.com'

    props.onTouchStart?.(touchEvent('changedTouches', touch(200, 100), link))
    props.onTouchMove?.(touchEvent('touches', touch(150, 102), link))
    props.onTouchEnd?.(touchEvent('changedTouches', touch(120, 102), link))

    expect(uiState.peekProperty(swipeActiveBlockIdProp)).toBe('b-link-source')
  })

  it('keeps non-link interactive controls out of the swipe gesture', () => {
    const uiState = makeFakeUiStateBlock()
    const props = handlers(makeContext('b-button-source', uiState))
    const button = document.createElement('button')

    props.onTouchStart?.(touchEvent('changedTouches', touch(200, 100), button))
    props.onTouchMove?.(touchEvent('touches', touch(150, 102), button))
    props.onTouchEnd?.(touchEvent('changedTouches', touch(120, 102), button))

    expect(uiState.peekProperty(swipeActiveBlockIdProp)).toBeUndefined()
  })

  it('only writes to the active panel\'s UI-state, leaving other panels alone', async () => {
    // Two panels: gestures in panel A must not touch panel B's state.
    const panelA = makeFakeUiStateBlock()
    const panelB = makeFakeUiStateBlock()
    const propsA = handlers(makeContext('b-shared', panelA))
    propsA.onTouchStart?.(touchEvent('changedTouches', touch(200, 100)))
    propsA.onTouchEnd?.(touchEvent('changedTouches', touch(120, 100)))
    expect(panelA.peekProperty(swipeActiveBlockIdProp)).toBe('b-shared')
    expect(panelB.peekProperty(swipeActiveBlockIdProp)).toBeUndefined()
  })

  it('ignores small horizontal movement (taps)', () => {
    const uiState = makeFakeUiStateBlock()
    const props = handlers(makeContext('b2', uiState))
    props.onTouchStart?.(touchEvent('changedTouches', touch(200, 100)))
    props.onTouchEnd?.(touchEvent('changedTouches', touch(195, 101)))
    expect(uiState.peekProperty(swipeActiveBlockIdProp)).toBeUndefined()
  })

  it('ignores predominantly vertical drags (scrolls)', () => {
    const uiState = makeFakeUiStateBlock()
    const props = handlers(makeContext('b3', uiState))
    props.onTouchStart?.(touchEvent('changedTouches', touch(200, 100)))
    props.onTouchEnd?.(touchEvent('changedTouches', touch(180, 220)))
    expect(uiState.peekProperty(swipeActiveBlockIdProp)).toBeUndefined()
  })

  it('clears the panel UI-state on swipe-right when the same block is the active one', async () => {
    const uiState = makeFakeUiStateBlock()
    await uiState.set(swipeActiveBlockIdProp, 'b4')
    const props = handlers(makeContext('b4', uiState))
    props.onTouchStart?.(touchEvent('changedTouches', touch(50, 100)))
    props.onTouchEnd?.(touchEvent('changedTouches', touch(140, 100)))
    expect(uiState.peekProperty(swipeActiveBlockIdProp)).toBeUndefined()
  })

  it('does not consume swipe-right when no menu is open in this panel', () => {
    const uiState = makeFakeUiStateBlock()
    const props = handlers(makeContext('b5', uiState))
    const end = touchEvent('changedTouches', touch(140, 100))
    props.onTouchStart?.(touchEvent('changedTouches', touch(50, 100)))
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
    props.onTouchStart?.(touchEvent('changedTouches', touch(50, 100)))
    props.onTouchEnd?.(touchEvent('changedTouches', touch(140, 100)))
    expect(uiState.peekProperty(swipeActiveBlockIdProp)).toBe('X')
  })

  it('ignores a second finger\'s coords during a single-finger swipe', () => {
    // First finger starts the gesture and travels left; a second finger
    // taps somewhere far to the right mid-gesture. Without
    // identifier-based pairing, the second finger's clientX could land
    // at index 0 of `touches` / `changedTouches` and produce a bogus
    // dx that flips the gesture's direction.
    const uiState = makeFakeUiStateBlock()
    const props = handlers(makeContext('b-multi', uiState))
    const tracked = (x: number) => touch(x, 100, 1)
    const distractor = touch(800, 100, 2)

    props.onTouchStart?.(touchEvent('changedTouches', tracked(200)))
    // touches list now contains both fingers — distractor at index 0.
    props.onTouchMove?.(touchEvent('touches', [distractor, tracked(150)]))
    // changedTouches on end has BOTH leaving; the tracked one is what
    // we want, regardless of order.
    props.onTouchEnd?.(touchEvent('changedTouches', [distractor, tracked(120)]))
    expect(uiState.peekProperty(swipeActiveBlockIdProp)).toBe('b-multi')
  })

  it('does not flip on a second finger\'s end event', () => {
    // First finger starts going left; a second finger lifts off (e.g.
    // a tap-and-release). The second finger's end shouldn't terminate
    // our gesture.
    const uiState = makeFakeUiStateBlock()
    const props = handlers(makeContext('b-multi-end', uiState))
    const tracked = (x: number) => touch(x, 100, 1)
    const distractor = touch(800, 100, 2)

    props.onTouchStart?.(touchEvent('changedTouches', tracked(200)))
    // Distractor finger's end fires while tracked is still down. The
    // gesture must stay alive (no menu open yet, but state retained).
    props.onTouchEnd?.(touchEvent('changedTouches', distractor))
    expect(uiState.peekProperty(swipeActiveBlockIdProp)).toBeUndefined()
    // Now the tracked finger lifts after a left swipe — should fire.
    props.onTouchEnd?.(touchEvent('changedTouches', tracked(120)))
    expect(uiState.peekProperty(swipeActiveBlockIdProp)).toBe('b-multi-end')
  })

  it('locks the gesture to the first finger; later touchstarts are ignored', () => {
    const uiState = makeFakeUiStateBlock()
    const props = handlers(makeContext('b-lock', uiState))
    const first = touch(200, 100, 1)
    const second = touch(800, 100, 2) // would be a swipe-right if tracked

    props.onTouchStart?.(touchEvent('changedTouches', first))
    // Second finger lands; if we re-keyed the gesture to it, the
    // 800 → 750 motion below would not look like a leftward swipe.
    props.onTouchStart?.(touchEvent('changedTouches', second))
    props.onTouchEnd?.(touchEvent('changedTouches', touch(120, 100, 1)))
    expect(uiState.peekProperty(swipeActiveBlockIdProp)).toBe('b-lock')
  })

  it('does not open the menu on non-mobile viewports', () => {
    setMobileViewport(false)
    const uiState = makeFakeUiStateBlock()
    const props = handlers(makeContext('b6', uiState))
    const end = touchEvent('changedTouches', touch(120, 102))
    props.onTouchStart?.(touchEvent('changedTouches', touch(200, 100)))
    props.onTouchMove?.(touchEvent('touches', touch(150, 102)))
    props.onTouchEnd?.(end)
    expect(uiState.peekProperty(swipeActiveBlockIdProp)).toBeUndefined()
    // Crucially, the gesture must not be consumed: no preventDefault /
    // stopPropagation, so native scroll / back-swipe stays intact.
    expect(end.preventDefault).not.toHaveBeenCalled()
    expect(end.stopPropagation).not.toHaveBeenCalled()
  })
})
