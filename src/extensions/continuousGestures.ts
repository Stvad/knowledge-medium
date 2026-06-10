/**
 * Continuous-gesture recognizer facet + per-block recognition loop.
 *
 * The core infrastructure that turns a stream of Pointer Events on a block's
 * content surface into named gestures dispatched through the action system. A
 * recognizer (contributed by core for swipe, by a plugin for date-scrub, …) is
 * a state machine that classifies the motion and, at commit, emits a gesture
 * NAME + the block's deps; the loop dispatches it via `dispatchGesture`, so the
 * recognizer never names the action. See `docs/continuous-gesture-triggers.md`.
 *
 * This module owns three cross-cutting concerns so recognizers don't each
 * re-implement them (the bespoke `swipeGesture.ts` / `dateScrubGesture.ts`
 * machinery this replaces did):
 *  - the per-block pointer SESSION (which pointers are down, where), built from
 *    Pointer Events (mouse/touch/pen unified; `pointerId` pairs an event to its
 *    pointer the way the old code tracked `Touch.identifier` by hand);
 *  - ARBITRATION — one recognizer at a time owns a block; when one goes
 *    `active` the others are cancelled (this absorbs `blockGestureConflicts`);
 *  - the non-passive listener + `touch-action` SEAM for scroll suppression.
 *
 * Recognition that the model can't express stays possible: a plugin can ignore
 * this facet, contribute raw `blockContentSurfacePropsFacet` handlers, and reach
 * the same trigger via `dispatchGesture` directly (the escape hatch).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefCallback, RefObject } from 'react'
import { defineFacet, isFunction } from '@/extensions/facet.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import type { BlockResolveContext } from '@/extensions/blockInteraction.js'
import type { ActionTrigger, BaseShortcutDependencies } from '@/shortcuts/types.js'
import type { GesturePhase } from '@/shortcuts/gestureBinding.js'
import { dispatchGesture as defaultDispatchGesture } from '@/shortcuts/gestureAction.js'

/** A pointer currently in contact with the gesture surface. */
export interface GesturePointer {
  readonly pointerId: number
  readonly x: number
  readonly y: number
  readonly pointerType: string
  readonly target: EventTarget | null
}

/** The snapshot a recognizer sees for one lifecycle event. */
export interface GestureSession {
  /** Pointers currently down on this block, in contact order. On an up/cancel
   *  event the ending pointer is STILL present (it's removed after the handler
   *  returns) so a recognizer can read its final position — mirrors how the old
   *  touchend handlers read state before deleting it. */
  readonly pointers: readonly GesturePointer[]
  /** The pointer this event concerns (the one that went down / moved / lifted). */
  readonly changed: GesturePointer
}

/** Side context for a lifecycle handler: the surface element (for live-preview
 *  DOM events a recognizer dispatches) and the raw event (target checks, etc.). */
export interface GestureEventContext {
  readonly element: HTMLElement
  readonly event: PointerEvent
}

/**
 * A recognizer's verdict for one lifecycle event:
 *  - `idle` — not mine, or not yet.
 *  - `active` — I've claimed this block; the loop cancels other recognizers and
 *    preventDefaults subsequent moves (the documented `touch-action` fallback).
 *  - `commit` — dispatch this named gesture with these deps through `resolve`.
 *  - `cancel` — drop my claim; I'm out for the rest of this session.
 */
export type GesturePhaseResult =
  | { readonly status: 'idle' }
  | { readonly status: 'active' }
  | {
      readonly status: 'commit'
      readonly gesture: string
      readonly deps: BaseShortcutDependencies
      readonly phase?: GesturePhase
    }
  | { readonly status: 'cancel' }

/** Allocation-free singletons for the common no-op verdicts. */
export const GESTURE_IDLE: GesturePhaseResult = {status: 'idle'}
export const GESTURE_ACTIVE: GesturePhaseResult = {status: 'active'}
export const GESTURE_CANCEL: GesturePhaseResult = {status: 'cancel'}

/**
 * A continuous-gesture recognizer. `onPointerCancel` is effectively required:
 * the browser can cancel a gesture mid-stream (a `touch-action: pan-y` surface
 * scrolled past the lock, an OS interrupt), and the recognizer must drop
 * in-flight state when it does.
 */
export interface GestureRecognizer {
  /** Arbitration key — the loop cancels every OTHER recognizer when this one
   *  goes active. (Absorbs the old `blockGestureConflicts` gesture ids.) */
  readonly id: string
  /** CSS `touch-action` this gesture needs (e.g. `'pan-y'`). The loop applies
   *  the union of its recognizers' values to the surface, statically, so the
   *  browser yields the right axis BEFORE the gesture starts — a non-passive
   *  move listener alone can't suppress native scroll under Pointer Events. */
  readonly touchAction?: string
  onPointerDown?(session: GestureSession, ctx: GestureEventContext): GesturePhaseResult
  onPointerMove?(session: GestureSession, ctx: GestureEventContext): GesturePhaseResult
  onPointerUp?(session: GestureSession, ctx: GestureEventContext): GesturePhaseResult
  onPointerCancel?(session: GestureSession, ctx: GestureEventContext): void
}

export type BlockGestureRecognizerContribution =
  (context: BlockResolveContext) => GestureRecognizer | null | undefined | false

export type BlockGestureRecognizerResolver =
  (context: BlockResolveContext) => readonly GestureRecognizer[]

export const continuousGestureRecognizersFacet = defineFacet<
  BlockGestureRecognizerContribution,
  BlockGestureRecognizerResolver
>({
  id: 'core.continuous-gesture-recognizers',
  combine: contributions => context => {
    const result: GestureRecognizer[] = []
    for (const contribution of contributions) {
      const recognizer = contribution(context)
      if (recognizer) result.push(recognizer)
    }
    return result
  },
  empty: () => () => [],
  validate: isFunction<BlockGestureRecognizerContribution>,
})

/** A pointer event reduced to what the controller needs — structural so the
 *  controller stays unit-testable without synthesising real `PointerEvent`s. */
export interface PointerSample {
  readonly pointerId: number
  readonly clientX: number
  readonly clientY: number
  readonly pointerType: string
  readonly target: EventTarget | null
  /** Forwarded to `dispatchGesture` (for `preventDefault` of the trailing
   *  synthesized click) and used by the React layer to preventDefault moves. */
  readonly event: PointerEvent
}

/**
 * Combine the `touch-action` values several recognizers require into one the
 * surface can carry. `'none'` (gesture owns both axes) is most restrictive and
 * dominates; identical values collapse to that value; genuinely DIFFERENT
 * requirements can't both be satisfied by a single static property, so we fall
 * back to `'none'` (hand everything to JS) — the conservative, correct choice.
 * In practice every block gesture today is horizontal and asks for `'pan-y'`.
 */
export const unionTouchAction = (values: readonly string[]): string | undefined => {
  const present = values.filter(Boolean)
  if (present.length === 0) return undefined
  if (present.includes('none')) return 'none'
  const unique = [...new Set(present)]
  return unique.length === 1 ? unique[0] : 'none'
}

interface ControllerArgs {
  readonly recognizers: readonly GestureRecognizer[]
  readonly element: HTMLElement
  readonly dispatch?: typeof defaultDispatchGesture
}

export interface BlockGestureController {
  /** Each returns whether the originating event should be `preventDefault`ed. */
  handlePointerDown(sample: PointerSample): boolean
  handlePointerMove(sample: PointerSample): boolean
  handlePointerUp(sample: PointerSample): boolean
  handlePointerCancel(sample: PointerSample): void
  /** Union `touch-action` the React layer applies to the surface. */
  readonly touchAction: string | undefined
}

/**
 * The per-block recognition loop, framework-agnostic so it can be driven by
 * synthetic samples in tests. Holds the session (active pointers) + arbitration
 * state (which recognizer owns the block, which are out) for ONE block — there
 * is no cross-block coordination because gestures on different blocks are
 * independent, which is exactly why each block mounts its own controller.
 */
export const createBlockGestureController = ({
  recognizers,
  element,
  dispatch = defaultDispatchGesture,
}: ControllerArgs): BlockGestureController => {
  const pointers = new Map<number, GesturePointer>()
  // The recognizer that claimed the block (went active); null before any does.
  let activeId: string | null = null
  // Recognizers out for the rest of this session — evicted by an active rival,
  // self-cancelled, or already committed.
  const cancelled = new Set<string>()

  const resetSession = (): void => {
    activeId = null
    cancelled.clear()
  }

  const toPointer = (sample: PointerSample): GesturePointer => ({
    pointerId: sample.pointerId,
    x: sample.clientX,
    y: sample.clientY,
    pointerType: sample.pointerType,
    target: sample.target,
  })

  const sessionWith = (changed: GesturePointer): GestureSession => ({
    // The changed pointer's map entry can hold stale coordinates relative to
    // this event: `handlePointerUp` runs BEFORE the map is updated (so the
    // ending pointer is still present, as the API promises) and `handlePointerCancel`
    // reads before deleting. Override that entry with `changed` so a recognizer
    // reading `session.pointers` sees the ending pointer's FINAL position, not
    // its previous pointerdown/last-move one. For down/move the map already holds
    // `changed`, so this is a no-op there.
    pointers: [...pointers.values()].map(p => (p.pointerId === changed.pointerId ? changed : p)),
    changed,
  })

  const isEligible = (recognizer: GestureRecognizer): boolean =>
    !cancelled.has(recognizer.id) && (activeId === null || activeId === recognizer.id)

  const cancelOthers = (
    keepId: string,
    session: GestureSession,
    ctx: GestureEventContext,
  ): void => {
    for (const recognizer of recognizers) {
      if (recognizer.id === keepId || cancelled.has(recognizer.id)) continue
      cancelled.add(recognizer.id)
      recognizer.onPointerCancel?.(session, ctx)
    }
  }

  // Apply one recognizer's verdict. Returns whether the event was HANDLED (a
  // commit — stops further recognizers this event) and whether to preventDefault.
  const applyVerdict = (
    recognizer: GestureRecognizer,
    verdict: GesturePhaseResult,
    session: GestureSession,
    ctx: GestureEventContext,
  ): { handled: boolean; prevent: boolean } => {
    switch (verdict.status) {
      case 'idle':
        return {handled: false, prevent: false}
      case 'active':
        if (activeId !== recognizer.id) {
          activeId = recognizer.id
          cancelOthers(recognizer.id, session, ctx)
        }
        return {handled: false, prevent: true}
      case 'commit': {
        dispatch(verdict.gesture, verdict.deps, ctx.event, verdict.phase)
        cancelled.add(recognizer.id)
        if (activeId === recognizer.id) activeId = null
        // The recognizer DID commit, so it's out and no other recognizer should
        // reinterpret the same motion — `handled` stops the loop regardless.
        // Whether the native default is suppressed (and the trailing synthesized
        // click swallowed) is the DISPATCHER's call, not ours: `dispatch` runs
        // applyGestureEventOptions, which preventDefaults `ctx.event` per the
        // winning action's context event-options. We mirror that decision via
        // `defaultPrevented` instead of forcing it on `handled`, so the same
        // event-options contract keyboard/pointer honor applies here: an action
        // whose context opts out (`preventDefault: false`), and an unhandled
        // commit (nothing prevented it), both leave the native click/focus alone.
        return {handled: true, prevent: ctx.event.defaultPrevented}
      }
      case 'cancel':
        cancelled.add(recognizer.id)
        if (activeId === recognizer.id) activeId = null
        return {handled: false, prevent: false}
    }
  }

  const run = (
    phase: 'down' | 'move' | 'up',
    sample: PointerSample,
  ): boolean => {
    const changed = toPointer(sample)
    const session = sessionWith(changed)
    const ctx: GestureEventContext = {element, event: sample.event}
    let prevent = false
    // Contribution order is the tiebreak: the first recognizer to commit wins
    // this event; an `active` recognizer has already evicted the rest.
    for (const recognizer of recognizers) {
      if (!isEligible(recognizer)) continue
      const handler =
        phase === 'down' ? recognizer.onPointerDown
          : phase === 'move' ? recognizer.onPointerMove
          : recognizer.onPointerUp
      const verdict = handler?.call(recognizer, session, ctx) ?? GESTURE_IDLE
      const {handled, prevent: shouldPrevent} = applyVerdict(recognizer, verdict, session, ctx)
      if (shouldPrevent) prevent = true
      if (handled) break
    }
    return prevent
  }

  return {
    handlePointerDown(sample) {
      pointers.set(sample.pointerId, toPointer(sample))
      return run('down', sample)
    },
    handlePointerMove(sample) {
      // A move for a pointer we never saw go down isn't part of any session.
      if (!pointers.has(sample.pointerId)) return false
      pointers.set(sample.pointerId, toPointer(sample))
      return run('move', sample)
    },
    handlePointerUp(sample) {
      // Run BEFORE removing the pointer so the session still includes it.
      const prevent = run('up', sample)
      pointers.delete(sample.pointerId)
      if (pointers.size === 0) resetSession()
      return prevent
    },
    handlePointerCancel(sample) {
      const changed = toPointer(sample)
      const session = sessionWith(changed)
      const ctx: GestureEventContext = {element, event: sample.event}
      for (const recognizer of recognizers) {
        if (cancelled.has(recognizer.id)) continue
        recognizer.onPointerCancel?.(session, ctx)
      }
      pointers.delete(sample.pointerId)
      if (pointers.size === 0) resetSession()
    },
    get touchAction() {
      return unionTouchAction(recognizers.map(r => r.touchAction ?? ''))
    },
  }
}

const toSample = (event: PointerEvent): PointerSample => ({
  pointerId: event.pointerId,
  clientX: event.clientX,
  clientY: event.clientY,
  pointerType: event.pointerType,
  target: event.target,
  event,
})

/** How long a click swallow stays armed waiting for the synthesized click. The
 *  click follows `pointerup` within a frame; this generous window only matters
 *  as a self-disarm so a gesture that produced NO click can't eat a later real
 *  one. */
const SUPPRESS_CLICK_WINDOW_MS = 400

/**
 * Swallow the next `click` on `element` (capture phase, one-shot). Under Pointer
 * Events, canceling `pointerup` does NOT suppress the compatibility `click` —
 * only canceling `pointerdown` suppresses compat mouse events, and we can't do
 * that (a down can't know it will become a committed gesture, and it would also
 * kill focus/selection). So after a committed up-gesture we explicitly eat the
 * trailing click here, or it lands on the block / an interactive descendant
 * after the gesture action already ran. Capture + `stopPropagation` keeps it from
 * descendants; `once` disarms on the first click and the timeout disarms if none
 * is synthesized (desktop, or a browser that already suppressed it).
 */
export const suppressNextClick = (element: HTMLElement): void => {
  const onClick = (event: Event): void => {
    event.preventDefault()
    event.stopPropagation()
  }
  // `once` disarms on the first click; the timeout disarms if no click is
  // synthesized (desktop, or a browser that already suppressed it) so a later
  // real click isn't swallowed. If the click already fired, removeEventListener
  // is a harmless no-op.
  element.addEventListener('click', onClick, {capture: true, once: true})
  setTimeout(() => element.removeEventListener('click', onClick, true), SUPPRESS_CLICK_WINDOW_MS)
}

/**
 * Wire the per-block recognition loop onto a content-surface element. Attaches
 * native Pointer Event listeners (move is non-passive so `preventDefault` works
 * as the `touch-action` fallback) and applies the recognizers' union
 * `touch-action`. A no-op when no recognizer is contributed, so every block that
 * has none pays nothing.
 *
 * Returns a CALLBACK REF the caller must attach to the content node (instead of
 * a plain ref object). The callback bumps a version counter the listener effect
 * depends on, so the effect re-runs when the content node is REMOUNTED (e.g.
 * `ContentSlot` swaps after a renderer / surface change) while `recognizers` is
 * unchanged. A plain ref object's identity never changes, so the effect wouldn't
 * re-run and the listeners would stay bound to the now-detached old node,
 * silently killing gestures on the new surface. The caller's own `elementRef` is
 * still written through, so other consumers of that ref (the shell decorator
 * stack, …) keep seeing the node.
 */
export const useContinuousGestures = (
  context: BlockResolveContext,
  elementRef: RefObject<HTMLElement | null>,
): RefCallback<HTMLElement> => {
  const runtime = useAppRuntime()
  const resolveRecognizers = runtime.read(continuousGestureRecognizersFacet)
  const recognizers = useMemo(
    () => resolveRecognizers(context),
    [resolveRecognizers, context],
  )

  // The live content node, kept in a ref (not state) so the imperative
  // `touch-action` / listener mutations below aren't flagged as state writes —
  // and a version counter, bumped on each attach/detach, that the effect depends
  // on so it re-runs when the node identity changes (the remount case). Reading
  // a stable RefObject alone wouldn't re-trigger the effect.
  const nodeRef = useRef<HTMLElement | null>(null)
  const [nodeVersion, setNodeVersion] = useState(0)
  const setRef = useCallback(
    (node: HTMLElement | null): void => {
      elementRef.current = node
      nodeRef.current = node
      setNodeVersion(v => v + 1)
    },
    [elementRef],
  )

  useEffect(() => {
    const element = nodeRef.current
    if (!element || recognizers.length === 0) return

    const controller = createBlockGestureController({recognizers, element})

    // touch-action is the load-bearing scroll-suppression mechanism for touch
    // (see module header). Set imperatively and restored on cleanup; React
    // never manages this property so it won't be clobbered by re-renders.
    const previousTouchAction = element.style.touchAction
    if (controller.touchAction) element.style.touchAction = controller.touchAction

    const onDown = (event: PointerEvent): void => {
      if (controller.handlePointerDown(toSample(event))) event.preventDefault()
    }
    const onMove = (event: PointerEvent): void => {
      if (controller.handlePointerMove(toSample(event))) event.preventDefault()
    }
    const onUp = (event: PointerEvent): void => {
      if (controller.handlePointerUp(toSample(event))) {
        event.preventDefault()
        // pointerup cancelation can't stop the synthesized click (PE spec) — arm
        // a one-shot swallow so a handled up-gesture doesn't also fire a click.
        suppressNextClick(element)
      }
    }
    const onCancel = (event: PointerEvent): void => {
      controller.handlePointerCancel(toSample(event))
    }

    element.addEventListener('pointerdown', onDown)
    element.addEventListener('pointermove', onMove, {passive: false})
    element.addEventListener('pointerup', onUp)
    element.addEventListener('pointercancel', onCancel)

    return () => {
      element.removeEventListener('pointerdown', onDown)
      element.removeEventListener('pointermove', onMove)
      element.removeEventListener('pointerup', onUp)
      element.removeEventListener('pointercancel', onCancel)
      element.style.touchAction = previousTouchAction
    }
    // nodeVersion is the re-run trigger: it changes whenever the attached node
    // does, so the effect tears down the old node's listeners and rebinds to the
    // new one. The effect reads nodeRef.current directly.
  }, [recognizers, nodeVersion])

  return setRef
}

// Re-exported so callers building commit verdicts get the trigger type without
// importing from two modules.
export type { ActionTrigger }
