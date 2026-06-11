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
 * This module owns four cross-cutting concerns so recognizers don't each
 * re-implement them (the bespoke `swipeGesture.ts` / `dateScrubGesture.ts`
 * machinery this replaces did):
 *  - the per-block pointer SESSION (which pointers are down, where), built from
 *    Pointer Events (mouse/touch/pen unified; `pointerId` pairs an event to its
 *    pointer the way the old code tracked `Touch.identifier` by hand);
 *  - ARBITRATION — one recognizer at a time owns a block (LAST-ACTIVE-WINS):
 *    when one goes `active` the others are evicted (their in-flight state
 *    dropped) but stay ELIGIBLE, so a later gesture can take the block over once
 *    the owner releases — the 1-finger swipe yields on a 2nd finger and the
 *    2-finger scrub then claims. This absorbs `blockGestureConflicts`;
 *  - ENABLEMENT — a recognizer's `isEnabled` gate (mobile viewport, not editing,
 *    …) is the single source of truth for whether it's applicable here-and-now:
 *    the loop skips a disabled recognizer's handlers and drops it from the
 *    `touch-action` union, so each recognizer states applicability ONCE instead
 *    of re-checking it in every handler. Per-event OWNERSHIP (pointer type,
 *    finger count, interactive target) is the separate concern that stays in the
 *    handlers;
 *  - the non-passive listener + `touch-action` SEAM for scroll suppression.
 *
 * Recognition that the model can't express stays possible: a plugin can ignore
 * this facet, contribute raw `blockContentSurfacePropsFacet` handlers, and reach
 * the same trigger via `dispatchGesture` directly (the escape hatch).
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { RefCallback, RefObject } from 'react'
import { defineFacet, isFunction } from '@/extensions/facet.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import type { BlockResolveContext } from '@/extensions/blockInteraction.js'
import type { ActionTrigger, BaseShortcutDependencies } from '@/shortcuts/types.js'
import {
  dispatchGesture as defaultDispatchGesture,
  beginGestureProgress as defaultBeginGestureProgress,
  type GestureProgressDispatch,
} from '@/shortcuts/gestureAction.js'

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
 *  - `progress` — like `active` (claims the block, preventDefaults), and ALSO
 *    streams a live-preview tick to the action resolved for this gesture's
 *    `progress` phase. The winner is resolved ONCE on the first progress tick
 *    (by context priority) and every later tick goes to it; `event` carries the
 *    recognizer's payload (drag delta, …). Settle is automatic: the loop tells
 *    the resolved action to settle on `cancel` / `pointercancel` / a release
 *    that doesn't `commit`.
 *  - `commit` — dispatch this named gesture with these deps through `resolve`.
 *    Ends any in-flight preview WITHOUT a settle (the commit action takes over
 *    the visual).
 *  - `cancel` — drop my claim; I'm out for the rest of this session. Settles an
 *    in-flight preview back.
 */
export type GesturePhaseResult =
  | { readonly status: 'idle' }
  | { readonly status: 'active' }
  | {
      readonly status: 'progress'
      readonly gesture: string
      readonly deps: BaseShortcutDependencies
      readonly event: ActionTrigger
    }
  | {
      readonly status: 'commit'
      readonly gesture: string
      readonly deps: BaseShortcutDependencies
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
  /** Reactive applicability: is this gesture live for this block RIGHT NOW? The
   *  coarse, surface-level gate (e.g. mobile viewport, not editing) that the
   *  recognizer's pointer handlers would otherwise each re-check. The loop reads
   *  it as the single source of truth: a recognizer that isn't enabled is
   *  excluded from the `touch-action` union AND skipped in the recognition loop,
   *  so its handlers only ever see events it could actually own — per-event
   *  OWNERSHIP (pointer type, finger count, interactive target) is a separate
   *  concern that stays in the handlers. Omitted ⇒ always enabled. Read live (no
   *  event arg), so keep it a cheap synchronous check; the React layer recomputes
   *  `touch-action` from it each render. If a recognizer becomes disabled
   *  mid-gesture while it owns the block, the loop cancels it so it drops
   *  in-flight state. */
  isEnabled?(): boolean
  /** CSS `touch-action` this gesture needs WHILE enabled (e.g. `'pan-y'`). The
   *  loop applies the union of its ENABLED recognizers' values to the surface so
   *  the browser yields the right axis BEFORE the gesture starts — a non-passive
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

/**
 * The `touch-action` a surface should carry right now: the union (see
 * `unionTouchAction`) over only the recognizers that are currently ENABLED. A
 * disabled recognizer can't fire, so it must not constrain the surface — this is
 * what keeps `pan-y` off a block whose gesture is inapplicable (desktop
 * viewport, an editing block, …). `isEnabled` is read live, so the React layer
 * recomputes this each render as enablement changes.
 */
export const enabledTouchAction = (recognizers: readonly GestureRecognizer[]): string | undefined =>
  unionTouchAction(recognizers.filter(r => r.isEnabled?.() ?? true).map(r => r.touchAction ?? ''))

interface ControllerArgs {
  readonly recognizers: readonly GestureRecognizer[]
  readonly element: HTMLElement
  readonly dispatch?: typeof defaultDispatchGesture
  readonly beginProgress?: typeof defaultBeginGestureProgress
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
  beginProgress = defaultBeginGestureProgress,
}: ControllerArgs): BlockGestureController => {
  const pointers = new Map<number, GesturePointer>()
  // The recognizer that claimed the block (went active); null before any does.
  let activeId: string | null = null
  // Recognizers OUT for the rest of this session: committed, or self-cancelled
  // (a `cancel` verdict). Eviction by a rival does NOT add here — that drops the
  // evicted recognizer's in-flight state but leaves it eligible, so a later
  // gesture can take the block over (last-active-wins). The active recognizer
  // still shuts rivals out meanwhile via `isEligible`'s `activeId` gate.
  const out = new Set<string>()
  // The live-preview resolution for the recognizer currently streaming
  // `progress`. Set once on its first tick and held for the rest of the gesture:
  // `dispatch` is the resolved winner's handle, or null when the gesture's
  // progress phase bound no dispatchable action. Keeping the record even when
  // `dispatch` is null is what stops us re-resolving (getEffectiveActions +
  // filter) on every pointer-move tick of an unpreviewed gesture. `progress`
  // itself is null only when nothing is streaming.
  let progress: { readonly recognizerId: string; readonly dispatch: GestureProgressDispatch | null } | null = null

  // Settle an in-flight preview back to rest and forget it. Called on every
  // non-committing end (cancel verdict, pointercancel, release without commit).
  const settleProgress = (): void => {
    progress?.dispatch?.settle()
    progress = null
  }

  const resetSession = (): void => {
    // A release that didn't commit leaves the preview open — settle it so the
    // toolbar/affordance animates home rather than freezing mid-reveal.
    settleProgress()
    activeId = null
    out.clear()
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
    !out.has(recognizer.id) && (activeId === null || activeId === recognizer.id)

  // The recognizer's own applicability gate (mobile viewport, not editing, …),
  // read live per event. Absent ⇒ always enabled. This is the single source of
  // truth the per-event loop and the `touch-action` union both consult.
  const enabled = (recognizer: GestureRecognizer): boolean => recognizer.isEnabled?.() ?? true

  // Evict every OTHER recognizer for the claimer: fire their onPointerCancel so
  // they drop in-flight state (a half-built swipe `start`, a previewing menu),
  // but do NOT bar them — they stay eligible so a later gesture can take the
  // block over once the claimer releases (last-active-wins). Only a `commit` or
  // `cancel` verdict adds to `out`; skip those here so a recognizer that's
  // already done isn't cancelled twice.
  const evictRivals = (
    keepId: string,
    session: GestureSession,
    ctx: GestureEventContext,
  ): void => {
    for (const recognizer of recognizers) {
      if (recognizer.id === keepId || out.has(recognizer.id)) continue
      recognizer.onPointerCancel?.(session, ctx)
    }
  }

  // Claim the block for `recognizer`: first claim of the gesture evicts every
  // rival (one active recognizer per block). Shared by the `active` and
  // `progress` verdicts, which claim identically.
  const claim = (
    recognizer: GestureRecognizer,
    session: GestureSession,
    ctx: GestureEventContext,
  ): void => {
    if (activeId === recognizer.id) return
    activeId = recognizer.id
    evictRivals(recognizer.id, session, ctx)
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
        // An `active` verdict from the recognizer that WAS previewing means
        // "I'm taking over without a preview" — settle the in-flight one so it
        // can't freeze mid-reveal while the finger stays down.
        if (progress?.recognizerId === recognizer.id) settleProgress()
        claim(recognizer, session, ctx)
        return {handled: false, prevent: true}
      case 'progress':
        // Streaming a preview claims the block exactly like `active`.
        claim(recognizer, session, ctx)
        // Resolve the winning preview action once (first tick of this recognizer),
        // then stream every tick — including this one — to it. The record is kept
        // even when resolution finds nothing, so we don't re-resolve per tick.
        if (!progress || progress.recognizerId !== recognizer.id) {
          progress = {recognizerId: recognizer.id, dispatch: beginProgress(verdict.gesture, verdict.deps)}
        }
        progress.dispatch?.update(verdict.event)
        return {handled: false, prevent: true}
      case 'commit': {
        // The commit action takes over the visual, so drop the preview WITHOUT
        // settling it (no animate-home).
        if (progress?.recognizerId === recognizer.id) progress = null
        dispatch(verdict.gesture, verdict.deps, ctx.event)
        out.add(recognizer.id)
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
        if (progress?.recognizerId === recognizer.id) settleProgress()
        out.add(recognizer.id)
        if (activeId === recognizer.id) activeId = null
        return {handled: false, prevent: false}
    }
  }

  // An owner whose enablement gate flipped off mid-gesture (the block entered
  // edit mode, the viewport crossed the mobile breakpoint, …) can no longer
  // fire, so release it cleanly: fire its cancel so it drops in-flight state (an
  // open scrub overlay, a half-built swipe) and settle any preview it streamed.
  // It is NOT added to `out` — once re-enabled it can claim a fresh gesture.
  const releaseDisabledOwner = (session: GestureSession, ctx: GestureEventContext): void => {
    if (activeId === null) return
    const owner = recognizers.find(r => r.id === activeId)
    if (!owner || enabled(owner)) return
    owner.onPointerCancel?.(session, ctx)
    if (progress?.recognizerId === owner.id) settleProgress()
    activeId = null
  }

  const run = (
    phase: 'down' | 'move' | 'up',
    sample: PointerSample,
  ): boolean => {
    const changed = toPointer(sample)
    const session = sessionWith(changed)
    const ctx: GestureEventContext = {element, event: sample.event}
    releaseDisabledOwner(session, ctx)
    let prevent = false
    // Contribution order is the tiebreak: the first recognizer to commit wins
    // this event; an `active` recognizer has already evicted the rest.
    for (const recognizer of recognizers) {
      if (!isEligible(recognizer) || !enabled(recognizer)) continue
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
        if (out.has(recognizer.id)) continue
        recognizer.onPointerCancel?.(session, ctx)
      }
      pointers.delete(sample.pointerId)
      if (pointers.size === 0) resetSession()
    },
    get touchAction() {
      return enabledTouchAction(recognizers)
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

/**
 * Capture the pointer to the surface once a recognizer engages it, so a drag
 * that wanders off the block still delivers its terminal `pointerup` /
 * `pointercancel` HERE. Touch pointers are implicitly captured to their target
 * on `pointerdown`; mouse and pen are NOT — so without this an off-block mouse/
 * pen release lands elsewhere, the controller never sees the up, and the block
 * stays stranded in an in-flight gesture (later gestures then route only to the
 * stale active recognizer). Idempotent per spec, and guarded: jsdom lacks the
 * API and the call can throw if the pointer is already gone — both non-fatal.
 */
const capturePointer = (element: HTMLElement, pointerId: number): void => {
  try {
    element.setPointerCapture(pointerId)
  } catch {
    // unsupported (jsdom) or the pointer is no longer active — nothing to hold.
  }
}

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
 * Subscribe to viewport changes that can flip a recognizer's `isEnabled`
 * (crossing a width breakpoint, an orientation change). Deliberately generic —
 * it carries no specific media query, so whatever breakpoint a recognizer reads
 * is covered; the `touch-action` snapshot's value-equality (a string) keeps a
 * resize that doesn't change enablement from re-rendering. Module-level so its
 * identity is stable across renders (a changing `subscribe` would re-subscribe
 * every render).
 */
const subscribeViewport = (onChange: () => void): (() => void) => {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener('resize', onChange)
  window.addEventListener('orientationchange', onChange)
  return () => {
    window.removeEventListener('resize', onChange)
    window.removeEventListener('orientationchange', onChange)
  }
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
 *
 * `context` MUST be referentially stable across renders — `recognizers` is
 * memoized on it, and a new identity each render would rebuild the controller
 * mid-drag, dropping in-flight gesture / arbitration / preview state. Callers
 * pass a memoized resolve context (the block shell already does).
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

    const onDown = (event: PointerEvent): void => {
      if (controller.handlePointerDown(toSample(event))) event.preventDefault()
    }
    const onMove = (event: PointerEvent): void => {
      if (controller.handlePointerMove(toSample(event))) {
        event.preventDefault()
        // A prevented move means a recognizer claimed the block (went
        // active/progress) — the gesture has engaged, so pin the stream to this
        // element for the rest of the drag (no-op for the already-captured touch
        // case; the fix is for mouse/pen). Capture auto-releases on up/cancel.
        capturePointer(element, event.pointerId)
      }
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
    }
    // nodeVersion is the re-run trigger: it changes whenever the attached node
    // does, so the effect tears down the old node's listeners and rebinds to the
    // new one. The effect reads nodeRef.current directly.
  }, [recognizers, nodeVersion])

  // touch-action is the load-bearing scroll-suppression hint for touch (see
  // module header), applied in its OWN effect — separate from the listener loop
  // above — so an enablement change re-applies it WITHOUT rebuilding the
  // controller (which would drop in-flight gesture / arbitration / preview
  // state). `enabledTouchAction` reads each recognizer's `isEnabled` LIVE, so the
  // value has to be recomputed whenever enablement changes:
  //   - EDITING flips re-render the host already (it reads edit mode), and the
  //     snapshot is re-read on every render, so those are picked up for free;
  //   - VIEWPORT changes are NOT otherwise observed here — the host's
  //     `useIsMobile` lives in child slot components, so crossing the breakpoint
  //     re-renders those children, not this hook. `useSyncExternalStore`
  //     subscribes to viewport resizes so a breakpoint cross recomputes and
  //     re-applies, rather than stranding a stale `pan-y` (gesture refuses to
  //     run yet scroll is suppressed) or a missing one (browser cancels the
  //     swipe/scrub before JS sees it).
  // The string snapshot makes the store's Object.is bail-out a no-op for resizes
  // that don't change enablement. React never manages this property, so the
  // effect captures and restores the prior value rather than clobbering it. The
  // loop's per-event `isEnabled` gate stays the behavioral source of truth; this
  // only keeps the surface hint in agreement with it.
  const desiredTouchAction = useSyncExternalStore(
    subscribeViewport,
    () => enabledTouchAction(recognizers),
    () => enabledTouchAction(recognizers),
  )
  useEffect(() => {
    const element = nodeRef.current
    if (!element || recognizers.length === 0) return
    const previousTouchAction = element.style.touchAction
    if (desiredTouchAction) element.style.touchAction = desiredTouchAction
    return () => {
      element.style.touchAction = previousTouchAction
    }
  }, [desiredTouchAction, recognizers, nodeVersion])

  return setRef
}

// Re-exported so callers building commit verdicts get the trigger type without
// importing from two modules.
export type { ActionTrigger }
