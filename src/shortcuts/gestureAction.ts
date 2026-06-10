import type { ActionTrigger, BaseShortcutDependencies } from './types.js'

/**
 * Dispatch a recognized continuous gesture's COMMIT through the same `resolve` +
 * coordinator + run-until-handled path keyboard chords and pointer gestures
 * use. The caller — a core/plugin recognizer, or a raw surface-props escape
 * hatch — supplies the gesture NAME (not an action id), the target block's deps
 * SUPPLIED (the gesture's context isn't keyboard-active), and the originating
 * event (for `preventDefault` / `stopPropagation` on the trailing
 * synthesized click, and logging). This is the commit path only; the live
 * preview goes through {@link BeginGestureProgressFn}.
 *
 * This is the ONLY thing a gesture needs to reach the action system, which is
 * what keeps the trigger vocabulary open: anything that can call `dispatchGesture`
 * publishes a gesture other plugins can bind actions to, facet or not. Returns
 * true when a bound action handled the gesture, false when none matched or every
 * candidate declined.
 */
export type DispatchGestureFn = (
  gesture: string,
  suppliedDeps: BaseShortcutDependencies,
  event: ActionTrigger,
) => boolean

let dispatcher: DispatchGestureFn | null = null

/** Installed by <HotkeyReconciler/> on mount; torn down on unmount so stray
 *  callers fail soft (no gesture action) rather than against a stale runtime. */
export const setGestureActionDispatcher = (next: DispatchGestureFn | null): void => {
  dispatcher = next
}

/** Module-level entry point so non-React callers (recognizers, escape-hatch
 *  surfaces) can dispatch a gesture without threading the runtime. No-op
 *  returning false before the coordinator mounts. */
export const dispatchGesture: DispatchGestureFn = (gesture, suppliedDeps, event) =>
  dispatcher ? dispatcher(gesture, suppliedDeps, event) : false

/**
 * A live-preview session bound to the ONE action resolved for a gesture's
 * `progress` phase at gesture start. Streaming through this handle — rather than
 * re-dispatching every tick — is what gives the preview a stable, context-priority
 * winner for the whole drag (re-resolving per tick could change winners mid-drag
 * and re-runs the resolver at pointer-move frequency).
 */
export interface GestureProgressDispatch {
  /** Forward one in-flight tick to the resolved action. The `event` carries the
   *  recognizer's payload (drag delta, fraction, …); the dispatch layer doesn't
   *  read it. */
  update(event: ActionTrigger): void
  /** Tell the resolved action the gesture ended WITHOUT committing (released
   *  before threshold, reversed, or `pointercancel`) so the preview settles back.
   *  Delivers a synthesized cancel trigger — there's no recognizer event for a
   *  browser-initiated cancel. Named `settle` (not `cancel`) to keep it distinct
   *  from the controller's `cancel` verdict and `onPointerCancel`. */
  settle(): void
}

/**
 * Resolve the winning `progress`-phase action for `gesture` ONCE (by context
 * priority, with the block's deps SUPPLIED) and return a handle that streams to
 * it. Returns null when no progress action is bound / dispatchable for the
 * gesture, so a recognizer can cheaply skip previewing. The commit phase still
 * goes through {@link dispatchGesture} (run-until-handled) — this is only the
 * single-winner preview channel.
 */
export type BeginGestureProgressFn = (
  gesture: string,
  suppliedDeps: BaseShortcutDependencies,
) => GestureProgressDispatch | null

/** Event type a progress action receives on its `cancel()` — the gesture ended
 *  without committing. A progress action distinguishes a settle from an active
 *  tick by `event.type === GESTURE_PROGRESS_CANCEL_EVENT`; active ticks carry the
 *  recognizer's own event type + payload. */
export const GESTURE_PROGRESS_CANCEL_EVENT = 'gesture-progress-cancel'

/** Build the synthesized trigger delivered to a progress action when its gesture
 *  is cancelled (released before threshold / reversed / `pointercancel`). */
export const gestureProgressCancelEvent = (gesture: string): CustomEvent =>
  new CustomEvent(GESTURE_PROGRESS_CANCEL_EVENT, {detail: {gesture}})

let progressDispatcher: BeginGestureProgressFn | null = null

/** Installed alongside the commit dispatcher by <HotkeyReconciler/>. */
export const setGestureProgressDispatcher = (next: BeginGestureProgressFn | null): void => {
  progressDispatcher = next
}

/** Module-level entry point mirroring {@link dispatchGesture}. No-op returning
 *  null before the coordinator mounts. */
export const beginGestureProgress: BeginGestureProgressFn = (gesture, suppliedDeps) =>
  progressDispatcher ? progressDispatcher(gesture, suppliedDeps) : null
