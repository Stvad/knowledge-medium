import type { MouseEvent as ReactMouseEvent } from 'react'
import type { BlockPointerDependencies } from './types.js'

/**
 * Dispatch a pointer (mouse) event through the same `resolve` + coordinator +
 * run-until-handled path keyboard chords use. The block shell calls this with
 * the clicked block's deps SUPPLIED (the gesture's context isn't keyboard-
 * active, so the deps can't come from the active-contexts map). Returns true
 * when a pointer-bound action handled the event, false when none matched or
 * every candidate declined — so the caller can fall back to a default.
 */
export type DispatchPointerActionFn = (
  event: ReactMouseEvent<HTMLElement>,
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
