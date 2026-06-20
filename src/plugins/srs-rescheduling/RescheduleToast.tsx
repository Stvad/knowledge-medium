import { useSyncExternalStore } from 'react'
import { ChangeScope } from '@/data/api'
import { Button } from '@/components/ui/button'
import { dismissToast, showError } from '@/utils/toast.js'
import type { Repo } from '@/data/repo'

export interface RescheduleToastProps {
  toastId: string | number
  message: string
  txId: string
  /** Workspace the reschedule was recorded in. Undo is workspace-scoped
   *  (issue #186), so the Undo button must track this workspace's stack —
   *  `repo.undo()` only reverts the reschedule while it's the active
   *  workspace AND the reschedule is still that workspace's top. */
  workspaceId: string
  repo: Repo
}

/** Predicate: clicking Undo right now would revert exactly this
 *  reschedule. True only when the reschedule's workspace is active and
 *  the reschedule is still that workspace's top BlockDefault entry —
 *  mirroring what `repo.undo()` (workspace-scoped, issue #186) will do. */
const wouldUndoThisReschedule = (
  repo: Repo,
  workspaceId: string,
  txId: string,
): boolean =>
  repo.activeWorkspaceId === workspaceId &&
  repo.undoManager.peekUndoForWorkspace(ChangeScope.BlockDefault, workspaceId)?.txId === txId

/** Custom toast body for SRS reschedule feedback. The Undo button
 *  reactively disables itself once another `BlockDefault` tx lands on
 *  top of the reschedule's workspace — at that point `repo.undo()` would
 *  revert the wrong action, so the toast hands the user off to cmd-Z.
 *  Invoked via `showRescheduleToast` in the SRS plugin entry. */
export const RescheduleToast = ({toastId, message, txId, workspaceId, repo}: RescheduleToastProps) => {
  const isTopOfStack = useSyncExternalStore(
    cb => repo.undoManager.subscribe(ChangeScope.BlockDefault, cb),
    () => wouldUndoThisReschedule(repo, workspaceId, txId),
    () => wouldUndoThisReschedule(repo, workspaceId, txId),
  )

  const handleUndo = () => {
    // Re-check at click time: an in-place workspace switch flips
    // `repo.activeWorkspaceId` without notifying undo subscribers, so the
    // button's enabled-state can lag. Guard against reverting a different
    // workspace's entry (or silently no-opping) by confirming the
    // reschedule is still the live undo target before calling undo().
    if (!wouldUndoThisReschedule(repo, workspaceId, txId)) {
      dismissToast(toastId)
      return
    }
    repo.undo().catch((err: unknown) => {
      showError(err instanceof Error ? err.message : 'Could not undo reschedule')
    })
    dismissToast(toastId)
  }

  return (
    <div className="flex w-full min-w-[260px] items-center gap-3 rounded-md border bg-background px-4 py-3 text-sm shadow-lg">
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

