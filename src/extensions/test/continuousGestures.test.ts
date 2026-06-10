import { describe, expect, it, vi } from 'vitest'
import {
  createBlockGestureController,
  unionTouchAction,
  GESTURE_ACTIVE,
  GESTURE_IDLE,
  type GestureRecognizer,
  type GestureSession,
  type PointerSample,
} from '@/extensions/continuousGestures.js'
import type { BaseShortcutDependencies } from '@/shortcuts/types.js'

const element = {} as unknown as HTMLElement
const deps = {marker: 'x'} as unknown as BaseShortcutDependencies

// Typed so `dispatch.mock.calls[i]` is indexable (a bare `vi.fn(() => true)`
// infers a zero-length args tuple).
const makeDispatch = () => vi.fn<(...args: unknown[]) => boolean>(() => true)

const sample = (pointerId: number, x: number, y: number): PointerSample => ({
  pointerId,
  clientX: x,
  clientY: y,
  pointerType: 'touch',
  target: null,
  event: {preventDefault: vi.fn()} as unknown as PointerEvent,
})

describe('createBlockGestureController', () => {
  it('dispatches a recognized gesture (name + deps) at commit, and asks to preventDefault', () => {
    const dispatch = makeDispatch()
    const recognizer: GestureRecognizer = {
      id: 'swipe',
      onPointerUp: () => ({status: 'commit', gesture: 'swipe-right', deps}),
    }
    const controller = createBlockGestureController({recognizers: [recognizer], element, dispatch})

    controller.handlePointerDown(sample(1, 0, 0))
    const up = sample(1, 60, 0)
    const prevented = controller.handlePointerUp(up)

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0]).toEqual(['swipe-right', deps, up.event, undefined])
    expect(prevented).toBe(true)
  })

  it('does not preventDefault a commit no action handled, but still stops later recognizers', () => {
    // dispatch returns false: no action bound to this gesture, or every
    // candidate declined. The commit must not eat the trailing click/default.
    const dispatch = vi.fn<(...args: unknown[]) => boolean>(() => false)
    const second = vi.fn(() => ({status: 'commit', gesture: 'b', deps}) as const)
    const recognizers: GestureRecognizer[] = [
      {id: 'first', onPointerUp: () => ({status: 'commit', gesture: 'a', deps})},
      {id: 'second', onPointerUp: second},
    ]
    const controller = createBlockGestureController({recognizers, element, dispatch})

    controller.handlePointerDown(sample(1, 0, 0))
    const prevented = controller.handlePointerUp(sample(1, 60, 0))

    expect(dispatch).toHaveBeenCalledTimes(1) // committed → attempted dispatch
    expect(prevented).toBe(false) // unhandled → leave the native default alone
    expect(second).not.toHaveBeenCalled() // committed → still wins the event
  })

  it("exposes the lifted pointer's final position in session.pointers on pointerup", () => {
    // The recognizer reads session.pointers (not just `changed`) on up; the map
    // entry must reflect the up event's coordinates, not the stale pointerdown
    // ones, or a commit-on-up gesture classifies with the wrong final position.
    const dispatch = makeDispatch()
    let finalX: number | undefined
    const recognizer: GestureRecognizer = {
      id: 'swipe',
      onPointerUp: (session: GestureSession) => {
        finalX = session.pointers.find(p => p.pointerId === 1)?.x
        return GESTURE_IDLE
      },
    }
    const controller = createBlockGestureController({recognizers: [recognizer], element, dispatch})

    controller.handlePointerDown(sample(1, 0, 0))
    controller.handlePointerUp(sample(1, 80, 0))

    expect(finalX).toBe(80)
  })

  it('evicts rivals when one recognizer goes active: their onPointerCancel fires and they stop receiving events', () => {
    const dispatch = makeDispatch()
    const winnerMove = vi.fn(() => GESTURE_ACTIVE)
    const loserMove = vi.fn(() => GESTURE_IDLE)
    const loserCancel = vi.fn()
    const winner: GestureRecognizer = {id: 'winner', onPointerMove: winnerMove}
    const loser: GestureRecognizer = {id: 'loser', onPointerMove: loserMove, onPointerCancel: loserCancel}
    const controller = createBlockGestureController({recognizers: [winner, loser], element, dispatch})

    controller.handlePointerDown(sample(1, 0, 0))
    const prevented = controller.handlePointerMove(sample(1, 20, 0))
    expect(prevented).toBe(true) // active → preventDefault the move
    expect(loserCancel).toHaveBeenCalledTimes(1) // evicted on the spot

    // The loser is out for the rest of the session — a later move skips it.
    controller.handlePointerMove(sample(1, 40, 0))
    expect(loserMove).not.toHaveBeenCalled()
    expect(loserCancel).toHaveBeenCalledTimes(1)
  })

  it('resets arbitration state once all pointers lift, so the next gesture starts fresh', () => {
    const dispatch = makeDispatch()
    const move = vi.fn(() => GESTURE_ACTIVE)
    const recognizer: GestureRecognizer = {id: 'swipe', onPointerMove: move}
    const controller = createBlockGestureController({recognizers: [recognizer], element, dispatch})

    controller.handlePointerDown(sample(1, 0, 0))
    controller.handlePointerMove(sample(1, 20, 0)) // goes active
    controller.handlePointerUp(sample(1, 20, 0)) // last pointer up → reset

    // Second gesture: the recognizer is eligible again (not stuck cancelled).
    controller.handlePointerDown(sample(2, 0, 0))
    expect(controller.handlePointerMove(sample(2, 20, 0))).toBe(true)
    expect(move).toHaveBeenCalledTimes(2)
  })

  it('exposes all currently-down pointers in the session (two-finger gesture)', () => {
    const dispatch = makeDispatch()
    let seen = 0
    const recognizer: GestureRecognizer = {
      id: 'scrub',
      onPointerMove: (session: GestureSession) => {
        seen = session.pointers.length
        return GESTURE_IDLE
      },
    }
    const controller = createBlockGestureController({recognizers: [recognizer], element, dispatch})

    controller.handlePointerDown(sample(1, 0, 0))
    controller.handlePointerDown(sample(2, 10, 0))
    controller.handlePointerMove(sample(2, 30, 0))

    expect(seen).toBe(2)
  })

  it('lets the first recognizer to commit win the event; later recognizers do not run', () => {
    const dispatch = makeDispatch()
    const firstUp = vi.fn(() => ({status: 'commit', gesture: 'a', deps}) as const)
    const secondUp = vi.fn(() => ({status: 'commit', gesture: 'b', deps}) as const)
    const first: GestureRecognizer = {id: 'first', onPointerUp: firstUp}
    const second: GestureRecognizer = {id: 'second', onPointerUp: secondUp}
    const controller = createBlockGestureController({recognizers: [first, second], element, dispatch})

    controller.handlePointerDown(sample(1, 0, 0))
    controller.handlePointerUp(sample(1, 0, 0))

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0]?.[0]).toBe('a')
    expect(secondUp).not.toHaveBeenCalled()
  })

  it('fires onPointerCancel for in-flight recognizers on a browser cancel', () => {
    const dispatch = makeDispatch()
    const cancel = vi.fn()
    const recognizer: GestureRecognizer = {id: 'swipe', onPointerCancel: cancel}
    const controller = createBlockGestureController({recognizers: [recognizer], element, dispatch})

    controller.handlePointerDown(sample(1, 0, 0))
    controller.handlePointerCancel(sample(1, 5, 0))

    expect(cancel).toHaveBeenCalledTimes(1)
  })
})

describe('unionTouchAction', () => {
  it('collapses identical requirements and lets none dominate; differing requirements fall back to none', () => {
    expect(unionTouchAction(['pan-y', 'pan-y'])).toBe('pan-y')
    expect(unionTouchAction(['none', 'pan-y'])).toBe('none')
    expect(unionTouchAction(['pan-y', 'pan-x'])).toBe('none')
    expect(unionTouchAction([])).toBeUndefined()
    expect(unionTouchAction(['', ''])).toBeUndefined()
  })
})
