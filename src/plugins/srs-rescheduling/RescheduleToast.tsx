import { useSyncExternalStore } from 'react'
import { ChangeScope } from '@/data/api'
import { Button } from '@/components/ui/button'
import { dismissToast, showError } from '@/utils/toast.ts'
import type { Repo } from '@/data/repo'

export interface RescheduleToastProps {
  toastId: string | number
  message: string
  txId: string
  repo: Repo
}

/** Custom toast body for SRS reschedule feedback. The Undo button
 *  reactively disables itself once another `BlockDefault` tx lands on
 *  top — at that point `repo.undo()` would revert the wrong action,
 *  so the toast hands the user off to cmd-Z. Invoked via
 *  `showRescheduleToast` in the SRS plugin entry. */
export const RescheduleToast = ({toastId, message, txId, repo}: RescheduleToastProps) => {
  const isTopOfStack = useSyncExternalStore(
    cb => repo.undoManager.subscribe(ChangeScope.BlockDefault, cb),
    () => repo.undoManager.peekUndo(ChangeScope.BlockDefault)?.txId === txId,
    () => repo.undoManager.peekUndo(ChangeScope.BlockDefault)?.txId === txId,
  )

  const handleUndo = () => {
    repo.undo().catch((err: unknown) => {
      showError(err instanceof Error ? err.message : 'Could not undo reschedule')
    })
    dismissToast(toastId)
  }

  return (
    <div className="flex w-[var(--width)] min-w-[260px] items-center gap-3 rounded-md border bg-background px-4 py-3 text-sm shadow-lg">
      <span className="flex-1">{message}</span>
      <Button
        variant="ghost"
        size="sm"
        disabled={!isTopOfStack}
        onClick={handleUndo}
        title={isTopOfStack ? 'Undo this reschedule' : 'Another action ran since — use cmd-Z to step back'}
      >
        Undo
      </Button>
    </div>
  )
}

