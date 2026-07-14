// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  swipeRecognizer,
  SWIPE_TRIGGER_PX,
} from '../swipeRecognizer.ts'
import type {
  GestureEventContext,
  GesturePhaseResult,
  GesturePointer,
  GestureRecognizer,
  GestureSession,
} from '@/extensions/continuousGestures.js'
import type { BlockResolveContext } from '@/extensions/blockInteraction.js'
import type { Block } from '@/data/block'
import { EMPTY_RENDER_VISIBILITY_POLICY } from '@/utils/renderVisibility.js'

const fakeBlock = (id: string): Block =>
  ({id, peekProperty: vi.fn(() => undefined)} as unknown as Block)

const context = (): BlockResolveContext =>
  ({
    block: fakeBlock('b1'),
    // `peek()` backs the focus/editing check; empty properties → not focused.
    uiStateBlock: {
      peek: vi.fn(() => ({properties: {}})),
      peekProperty: vi.fn(() => undefined),
    } as unknown as Block,
    repo: {} as never,
    types: [],
    isTopLevel: false,
    blockContext: {renderVisibilityPolicy: EMPTY_RENDER_VISIBILITY_POLICY},
  } as unknown as BlockResolveContext)

const pointer = (pointerId: number, x: number, y: number): GesturePointer =>
  ({pointerId, x, y, pointerType: 'touch', target: null})

const session = (changed: GesturePointer, all: readonly GesturePointer[] = [changed]): GestureSession =>
  ({pointers: all, changed})

const eventCtx = (pointerType = 'touch'): GestureEventContext =>
  ({element: document.createElement('div'), event: {pointerType, target: null} as unknown as PointerEvent})

const make = (): GestureRecognizer => {
  const r = swipeRecognizer(context())
  if (!r) throw new Error('recognizer not contributed')
  return r
}

// Drive a down at (sx,sy) then return the verdict of a move/up to (x,y).
const down = (r: GestureRecognizer, sx: number, sy: number): void => {
  r.onPointerDown?.(session(pointer(1, sx, sy)), eventCtx())
}

beforeEach(() => {
  // The recognizer is mobile-only; report a mobile viewport.
  window.matchMedia = vi.fn().mockReturnValue({matches: true}) as unknown as typeof window.matchMedia
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('swipeRecognizer', () => {
  it('streams a swipe-left progress tick on a leftward drag', () => {
    const r = make()
    down(r, 100, 100)
    const verdict = r.onPointerMove?.(session(pointer(1, 80, 100)), eventCtx()) as GesturePhaseResult
    expect(verdict.status).toBe('progress')
    if (verdict.status !== 'progress') throw new Error('expected progress')
    expect(verdict.gesture).toBe('swipe-left')
    expect((verdict.deps as unknown as {targetElement: HTMLElement}).targetElement).toBeInstanceOf(HTMLElement)
    expect((verdict.event as CustomEvent).detail).toEqual({dx: -20})
  })

  it('commits swipe-left when a leftward drag releases past the trigger', () => {
    const r = make()
    down(r, 100, 100)
    r.onPointerMove?.(session(pointer(1, 80, 100)), eventCtx())
    const verdict = r.onPointerUp?.(session(pointer(1, 100 - SWIPE_TRIGGER_PX - 10, 100)), eventCtx()) as GesturePhaseResult
    expect(verdict.status).toBe('commit')
    if (verdict.status !== 'commit') throw new Error('expected commit')
    expect(verdict.gesture).toBe('swipe-left')
  })

  it('commits swipe-right when a rightward drag releases past the trigger', () => {
    const r = make()
    down(r, 100, 100)
    r.onPointerMove?.(session(pointer(1, 120, 100)), eventCtx()) // lock horizontal (rightward)
    const verdict = r.onPointerUp?.(session(pointer(1, 100 + SWIPE_TRIGGER_PX + 10, 100)), eventCtx()) as GesturePhaseResult
    expect(verdict.status).toBe('commit')
    if (verdict.status !== 'commit') throw new Error('expected commit')
    expect(verdict.gesture).toBe('swipe-right')
  })

  it('cancels (no commit) when the drag is vertical', () => {
    const r = make()
    down(r, 100, 100)
    const verdict = r.onPointerMove?.(session(pointer(1, 100, 130)), eventCtx()) as GesturePhaseResult
    expect(verdict.status).toBe('cancel')
  })

  it('settles below the trigger: a short leftward drag releases without committing', () => {
    const r = make()
    down(r, 100, 100)
    r.onPointerMove?.(session(pointer(1, 90, 100)), eventCtx()) // -10, previewing
    const verdict = r.onPointerUp?.(session(pointer(1, 80, 100)), eventCtx()) as GesturePhaseResult // -20 < trigger
    expect(verdict.status).toBe('cancel')
  })

  it('yields (cancel) when a second pointer joins — not a one-finger swipe', () => {
    const r = make()
    down(r, 100, 100)
    const verdict = r.onPointerMove?.(
      session(pointer(1, 80, 100), [pointer(1, 80, 100), pointer(2, 120, 100)]),
      eventCtx(),
    ) as GesturePhaseResult
    expect(verdict.status).toBe('cancel')
  })

  it('ignores non-touch pointers (mouse)', () => {
    const r = make()
    const verdict = r.onPointerDown?.(session(pointer(1, 100, 100)), eventCtx('mouse')) as GesturePhaseResult
    expect(verdict.status).toBe('idle')
  })

  it('isEnabled gates on the viewport (the mobile gate the loop reads, moved out of the handlers)', () => {
    expect(make().isEnabled?.()).toBe(true) // beforeEach reports a mobile viewport
    window.matchMedia = vi.fn().mockReturnValue({matches: false}) as unknown as typeof window.matchMedia
    expect(make().isEnabled?.()).toBe(false)
  })
})
