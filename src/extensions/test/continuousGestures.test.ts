import { describe, expect, it, vi } from 'vitest'
import {
  createBlockGestureController,
  unionTouchAction,
  enabledTouchAction,
  GESTURE_ACTIVE,
  GESTURE_CANCEL,
  GESTURE_IDLE,
  type GestureRecognizer,
  type GestureSession,
  type PointerSample,
  type ActionTrigger,
} from '@/extensions/continuousGestures.js'
import type { BaseShortcutDependencies } from '@/shortcuts/types.js'

const element = {} as unknown as HTMLElement
const deps = {marker: 'x'} as unknown as BaseShortcutDependencies

// A dispatch that HANDLES the gesture and (like the real dispatcher's
// applyGestureEventOptions, which defaults to preventDefault: true) cancels the
// event's default. The controller reads `event.defaultPrevented` to decide
// whether to suppress, so a faithful mock must mutate it. Typed so
// `dispatch.mock.calls[i]` is indexable.
const makeDispatch = () => vi.fn<(...args: unknown[]) => boolean>((...args) => {
  ;(args[2] as Event | undefined)?.preventDefault()
  return true
})

const sample = (pointerId: number, x: number, y: number): PointerSample => {
  // A minimal cancelable-event stub whose `defaultPrevented` flips on
  // preventDefault, so tests can model both the default (suppressing) dispatcher
  // and an opt-out context that leaves the native default intact.
  let defaultPrevented = false
  const event = {
    preventDefault: () => { defaultPrevented = true },
    stopPropagation: () => {},
    get defaultPrevented() { return defaultPrevented },
  } as unknown as PointerEvent
  return {pointerId, clientX: x, clientY: y, pointerType: 'touch', target: null, event}
}

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
    expect(dispatch.mock.calls[0]).toEqual(['swipe-right', deps, up.event])
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

  it('leaves the native default alone when a handled commit opted out of preventDefault', () => {
    // dispatch HANDLES the gesture but does not cancel the event — mirrors
    // applyGestureEventOptions for a context with defaultEventOptions:
    // {preventDefault: false}. The controller must not force preventDefault /
    // click-suppression on `handled` alone.
    const dispatch = vi.fn<(...args: unknown[]) => boolean>(() => true)
    const recognizer: GestureRecognizer = {
      id: 'swipe',
      onPointerUp: () => ({status: 'commit', gesture: 'swipe-right', deps}),
    }
    const controller = createBlockGestureController({recognizers: [recognizer], element, dispatch})

    controller.handlePointerDown(sample(1, 0, 0))
    const prevented = controller.handlePointerUp(sample(1, 60, 0))

    expect(dispatch).toHaveBeenCalledTimes(1) // handled
    expect(prevented).toBe(false) // opted out → native click/focus preserved
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

  describe('progress preview streaming', () => {
    const trigger = (n: number): ActionTrigger => ({type: 'progress', detail: {n}}) as unknown as ActionTrigger

    const previewRecognizer = (
      overrides: Partial<GestureRecognizer> = {},
    ): GestureRecognizer => {
      let n = 0
      return {
        id: 'swipe',
        onPointerMove: () => ({status: 'progress', gesture: 'swipe-left', deps, event: trigger(n++)}),
        ...overrides,
      }
    }

    it('resolves the progress winner once, then streams every tick to that one handle', () => {
      const update = vi.fn()
      const beginProgress = vi.fn(() => ({update, settle: vi.fn()}))
      const controller = createBlockGestureController({
        recognizers: [previewRecognizer()], element, dispatch: makeDispatch(), beginProgress,
      })

      controller.handlePointerDown(sample(1, 0, 0))
      expect(controller.handlePointerMove(sample(1, -10, 0))).toBe(true) // claims block → preventDefault
      controller.handlePointerMove(sample(1, -20, 0))

      expect(beginProgress).toHaveBeenCalledTimes(1) // resolved ONCE, not per tick
      expect(beginProgress.mock.calls[0]).toEqual(['swipe-left', deps])
      expect(update).toHaveBeenCalledTimes(2)
    })

    it('claims the block and evicts a rival recognizer when it starts previewing', () => {
      const loserCancel = vi.fn()
      const beginProgress = vi.fn(() => ({update: vi.fn(), settle: vi.fn()}))
      const previewer = previewRecognizer()
      const loser: GestureRecognizer = {id: 'loser', onPointerMove: () => GESTURE_IDLE, onPointerCancel: loserCancel}
      // loser is contributed first so it runs first; the previewer's progress
      // verdict must still claim the block and evict it.
      const controller = createBlockGestureController({
        recognizers: [loser, previewer], element, dispatch: makeDispatch(), beginProgress,
      })

      controller.handlePointerDown(sample(1, 0, 0))
      controller.handlePointerMove(sample(1, -20, 0))

      expect(loserCancel).toHaveBeenCalledTimes(1) // evicted by the progress claim
      controller.handlePointerMove(sample(1, -30, 0))
      expect(beginProgress).toHaveBeenCalledTimes(1) // still one preview owner
    })

    it('settles the preview when the gesture ends without committing', () => {
      const settle = vi.fn()
      const beginProgress = vi.fn(() => ({update: vi.fn(), settle}))
      const controller = createBlockGestureController({
        recognizers: [previewRecognizer({onPointerUp: () => GESTURE_IDLE})],
        element, dispatch: makeDispatch(), beginProgress,
      })

      controller.handlePointerDown(sample(1, 0, 0))
      controller.handlePointerMove(sample(1, -20, 0))
      controller.handlePointerUp(sample(1, -20, 0)) // released before threshold

      expect(settle).toHaveBeenCalledTimes(1)
    })

    it('does NOT settle the preview when the gesture commits — the commit action takes over the visual', () => {
      const settle = vi.fn()
      const beginProgress = vi.fn(() => ({update: vi.fn(), settle}))
      const dispatch = makeDispatch()
      const controller = createBlockGestureController({
        recognizers: [previewRecognizer({
          onPointerUp: () => ({status: 'commit', gesture: 'swipe-left', deps}),
        })],
        element, dispatch, beginProgress,
      })

      controller.handlePointerDown(sample(1, 0, 0))
      controller.handlePointerMove(sample(1, -60, 0))
      controller.handlePointerUp(sample(1, -60, 0))

      expect(dispatch).toHaveBeenCalledTimes(1)
      expect(settle).not.toHaveBeenCalled()
    })

    it('settles the preview when the commit goes unhandled (nothing took over the visual)', () => {
      const settle = vi.fn()
      const beginProgress = vi.fn(() => ({update: vi.fn(), settle}))
      // dispatch returns false: no action bound the gesture, every candidate's
      // canDispatch declined, or every handler returned false.
      const dispatch = vi.fn<(...args: unknown[]) => boolean>(() => false)
      const controller = createBlockGestureController({
        recognizers: [previewRecognizer({
          onPointerUp: () => ({status: 'commit', gesture: 'swipe-left', deps}),
        })],
        element, dispatch, beginProgress,
      })

      controller.handlePointerDown(sample(1, 0, 0))
      controller.handlePointerMove(sample(1, -60, 0))
      controller.handlePointerUp(sample(1, -60, 0))

      expect(dispatch).toHaveBeenCalledTimes(1)
      // Unhandled commit → the preview must settle back, not freeze mid-reveal.
      expect(settle).toHaveBeenCalledTimes(1)
    })

    it('settles the preview on a browser pointercancel', () => {
      const settle = vi.fn()
      const beginProgress = vi.fn(() => ({update: vi.fn(), settle}))
      const controller = createBlockGestureController({
        recognizers: [previewRecognizer()], element, dispatch: makeDispatch(), beginProgress,
      })

      controller.handlePointerDown(sample(1, 0, 0))
      controller.handlePointerMove(sample(1, -20, 0))
      controller.handlePointerCancel(sample(1, -20, 0))

      expect(settle).toHaveBeenCalledTimes(1)
    })

    it('does not resurrect the preview after it settles (settled, then a fresh gesture re-resolves)', () => {
      const update = vi.fn()
      const settle = vi.fn()
      const beginProgress = vi.fn(() => ({update, settle}))
      const controller = createBlockGestureController({
        recognizers: [previewRecognizer()], element, dispatch: makeDispatch(), beginProgress,
      })

      controller.handlePointerDown(sample(1, 0, 0))
      controller.handlePointerMove(sample(1, -20, 0)) // previews
      controller.handlePointerCancel(sample(1, -20, 0)) // settles + forgets
      expect(settle).toHaveBeenCalledTimes(1)

      const updatesAfterSettle = update.mock.calls.length
      // A brand-new gesture re-resolves a fresh preview (does not reuse the old).
      controller.handlePointerDown(sample(2, 0, 0))
      controller.handlePointerMove(sample(2, -20, 0))
      expect(beginProgress).toHaveBeenCalledTimes(2) // re-resolved for the new gesture
      expect(update.mock.calls.length).toBeGreaterThan(updatesAfterSettle)
    })

    it('previews nothing (no crash) when the gesture binds no dispatchable progress action', () => {
      const beginProgress = vi.fn(() => null)
      const controller = createBlockGestureController({
        recognizers: [previewRecognizer({onPointerUp: () => GESTURE_IDLE})],
        element, dispatch: makeDispatch(), beginProgress,
      })

      controller.handlePointerDown(sample(1, 0, 0))
      controller.handlePointerMove(sample(1, -20, 0))
      // The recognizer still claimed the block even though nothing previewed.
      expect(controller.handlePointerMove(sample(1, -30, 0))).toBe(true)
      controller.handlePointerUp(sample(1, -30, 0))
      // Resolution is attempted ONCE and the null result is remembered, so an
      // unpreviewed gesture doesn't re-resolve on every move tick.
      expect(beginProgress).toHaveBeenCalledTimes(1)
    })
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

    // While the winner stays active it owns the block, so the loser doesn't run
    // (the `activeId` gate, not a permanent bar — see the takeover test below).
    controller.handlePointerMove(sample(1, 40, 0))
    expect(loserMove).not.toHaveBeenCalled()
    expect(loserCancel).toHaveBeenCalledTimes(1)
  })

  it('lets an evicted rival take the block over once the active recognizer releases (last-active-wins)', () => {
    // The swipe↔scrub handoff: a recognizer evicted when another went active is
    // NOT barred for the session — once the owner yields (a `cancel` verdict),
    // the evicted rival is eligible again and can claim. (The old loop barred it,
    // which left a 2-finger scrub dead after the 1-finger swipe had previewed.)
    const dispatch = makeDispatch()
    let swipeYields = false
    const swipeMove = vi.fn(() => (swipeYields ? GESTURE_CANCEL : GESTURE_ACTIVE))
    const scrubMove = vi.fn(() => GESTURE_ACTIVE)
    const scrubCancel = vi.fn()
    const swipe: GestureRecognizer = {id: 'swipe', onPointerMove: swipeMove}
    const scrub: GestureRecognizer = {id: 'scrub', onPointerMove: scrubMove, onPointerCancel: scrubCancel}
    const controller = createBlockGestureController({recognizers: [swipe, scrub], element, dispatch})

    controller.handlePointerDown(sample(1, 0, 0))
    controller.handlePointerMove(sample(1, 20, 0)) // swipe goes active, evicts scrub
    expect(scrubCancel).toHaveBeenCalledTimes(1)

    swipeYields = true
    controller.handlePointerMove(sample(1, 30, 0)) // swipe yields → activeId frees
    // Same event: scrub is eligible again (activeId null) and claims.
    expect(scrubMove).toHaveBeenCalledTimes(1)
    // A further move stays with scrub; the yielded swipe is out for the session.
    expect(controller.handlePointerMove(sample(1, 40, 0))).toBe(true)
    expect(scrubMove).toHaveBeenCalledTimes(2)
    expect(swipeMove).toHaveBeenCalledTimes(2)
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

describe('enablement (isEnabled)', () => {
  it('skips a disabled recognizer: its handlers never run and it is dropped from the touch-action union', () => {
    const onPointerDown = vi.fn(() => GESTURE_ACTIVE)
    const recognizer: GestureRecognizer = {
      id: 'swipe',
      isEnabled: () => false,
      touchAction: 'pan-y',
      onPointerDown,
    }
    const controller = createBlockGestureController({recognizers: [recognizer], element})

    expect(controller.handlePointerDown(sample(1, 0, 0))).toBe(false)
    expect(onPointerDown).not.toHaveBeenCalled()
    expect(controller.touchAction).toBeUndefined()
  })

  it('releases an owner whose gate flips off mid-gesture: fires its cancel and stops routing to it', () => {
    let enabled = true
    const onPointerCancel = vi.fn()
    const onPointerMove = vi.fn(() => GESTURE_ACTIVE)
    const recognizer: GestureRecognizer = {
      id: 'scrub',
      isEnabled: () => enabled,
      onPointerMove,
      onPointerCancel,
    }
    const controller = createBlockGestureController({recognizers: [recognizer], element})

    controller.handlePointerDown(sample(1, 0, 0))
    expect(controller.handlePointerMove(sample(1, 10, 0))).toBe(true) // claims the block
    expect(onPointerMove).toHaveBeenCalledTimes(1)

    // The gate flips off (e.g. the block entered edit mode) while it owns the block.
    enabled = false
    expect(controller.handlePointerMove(sample(1, 20, 0))).toBe(false)
    expect(onPointerCancel).toHaveBeenCalledTimes(1) // released cleanly, drops in-flight state
    expect(onPointerMove).toHaveBeenCalledTimes(1)   // no further routing while disabled
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

  it('enabledTouchAction unions only the enabled recognizers', () => {
    const on: GestureRecognizer = {id: 'on', isEnabled: () => true, touchAction: 'pan-y'}
    const off: GestureRecognizer = {id: 'off', isEnabled: () => false, touchAction: 'none'}
    const always: GestureRecognizer = {id: 'always', touchAction: 'pan-y'} // no gate ⇒ enabled
    expect(enabledTouchAction([on, off])).toBe('pan-y') // the disabling 'none' is excluded
    expect(enabledTouchAction([on, always])).toBe('pan-y')
    expect(enabledTouchAction([off])).toBeUndefined()
  })
})
