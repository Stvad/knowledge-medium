// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dateScrubRecognizer } from '../dateScrubRecognizer.ts'
import type { DateScrubProgressDetail } from '../dateScrubGesture.ts'
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

// The recognizer pre-checks date-shiftability via `context.repo.facetRuntime`
// (pickBlockDateAdapter → runtime.read(blockDateAdapterFacet)); a fake runtime
// returns a matching adapter when `shiftable`, none otherwise.
const context = (shiftable = true): BlockResolveContext =>
  ({
    block: fakeBlock('b1'),
    uiStateBlock: {
      peek: vi.fn(() => ({properties: {}})),
      peekProperty: vi.fn(() => undefined),
    } as unknown as Block,
    repo: {
      facetRuntime: {read: () => (shiftable ? [{canHandle: () => true}] : [])},
    } as never,
    types: [],
    isTopLevel: false,
  } as unknown as BlockResolveContext)

const pointer = (pointerId: number, x: number, y: number): GesturePointer =>
  ({pointerId, x, y, pointerType: 'touch', target: null})

const session = (changed: GesturePointer, all: readonly GesturePointer[]): GestureSession =>
  ({pointers: all, changed})

const eventCtx = (pointerType = 'touch'): GestureEventContext =>
  ({element: document.createElement('div'), event: {pointerType, target: null} as unknown as PointerEvent})

const make = (shiftable = true): GestureRecognizer => {
  const r = dateScrubRecognizer(context(shiftable))
  if (!r) throw new Error('recognizer not contributed')
  return r
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

const progressDetail = (v: GesturePhaseResult): DateScrubProgressDetail => {
  if (v.status !== 'progress') throw new Error(`expected progress, got ${v.status}`)
  return (v.event as CustomEvent<DateScrubProgressDetail>).detail
}

beforeEach(() => {
  window.matchMedia = vi.fn().mockReturnValue({matches: true}) as unknown as typeof window.matchMedia
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('dateScrubRecognizer', () => {
  it('claims and streams a `date-scrub` progress tick on a two-finger horizontal drag', () => {
    const r = make()
    lock(r)
    const v = moveBy(r, 28, 0) // +28px ≈ 2 days, horizontal dominates
    expect(v.status).toBe('progress')
    if (v.status !== 'progress') return
    expect(v.gesture).toBe('date-scrub')
    const detail = progressDetail(v)
    expect(detail.deltaDays).toBe(2)
    expect(detail.cancelIntent).toBe(false)
    // The activation tick carries the lock midpoint so the action opens there.
    expect(detail.begin).toEqual({startX: 120, startY: 100})
  })

  it('drops `begin` after the activation tick (overlay opens once)', () => {
    const r = make()
    lock(r)
    moveBy(r, 28, 0)
    const detail = progressDetail(moveBy(r, 42, 0))
    expect(detail.begin).toBeUndefined()
    expect(detail.deltaDays).toBe(3)
  })

  it('yields (cancel) when the block is not date-shiftable — no phantom claim', () => {
    const r = make(false)
    lock(r)
    const v = moveBy(r, 28, 0)
    expect(v.status).toBe('cancel') // drop the claim so a rival can have it
  })

  it('does not activate on a two-finger vertical drag (scroll, not scrub)', () => {
    const r = make()
    lock(r)
    expect(moveBy(r, 0, 40).status).toBe('idle')
  })

  it('does not start when one anchor finger began on an interactive control', () => {
    const r = make()
    const button = document.createElement('button')
    const onButton = (x: number, y: number): GesturePointer =>
      ({pointerId: 1, x, y, pointerType: 'touch', target: button})
    // Finger 1 lands on a button; finger 2 on normal content (null target).
    r.onPointerDown?.(session(pointer(2, 140, 100), [onButton(100, 100), pointer(2, 140, 100)]), eventCtx())
    // Drag the midpoint horizontally past the lock — must NOT start: only one of
    // the two fingers is on an eligible surface, so there's no anchor pair.
    const verdict = r.onPointerMove?.(
      session(onButton(128, 100), [onButton(128, 100), pointer(2, 168, 100)]),
      eventCtx(),
    ) as GesturePhaseResult
    expect(verdict.status).toBe('idle')
  })

  it('stays idle for a single finger', () => {
    const r = make()
    const a = pointer(1, 100, 100)
    const verdict = r.onPointerMove?.(session(a, [a]), eventCtx()) as GesturePhaseResult
    expect(verdict.status).toBe('idle')
  })

  it('commits `date-scrub-commit` on release when the scrub ended on a horizontal note', () => {
    const r = make()
    lock(r)
    moveBy(r, 28, 0)
    const a = pointer(1, 128, 100)
    const v = r.onPointerUp?.(session(a, [a, pointer(2, 168, 100)]), eventCtx()) as GesturePhaseResult
    expect(v.status).toBe('commit')
    if (v.status !== 'commit') return
    expect(v.gesture).toBe('date-scrub-commit')
  })

  it('yields (cancel → the loop settles the preview) when the final vertical travel reads as cancel', () => {
    const r = make()
    lock(r)
    moveBy(r, 28, 0) // activate
    moveBy(r, 28, 80) // drag down past the cancel threshold
    const a = pointer(1, 128, 180)
    const v = r.onPointerUp?.(session(a, [a, pointer(2, 168, 180)]), eventCtx()) as GesturePhaseResult
    expect(v.status).toBe('cancel')
  })

  it('keeps the scrub alive when an untracked extra finger is cancelled', () => {
    const r = make()
    lock(r)
    expect(progressDetail(moveBy(r, 28, 0)).begin).toBeDefined() // activated
    // A third, untracked finger receives pointercancel while anchors 1, 2 stay
    // down — the scrub must survive (next tick streams, no re-activation).
    const extra = pointer(3, 200, 100)
    r.onPointerCancel?.(session(extra, [pointer(1, 128, 100), pointer(2, 168, 100), extra]), eventCtx())
    expect(progressDetail(moveBy(r, 42, 0)).begin).toBeUndefined()
    // A tracked finger's cancel resets: the next move re-locks (dx≈0 → idle)
    // rather than continuing the old scrub from the original anchor.
    r.onPointerCancel?.(session(pointer(1, 142, 100), [pointer(1, 142, 100), pointer(2, 182, 100)]), eventCtx())
    expect(moveBy(r, 56, 0).status).toBe('idle')
  })

  it('ignores non-touch pointers (mouse)', () => {
    const r = make()
    const verdict = r.onPointerDown?.(
      session(pointer(1, 100, 100), [pointer(1, 100, 100), pointer(2, 140, 100)]),
      eventCtx('mouse'),
    ) as GesturePhaseResult
    expect(verdict.status).toBe('idle')
  })

  it('isEnabled gates on the viewport (the mobile gate the loop reads, moved out of the handlers)', () => {
    expect(make().isEnabled?.()).toBe(true) // beforeEach reports a mobile viewport
    window.matchMedia = vi.fn().mockReturnValue({matches: false}) as unknown as typeof window.matchMedia
    expect(make().isEnabled?.()).toBe(false)
  })
})
