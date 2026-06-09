/**
 * Gesture binding — the recognized/named trigger analogue of the structural
 * keyboard chord (`defaultBinding`) and pointer (`pointerBinding`) bindings.
 *
 * A continuous gesture (swipe, two-finger date-scrub, …) isn't self-describing
 * the way a click is: a finger drag only *becomes* `'swipe-left'` after a
 * recognizer applies thresholds + direction-lock. So a recognizer emits a
 * gesture NAME and an action binds to that name — the recognizer never names
 * the action, symmetric with how a chord/click never names its action. See
 * `docs/continuous-gesture-triggers.md`.
 *
 * Names are opaque strings, like chords; there is no registration required to
 * emit or bind one. The matcher here is pure (no DOM/React) so it stays
 * unit-testable, mirroring `matchesMouseEvent`.
 */

/**
 * When in the gesture lifecycle a binding resolves. Only `'commit'` today —
 * `'start'` / `'cancel'` are reserved so they can become bindable without a
 * rewrite (the live preview during a drag stays recognizer-private and is NOT a
 * bindable trigger). Mirrors the keyboard `phase` / pointer `phase` fields.
 */
export type GesturePhase = 'commit'

/**
 * A gesture binding declared on an action — names a gesture a recognizer emits
 * (e.g. `'swipe-left'`). A list binds the action to several gestures, the way a
 * pointer binding can list several chords. Defaults: `commit` phase.
 */
export interface GestureBindingSpec {
  readonly gesture: string
  readonly phase?: GesturePhase
}

/** Realized binding the matcher compares against — `phase` defaulted. The
 *  pointer-side analogue is {@link pointerBindingDescriptor}'s output. */
export interface GestureDescriptor {
  readonly gesture: string
  readonly phase: GesturePhase
}

/** Realize a {@link GestureBindingSpec}'s declared/defaulted fields into the
 *  descriptor the matcher compares against. */
export const gestureBindingDescriptor = (spec: GestureBindingSpec): GestureDescriptor => ({
  gesture: spec.gesture,
  phase: spec.phase ?? 'commit',
})

/**
 * The recognized gesture a recognizer (or an escape-hatch surface) emits at
 * commit — the named-trigger analogue of a {@link MouseEventLike}. The
 * coordinator matches this against actions' realized {@link GestureDescriptor}s.
 */
export interface GestureEventLike {
  readonly gesture: string
  readonly phase: GesturePhase
}

/**
 * Does an emitted gesture satisfy a {@link GestureDescriptor}? Name and phase
 * match exactly — there are no modifier/button fields to compare, since the
 * recognizer has already classified the motion into a discrete named gesture.
 */
export const matchesGestureEvent = (
  descriptor: GestureDescriptor,
  event: GestureEventLike,
): boolean =>
  descriptor.gesture === event.gesture && descriptor.phase === event.phase
