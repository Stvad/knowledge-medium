import type { MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent } from 'react'
import type { BlockPointerDependencies } from './types.js'

/**
 * A pointer gesture event the dispatcher accepts: a mouse event (click,
 * ctrl-click, double-click, …) or a touch event (tap). The coordinator
 * discriminates the two — phase and matching differ — but the entry point is
 * one so callers route every block gesture through a single path.
 */
export type PointerGestureEvent =
  | ReactMouseEvent<HTMLElement>
  | ReactTouchEvent<HTMLElement>

/**
 * Dispatch a pointer gesture through the same `resolve` + coordinator +
 * run-until-handled path keyboard chords use. The block surface calls this with
 * the clicked/tapped block's deps SUPPLIED (the gesture's context isn't
 * keyboard-active, so the deps can't come from the active-contexts map). Returns
 * true when a pointer-bound action handled the event, false when none matched or
 * every candidate declined — so the caller can fall back to a default.
 */
export type DispatchPointerActionFn = (
  event: PointerGestureEvent,
  suppliedDeps: BlockPointerDependencies,
) => boolean

let dispatcher: DispatchPointerActionFn | null = null

/** Installed by <HotkeyReconciler/> on mount; torn down on unmount so stray
 *  callers fail soft (no pointer action) rather than against a stale runtime. */
export const setPointerActionDispatcher = (next: DispatchPointerActionFn | null): void => {
  dispatcher = next
}

/** Module-level entry point so non-React callers (and the block shell) can
 *  dispatch a pointer gesture without threading the runtime. No-op returning
 *  false before the coordinator mounts. */
export const dispatchPointerAction: DispatchPointerActionFn = (event, suppliedDeps) =>
  dispatcher ? dispatcher(event, suppliedDeps) : false
