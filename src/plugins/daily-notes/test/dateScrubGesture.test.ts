import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TouchEvent } from 'react'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import type { PropertySchema } from '@/data/api'
import type { BlockResolveContext } from '@/extensions/blockInteraction.js'
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
import {
  blockGestureConflictsFacet,
  __resetBlockGestureClaimsForTest,
} from '@/extensions/blockGestureConflicts.js'
import {
  cancelSwipeCandidate,
  swipeQuickActionsContentSurface,
  SWIPE_QUICK_ACTIONS_GESTURE_ID,
} from '@/plugins/swipe-quick-actions/swipeGesture.js'
import {
  SWIPE_QUICK_ACTION_OPEN_EVENT,
  type SwipeQuickActionMenuEvent,
} from '@/plugins/swipe-quick-actions/events.js'
import {
  cancelDateScrubForBlock,
  dateScrubContentSurface,
  DATE_SCRUB_GESTURE_ID,
  endKeyboardScrub,
  installDateScrubAuxListeners,
  registerScrubHandler,
  startKeyboardScrubForTarget,
  type ScrubHandler,
} from '../dateScrubGesture.ts'

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

describe('date scrub aux listeners (wheel feeder + blur cancel)', () => {
  let unregisterHandler: (() => void) | null = null
  let unregisterAux: (() => void) | null = null
  let handler: ScrubHandler

  beforeEach(() => {
    setMobileViewport(false)
    handler = {
      start: vi.fn(() => true),
      update: vi.fn(),
      end: vi.fn(),
    }
    unregisterHandler = registerScrubHandler(handler)
    unregisterAux = installDateScrubAuxListeners()
  })

  afterEach(() => {
    unregisterAux?.()
    unregisterAux = null
    unregisterHandler?.()
    unregisterHandler = null
    // Module-level scrub state leaks across tests; clear it explicitly.
    endKeyboardScrub(false)
    document.body.innerHTML = ''
  })

  it('ignores wheel events when no scrub is armed', () => {
    window.dispatchEvent(new WheelEvent('wheel', {
      deltaMode: 0,
      deltaX: 0,
      deltaY: -14,
      cancelable: true,
    }))

    expect(handler.start).not.toHaveBeenCalled()
    expect(handler.update).not.toHaveBeenCalled()
  })

  it('feeds wheel deltas to an already-armed scrub', () => {
    startKeyboardScrubForTarget({block: {id: 'dated-block'} as Block})
    expect(handler.start).toHaveBeenCalledWith(expect.objectContaining({
      blockId: 'dated-block',
    }))

    const event = new WheelEvent('wheel', {
      deltaMode: 0,
      deltaX: 0,
      deltaY: -14,
      cancelable: true,
    })
    const preventDefault = vi.spyOn(event, 'preventDefault')
    window.dispatchEvent(event)

    expect(handler.update).toHaveBeenLastCalledWith(1, false)
    expect(preventDefault).toHaveBeenCalled()
  })

  it('uses horizontal wheel delta when shift remaps vertical wheel motion', () => {
    startKeyboardScrubForTarget({block: {id: 'dated-block'} as Block})

    const event = new WheelEvent('wheel', {
      deltaMode: 0,
      deltaX: -14,
      deltaY: 0,
      cancelable: true,
    })
    const preventDefault = vi.spyOn(event, 'preventDefault')
    window.dispatchEvent(event)

    expect(handler.update).toHaveBeenLastCalledWith(1, false)
    expect(preventDefault).toHaveBeenCalled()
  })

  it('cancels on window blur while armed', () => {
    startKeyboardScrubForTarget({block: {id: 'dated-block'} as Block})
    expect(handler.start).toHaveBeenCalled()

    window.dispatchEvent(new Event('blur'))
    expect(handler.end).toHaveBeenCalledWith(false)
  })
})

interface TestTouch {
  identifier: number
  clientX: number
  clientY: number
}

const touchPoint = (x: number, y: number, identifier: number): TestTouch => ({
  identifier,
  clientX: x,
  clientY: y,
})

const touchEvent = (
  list: 'touches' | 'changedTouches',
  points: readonly TestTouch[],
  target: EventTarget,
): TouchEvent<HTMLDivElement> => ({
  target,
  currentTarget: target,
  [list]: points,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
} as unknown as TouchEvent<HTMLDivElement>)

const makeFakeUiStateBlock = (): Block => {
  const props = new Map<string, unknown>()
  return {
    peek: vi.fn(() => ({properties: Object.fromEntries(props)})),
    peekProperty: vi.fn((schema: PropertySchema<unknown>) => props.get(schema.name)),
    set: vi.fn(async (schema: PropertySchema<unknown>, value: unknown) => {
      if (value === undefined) props.delete(schema.name)
      else props.set(schema.name, value)
    }),
  } as unknown as Block
}

describe('scrub <-> swipe block-gesture-conflicts coordination', () => {
  let unregisterHandler: (() => void) | null = null

  beforeEach(() => {
    // Both touch gestures gate on the mobile viewport.
    setMobileViewport(true)
    __resetBlockGestureClaimsForTest()
    unregisterHandler = registerScrubHandler({
      start: vi.fn(() => true),
      update: vi.fn(),
      end: vi.fn(),
    })
  })

  afterEach(() => {
    unregisterHandler?.()
    unregisterHandler = null
    __resetBlockGestureClaimsForTest()
    document.body.innerHTML = ''
  })

  it('clears the swipe candidate when scrub crosses its activation threshold', () => {
    // Runtime carries both gesture contributions so claimBlockGesture
    // can route eviction across plugins. Production wires it up via
    // staticAppExtensions; here we build the minimal version.
    const runtime = resolveFacetRuntimeSync([
      blockGestureConflictsFacet.of({
        id: SWIPE_QUICK_ACTIONS_GESTURE_ID,
        onCancel: cancelSwipeCandidate,
      }),
      blockGestureConflictsFacet.of({
        id: DATE_SCRUB_GESTURE_ID,
        onCancel: cancelDateScrubForBlock,
      }),
    ])

    const uiStateBlock = makeFakeUiStateBlock()
    const block = {
      id: 'b-coord',
      repo: {facetRuntime: runtime} as unknown as Repo,
    } as Block
    const context: BlockResolveContext = {
      block,
      repo: block.repo,
      uiStateBlock,
      types: [],
      topLevelBlockId: 'root',
      isTopLevel: false,
    }

    const swipeProps = swipeQuickActionsContentSurface(context)
    const scrubProps = dateScrubContentSurface(context)
    if (!swipeProps || !scrubProps) throw new Error('contributions returned no props')
    const surface = document.createElement('div')
    const opened: string[] = []
    surface.addEventListener(SWIPE_QUICK_ACTION_OPEN_EVENT, event => {
      opened.push((event as SwipeQuickActionMenuEvent).detail.blockId)
      event.preventDefault()
    })

    // Finger 1 lands — swipe records candidate; scrub records single.
    swipeProps.onTouchStart?.(touchEvent('changedTouches', [touchPoint(200, 100, 1)], surface))
    scrubProps.onTouchStart?.(touchEvent('changedTouches', [touchPoint(200, 100, 1)], surface))
    // Finger 2 lands — scrub promotes single → multi. Swipe ignores
    // (first-finger lock).
    swipeProps.onTouchStart?.(touchEvent('changedTouches', [touchPoint(220, 100, 2)], surface))
    scrubProps.onTouchStart?.(touchEvent('changedTouches', [touchPoint(220, 100, 2)], surface))
    // Cross horizontal threshold so scrub claims.
    scrubProps.onTouchMove?.(touchEvent(
      'touches',
      [touchPoint(180, 100, 1), touchPoint(200, 100, 2)],
      surface,
    ))

    // Now finger 1 lifts — without the facet routing the eviction,
    // swipe.onTouchEnd would see a leftward dx (-80) and open the menu.
    // With it, the candidate was cleared via cancelSwipeCandidate and
    // touchend is a no-op.
    swipeProps.onTouchEnd?.(touchEvent('changedTouches', [touchPoint(120, 100, 1)], surface))

    expect(opened).toEqual([])
  })
})
