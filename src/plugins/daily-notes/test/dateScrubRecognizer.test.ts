// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dateScrubRecognizer } from '../dateScrubRecognizer.ts'
import { registerScrubHandler, type ScrubHandler } from '../dateScrubGesture.ts'
import type {
  GestureEventContext,
  GesturePhaseResult,
  GesturePointer,
  GestureRecognizer,
  GestureSession,
} from '@/extensions/continuousGestures.js'
import type { BlockResolveContext } from '@/extensions/blockInteraction.js'
import type { Block } from '@/data/block'

const fakeBlock = (id: string): Block =>
  ({id, peekProperty: vi.fn(() => undefined)} as unknown as Block)

const context = (): BlockResolveContext =>
  ({
    block: fakeBlock('b1'),
    uiStateBlock: {
      peek: vi.fn(() => ({properties: {}})),
      peekProperty: vi.fn(() => undefined),
    } as unknown as Block,
    repo: {} as never,
    types: [],
    isTopLevel: false,
  } as unknown as BlockResolveContext)

const pointer = (pointerId: number, x: number, y: number): GesturePointer =>
  ({pointerId, x, y, pointerType: 'touch', target: null})

const session = (changed: GesturePointer, all: readonly GesturePointer[]): GestureSession =>
  ({pointers: all, changed})

const eventCtx = (pointerType = 'touch'): GestureEventContext =>
  ({element: document.createElement('div'), event: {pointerType, target: null} as unknown as PointerEvent})

const make = (): GestureRecognizer => {
  const r = dateScrubRecognizer(context())
  if (!r) throw new Error('recognizer not contributed')
  return r
}

let handler: ScrubHandler
let unregister: (() => void) | null = null

const installHandler = (accept = true): void => {
  handler = {start: vi.fn(() => accept), update: vi.fn(), end: vi.fn()}
  unregister = registerScrubHandler(handler)
}

// Lock the two-finger anchor at (120,100): fingers 1 and 2, midpoint there.
const lock = (r: GestureRecognizer): void => {
  const a = pointer(1, 100, 100)
  const b = pointer(2, 140, 100)
  r.onPointerDown?.(session(b, [a, b]), eventCtx())
}

// Move both fingers by (dx,dy) off the lock so the midpoint shifts the same.
const moveBy = (r: GestureRecognizer, dx: number, dy: number): GesturePhaseResult => {
  const a = pointer(1, 100 + dx, 100 + dy)
  const b = pointer(2, 140 + dx, 100 + dy)
  return r.onPointerMove?.(session(a, [a, b]), eventCtx()) as GesturePhaseResult
}

beforeEach(() => {
  window.matchMedia = vi.fn().mockReturnValue({matches: true}) as unknown as typeof window.matchMedia
})
afterEach(() => {
  unregister?.()
  unregister = null
  vi.restoreAllMocks()
})

describe('dateScrubRecognizer', () => {
  it('starts the scrub and streams day deltas on a two-finger horizontal drag', () => {
    installHandler(true)
    const r = make()
    lock(r)
    const verdict = moveBy(r, 28, 0) // +28px ≈ 2 days, horizontal dominates
    expect(verdict.status).toBe('active')
    expect(handler.start).toHaveBeenCalledWith(
      expect.objectContaining({blockId: 'b1', startX: 120, startY: 100}),
    )
    expect(handler.update).toHaveBeenCalledWith(2, false)
  })

  it('yields when the overlay rejects the block (not date-shiftable)', () => {
    installHandler(false)
    const r = make()
    lock(r)
    const verdict = moveBy(r, 28, 0)
    expect(handler.start).toHaveBeenCalledTimes(1)
    expect(handler.update).not.toHaveBeenCalled()
    expect(verdict.status).toBe('cancel') // drop the claim so a rival can have it
  })

  it('does not start on a two-finger vertical drag (scroll, not scrub)', () => {
    installHandler(true)
    const r = make()
    lock(r)
    const verdict = moveBy(r, 0, 40)
    expect(handler.start).not.toHaveBeenCalled()
    expect(verdict.status).toBe('idle')
  })

  it('stays idle for a single finger', () => {
    installHandler(true)
    const r = make()
    const a = pointer(1, 100, 100)
    const verdict = r.onPointerMove?.(session(a, [a]), eventCtx()) as GesturePhaseResult
    expect(verdict.status).toBe('idle')
    expect(handler.start).not.toHaveBeenCalled()
  })

  it('commits on release when the scrub ended on a horizontal note', () => {
    installHandler(true)
    const r = make()
    lock(r)
    moveBy(r, 28, 0)
    const a = pointer(1, 128, 100)
    const verdict = r.onPointerUp?.(session(a, [a, pointer(2, 168, 100)]), eventCtx()) as GesturePhaseResult
    expect(handler.end).toHaveBeenCalledWith(true)
    expect(verdict.status).toBe('active') // claims the up so the click is suppressed
  })

  it('reverts on release when the final vertical travel reads as cancel', () => {
    installHandler(true)
    const r = make()
    lock(r)
    moveBy(r, 28, 0) // activate
    moveBy(r, 28, 80) // drag down past the cancel threshold
    const a = pointer(1, 128, 180)
    r.onPointerUp?.(session(a, [a, pointer(2, 168, 180)]), eventCtx())
    expect(handler.end).toHaveBeenCalledWith(false)
  })

  it('ignores non-touch pointers (mouse)', () => {
    installHandler(true)
    const r = make()
    const verdict = r.onPointerDown?.(
      session(pointer(1, 100, 100), [pointer(1, 100, 100), pointer(2, 140, 100)]),
      eventCtx('mouse'),
    ) as GesturePhaseResult
    expect(verdict.status).toBe('idle')
  })
})
