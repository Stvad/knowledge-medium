/**
 * The migration's progress surface, in the shape the gesture already reports
 * through (`update` / `done` / `fail`) so the call sites do not change — backed
 * by a blocking modal rather than a toast.
 */
import { CallbackSet } from '@/utils/callbackSet'
import { openDialog } from '@/utils/dialogs.js'
import {
  MigrationProgressDialog,
  type MigrationProgressState,
} from './MigrationProgressDialog.tsx'

/** Shown when the gesture returns without having reported an outcome. Reaching
 *  it is a bug, but the alternative is a modal with no way out — a reload is
 *  then the only escape, over a pass whose result the user was never told. */
const UNREPORTED =
  'The migration stopped without reporting what happened. Check this device\'s logs; '
  + 'running it again on this device is safe and resumes where it stopped.'

export interface MigrationProgress {
  /** Replace the status line. Ignored once an outcome has been reported: the
   *  pass notifies per committed batch and its subscription is torn down after
   *  the outcome, so a late notification would otherwise put a finished
   *  migration back into its running state — with no way to close it. */
  update: (message: string) => void
  done: (finalMessage?: string) => void
  fail: (message: string) => void
  /** Terminal state for a gesture that ended without calling `done` or `fail`.
   *  Call from the gesture's `finally`; a no-op once an outcome was reported. */
  settleUnreported: () => void
}

export const showBlockingMigrationProgress = (initial: string): MigrationProgress => {
  let state: MigrationProgressState = {kind: 'running', message: initial}
  const listeners = new CallbackSet<[]>('properties-migration-progress')
  const set = (next: MigrationProgressState): void => {
    state = next
    listeners.notify()
  }
  // Not awaited: the promise resolves when the USER closes the dialog, which is
  // after the gesture has finished reporting into it.
  void openDialog(MigrationProgressDialog, {
    getState: () => state,
    subscribe: (listener: () => void) => listeners.add(listener),
  })
  return {
    update: message => { if (state.kind === 'running') set({kind: 'running', message}) },
    done: finalMessage => set({kind: 'done', message: finalMessage ?? 'Migration finished.'}),
    fail: message => set({kind: 'failed', message}),
    settleUnreported: () => {
      if (state.kind === 'running') set({kind: 'failed', message: UNREPORTED})
    },
  }
}
