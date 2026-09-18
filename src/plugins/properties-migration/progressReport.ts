/**
 * Where the migration gesture reports, in the shape its call sites already use
 * (`update` / `done` / `fail`).
 *
 * The two halves go to two different places on purpose. PROGRESS goes to the
 * dialog that blocks this workspace — which is up because the claim is held,
 * not because this gesture opened it, and which closes when the claim clears.
 * The OUTCOME goes to a toast, because it has to survive the dialog closing,
 * and because the gesture reports outcomes on paths where no claim was ever
 * taken (a precondition that refused, a peer that owns the run) and so no
 * dialog is up at all.
 */
import { showError, showInfo } from '@/utils/toast.js'
import { setLocalMigrationMessage } from './localRunMessage.ts'

const OUTCOME_TOAST = {id: 'properties-migration-outcome', duration: Number.POSITIVE_INFINITY}

/** Shown when the gesture returns without having reported an outcome. Reaching
 *  it is a bug; saying nothing would leave the operator watching a dialog
 *  vanish with no account of what the run did. */
const UNREPORTED =
  'The migration stopped without reporting what happened. Check this device\'s logs; '
  + 'running it again on this device is safe and resumes where it stopped.'

export interface MigrationProgress {
  /** Replace the status line in the blocking dialog. Ignored once an outcome
   *  has been reported: the pass notifies per committed batch and its
   *  subscription is torn down after the outcome, so a late notification would
   *  otherwise put a finished migration back into its running state. */
  update: (message: string) => void
  done: (finalMessage?: string) => void
  fail: (message: string) => void
  /** Terminal state for a gesture that ended without calling `done` or `fail`.
   *  Call from the gesture's `finally`; a no-op once an outcome was reported. */
  settleUnreported: () => void
  /** Add a line under the outcome. For what the outcome message cannot know
   *  because it is written before the gesture ends — today, that the workspace
   *  is still held. Ignored while the gesture is still running, where there is
   *  no outcome to qualify. */
  addNote: (note: string) => void
}

export const reportMigrationProgress = (initial: string): MigrationProgress => {
  let outcome: {message: string; failed: boolean} | null = null
  setLocalMigrationMessage(initial)
  const settle = (message: string, failed: boolean): void => {
    if (outcome !== null) return
    outcome = {message, failed}
    setLocalMigrationMessage(null)
    ;(failed ? showError : showInfo)(message, OUTCOME_TOAST)
  }
  return {
    update: message => { if (outcome === null) setLocalMigrationMessage(message) },
    done: finalMessage => { settle(finalMessage ?? 'Migration finished.', false) },
    fail: message => { settle(message, true) },
    settleUnreported: () => { settle(UNREPORTED, true) },
    addNote: note => {
      if (outcome === null) return
      // Re-shown under the SAME id, which replaces the toast rather than
      // stacking a second one beside the outcome it is qualifying.
      const {message, failed} = outcome
      ;(failed ? showError : showInfo)(`${message}\n\n${note}`, OUTCOME_TOAST)
    },
  }
}
