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
import {
  clearActiveSwipeTarget,
  getActiveSwipeTarget,
  setActiveSwipeTarget,
} from '../store.ts'

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

/** Build a synthetic React TouchEvent. The default `target` is a fresh
 *  block-shell element (carries `data-block-id`) attached to the document
 *  so the gesture handler's `closest([data-block-id])` lookup at
 *  touchstart finds it. Tests that need a specific block id pass one in;
 *  tests that need a non-block target (e.g. interactive descendant) pass
 *  one explicitly. */
const makeShellElement = (blockId: string): HTMLElement => {
  const shell = document.createElement('div')
  shell.setAttribute('data-block-id', blockId)
  document.body.appendChild(shell)
  // Give the shell a child the touch can land on, mimicking the real DOM.
  const child = document.createElement('span')
  shell.appendChild(child)
  return child
}

const touchEvent = (
  list: 'touches' | 'changedTouches',
  point: { clientX: number; clientY: number },
  target: EventTarget,
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
    clearActiveSwipeTarget()
    setMobileViewport(true)
    document.body.innerHTML = ''
  })
  afterEach(() => {
    clearActiveSwipeTarget()
    document.body.innerHTML = ''
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
    const target = makeShellElement('b1')
    props.onTouchStart?.(touchEvent('touches', touch(200, 100), target))
    props.onTouchMove?.(touchEvent('touches', touch(150, 102), target))
    props.onTouchEnd?.(touchEvent('changedTouches', touch(120, 102), target))
    const active = getActiveSwipeTarget()
    expect(active?.blockId).toBe('b1')
    // The captured element must be the swiped row, not just any matching
    // block id — the whole point of this regression guard.
    expect(active?.element.getAttribute('data-block-id')).toBe('b1')
  })

  it('captures the swiped instance even when another panel renders the same block id', () => {
    const props = handlers(makeContext('b-shared'))
    // Simulate two panels rendering the same block id; the user swipes
    // the second instance.
    makeShellElement('b-shared')   // panel A's instance
    const target = makeShellElement('b-shared') // panel B's instance, the one we touch
    const swipedShell = target.parentElement!
    props.onTouchStart?.(touchEvent('touches', touch(200, 100), target))
    props.onTouchEnd?.(touchEvent('changedTouches', touch(120, 100), target))
    const active = getActiveSwipeTarget()
    expect(active?.element).toBe(swipedShell)
  })

  it('ignores small horizontal movement (taps)', () => {
    const props = handlers(makeContext('b2'))
    const target = makeShellElement('b2')
    props.onTouchStart?.(touchEvent('touches', touch(200, 100), target))
    props.onTouchEnd?.(touchEvent('changedTouches', touch(195, 101), target))
    expect(getActiveSwipeTarget()).toBeNull()
  })

  it('ignores predominantly vertical drags (scrolls)', () => {
    const props = handlers(makeContext('b3'))
    const target = makeShellElement('b3')
    props.onTouchStart?.(touchEvent('touches', touch(200, 100), target))
    props.onTouchEnd?.(touchEvent('changedTouches', touch(180, 220), target))
    expect(getActiveSwipeTarget()).toBeNull()
  })

  it('dismisses the active menu on swipe-right of the same block instance', () => {
    const target = makeShellElement('b4')
    const shell = target.parentElement! as HTMLElement
    setActiveSwipeTarget({blockId: 'b4', element: shell})
    const props = handlers(makeContext('b4'))
    props.onTouchStart?.(touchEvent('touches', touch(50, 100), target))
    props.onTouchEnd?.(touchEvent('changedTouches', touch(140, 100), target))
    expect(getActiveSwipeTarget()).toBeNull()
  })

  it('does not consume swipe-right when no menu is open', () => {
    const props = handlers(makeContext('b5'))
    const target = makeShellElement('b5')
    const end = touchEvent('changedTouches', touch(140, 100), target)
    props.onTouchStart?.(touchEvent('touches', touch(50, 100), target))
    props.onTouchEnd?.(end)
    expect(end.preventDefault).not.toHaveBeenCalled()
    expect(getActiveSwipeTarget()).toBeNull()
  })

  it('does not dismiss when swipe-right hits a different instance of the active block', () => {
    // The user opened the menu against panel A, then swipes right on
    // panel B's instance of the same block. The menu should stay where
    // it is — dismissal must be element-scoped, not id-scoped.
    const panelAShell = makeShellElement('b-shared').parentElement! as HTMLElement
    setActiveSwipeTarget({blockId: 'b-shared', element: panelAShell})
    const panelBTarget = makeShellElement('b-shared')
    const props = handlers(makeContext('b-shared'))
    props.onTouchStart?.(touchEvent('touches', touch(50, 100), panelBTarget))
    props.onTouchEnd?.(touchEvent('changedTouches', touch(140, 100), panelBTarget))
    expect(getActiveSwipeTarget()?.element).toBe(panelAShell)
  })

  it('does not open the menu on non-mobile viewports', () => {
    setMobileViewport(false)
    const props = handlers(makeContext('b6'))
    const target = makeShellElement('b6')
    const end = touchEvent('changedTouches', touch(120, 102), target)
    props.onTouchStart?.(touchEvent('touches', touch(200, 100), target))
    props.onTouchMove?.(touchEvent('touches', touch(150, 102), target))
    props.onTouchEnd?.(end)
    expect(getActiveSwipeTarget()).toBeNull()
    // Crucially, the gesture must not be consumed: no preventDefault /
    // stopPropagation, so native scroll / back-swipe stays intact.
    expect(end.preventDefault).not.toHaveBeenCalled()
    expect(end.stopPropagation).not.toHaveBeenCalled()
  })
})
