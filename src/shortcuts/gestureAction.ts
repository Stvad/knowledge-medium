import type { ActionTrigger, BaseShortcutDependencies } from './types.js'
import type { GesturePhase } from './gestureBinding.js'

/**
 * Dispatch a recognized continuous gesture through the same `resolve` +
 * coordinator + run-until-handled path keyboard chords and pointer gestures
 * use. The caller — a core/plugin recognizer, or a raw surface-props escape
 * hatch — supplies the gesture NAME (not an action id), the target block's deps
 * SUPPLIED (the gesture's context isn't keyboard-active), and the originating
 * event (for `preventDefault` / `stopPropagation` on the trailing
 * synthesized click, and logging).
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
  phase?: GesturePhase,
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
export const dispatchGesture: DispatchGestureFn = (gesture, suppliedDeps, event, phase) =>
  dispatcher ? dispatcher(gesture, suppliedDeps, event, phase) : false
