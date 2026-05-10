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
import {
  SWIPE_QUICK_ACTION_CLOSE_EVENT,
  SWIPE_QUICK_ACTION_OPEN_EVENT,
  type SwipeQuickActionMenuEvent,
} from '../events.ts'

/** Minimal stand-in for the panel UI-state block. The gesture only reads
 *  focus/editing from it now; menu open state is local to SwipeActionMenu. */
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
  currentTarget: EventTarget = target,
): TouchEvent<HTMLDivElement> => ({
  target,
  currentTarget,
  [list]: Array.isArray(points) ? points : [points],
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
} as unknown as TouchEvent<HTMLDivElement>)

const recordOpenEvents = (target: EventTarget): string[] => {
  const opened: string[] = []
  target.addEventListener(SWIPE_QUICK_ACTION_OPEN_EVENT, event => {
    const menuEvent = event as SwipeQuickActionMenuEvent
    opened.push(menuEvent.detail.blockId)
    event.preventDefault()
  })
  return opened
}

const recordCloseEvents = (
  target: EventTarget,
  activeBlockId: string | undefined,
): string[] => {
  const closed: string[] = []
  target.addEventListener(SWIPE_QUICK_ACTION_CLOSE_EVENT, event => {
    const menuEvent = event as SwipeQuickActionMenuEvent
    closed.push(menuEvent.detail.blockId)
    if (menuEvent.detail.blockId === activeBlockId) event.preventDefault()
  })
  return closed
}

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

  it('dispatches a panel-local open event on a leftward swipe', () => {
    const surface = document.createElement('div')
    const opened = recordOpenEvents(surface)
    const props = handlers(makeContext('b1'))
    props.onTouchStart?.(touchEvent('changedTouches', touch(200, 100), surface))
    props.onTouchMove?.(touchEvent('touches', touch(150, 102), surface))
    const end = touchEvent('changedTouches', touch(120, 102), surface)
    props.onTouchEnd?.(end)
    expect(opened).toEqual(['b1'])
    expect(end.preventDefault).toHaveBeenCalled()
    expect(end.stopPropagation).toHaveBeenCalled()
  })

  it('opens the menu when the swipe starts on a rendered link', () => {
    const surface = document.createElement('div')
    const opened = recordOpenEvents(surface)
    const props = handlers(makeContext('b-link-source'))
    const link = document.createElement('a')
    link.href = 'https://example.com'
    surface.append(link)

    props.onTouchStart?.(touchEvent('changedTouches', touch(200, 100), link, surface))
    props.onTouchMove?.(touchEvent('touches', touch(150, 102), link, surface))
    props.onTouchEnd?.(touchEvent('changedTouches', touch(120, 102), link, surface))

    expect(opened).toEqual(['b-link-source'])
  })

  it('keeps non-link interactive controls out of the swipe gesture', () => {
    const surface = document.createElement('div')
    const opened = recordOpenEvents(surface)
    const props = handlers(makeContext('b-button-source'))
    const button = document.createElement('button')
    surface.append(button)

    props.onTouchStart?.(touchEvent('changedTouches', touch(200, 100), button, surface))
    props.onTouchMove?.(touchEvent('touches', touch(150, 102), button, surface))
    props.onTouchEnd?.(touchEvent('changedTouches', touch(120, 102), button, surface))

    expect(opened).toEqual([])
  })

  it('bubbles the open event only through the touched panel', () => {
    const panelA = document.createElement('div')
    const panelB = document.createElement('div')
    const surfaceA = document.createElement('div')
    panelA.append(surfaceA)
    const openedA = recordOpenEvents(panelA)
    const openedB = recordOpenEvents(panelB)
    const propsA = handlers(makeContext('b-shared'))

    propsA.onTouchStart?.(touchEvent('changedTouches', touch(200, 100), surfaceA))
    propsA.onTouchEnd?.(touchEvent('changedTouches', touch(120, 100), surfaceA))

    expect(openedA).toEqual(['b-shared'])
    expect(openedB).toEqual([])
  })

  it('ignores small horizontal movement (taps)', () => {
    const surface = document.createElement('div')
    const opened = recordOpenEvents(surface)
    const props = handlers(makeContext('b2'))
    props.onTouchStart?.(touchEvent('changedTouches', touch(200, 100), surface))
    props.onTouchEnd?.(touchEvent('changedTouches', touch(195, 101), surface))
    expect(opened).toEqual([])
  })

  it('ignores predominantly vertical drags (scrolls)', () => {
    const surface = document.createElement('div')
    const opened = recordOpenEvents(surface)
    const props = handlers(makeContext('b3'))
    props.onTouchStart?.(touchEvent('changedTouches', touch(200, 100), surface))
    props.onTouchEnd?.(touchEvent('changedTouches', touch(180, 220), surface))
    expect(opened).toEqual([])
  })

  it('dispatches a close event on swipe-right when the same block is active', () => {
    const surface = document.createElement('div')
    const closed = recordCloseEvents(surface, 'b4')
    const props = handlers(makeContext('b4'))
    props.onTouchStart?.(touchEvent('changedTouches', touch(50, 100), surface))
    const end = touchEvent('changedTouches', touch(140, 100), surface)
    props.onTouchEnd?.(end)
    expect(closed).toEqual(['b4'])
    expect(end.preventDefault).toHaveBeenCalled()
    expect(end.stopPropagation).toHaveBeenCalled()
  })

  it('does not consume swipe-right when no menu is open in this panel', () => {
    const surface = document.createElement('div')
    const props = handlers(makeContext('b5'))
    const end = touchEvent('changedTouches', touch(140, 100), surface)
    props.onTouchStart?.(touchEvent('changedTouches', touch(50, 100), surface))
    props.onTouchEnd?.(end)
    expect(end.preventDefault).not.toHaveBeenCalled()
  })

  it('does not dismiss when the active id in this panel belongs to a different block', () => {
    const surface = document.createElement('div')
    const closed = recordCloseEvents(surface, 'X')
    const props = handlers(makeContext('Y'))
    props.onTouchStart?.(touchEvent('changedTouches', touch(50, 100), surface))
    const end = touchEvent('changedTouches', touch(140, 100), surface)
    props.onTouchEnd?.(end)
    expect(closed).toEqual(['Y'])
    expect(end.preventDefault).not.toHaveBeenCalled()
  })

  it('ignores a second finger\'s coords during a single-finger swipe', () => {
    const surface = document.createElement('div')
    const opened = recordOpenEvents(surface)
    const props = handlers(makeContext('b-multi'))
    const tracked = (x: number) => touch(x, 100, 1)
    const distractor = touch(800, 100, 2)

    props.onTouchStart?.(touchEvent('changedTouches', tracked(200), surface))
    // touches list now contains both fingers — distractor at index 0.
    props.onTouchMove?.(touchEvent('touches', [distractor, tracked(150)], surface))
    // changedTouches on end has BOTH leaving; the tracked one is what
    // we want, regardless of order.
    props.onTouchEnd?.(touchEvent('changedTouches', [distractor, tracked(120)], surface))
    expect(opened).toEqual(['b-multi'])
  })

  it('does not flip on a second finger\'s end event', () => {
    const surface = document.createElement('div')
    const opened = recordOpenEvents(surface)
    const props = handlers(makeContext('b-multi-end'))
    const tracked = (x: number) => touch(x, 100, 1)
    const distractor = touch(800, 100, 2)

    props.onTouchStart?.(touchEvent('changedTouches', tracked(200), surface))
    // Distractor finger's end fires while tracked is still down. The
    // gesture must stay alive (no menu open yet, but state retained).
    props.onTouchEnd?.(touchEvent('changedTouches', distractor, surface))
    expect(opened).toEqual([])
    // Now the tracked finger lifts after a left swipe — should fire.
    props.onTouchEnd?.(touchEvent('changedTouches', tracked(120), surface))
    expect(opened).toEqual(['b-multi-end'])
  })

  it('locks the gesture to the first finger; later touchstarts are ignored', () => {
    const surface = document.createElement('div')
    const opened = recordOpenEvents(surface)
    const props = handlers(makeContext('b-lock'))
    const first = touch(200, 100, 1)
    const second = touch(800, 100, 2) // would be a swipe-right if tracked

    props.onTouchStart?.(touchEvent('changedTouches', first, surface))
    // Second finger lands; if we re-keyed the gesture to it, the
    // 800 -> 750 motion below would not look like a leftward swipe.
    props.onTouchStart?.(touchEvent('changedTouches', second, surface))
    props.onTouchEnd?.(touchEvent('changedTouches', touch(120, 100, 1), surface))
    expect(opened).toEqual(['b-lock'])
  })

  it('does not open the menu on non-mobile viewports', () => {
    setMobileViewport(false)
    const surface = document.createElement('div')
    const opened = recordOpenEvents(surface)
    const props = handlers(makeContext('b6'))
    const end = touchEvent('changedTouches', touch(120, 102), surface)
    props.onTouchStart?.(touchEvent('changedTouches', touch(200, 100), surface))
    props.onTouchMove?.(touchEvent('touches', touch(150, 102), surface))
    props.onTouchEnd?.(end)
    expect(opened).toEqual([])
    // Crucially, the gesture must not be consumed: no preventDefault /
    // stopPropagation, so native scroll / back-swipe stays intact.
    expect(end.preventDefault).not.toHaveBeenCalled()
    expect(end.stopPropagation).not.toHaveBeenCalled()
  })
})
