/**
 * Custom toast body for `alias.collision` rejections. Two affordances:
 *   - "Open" navigates to the existing block (same as the legacy
 *     single-button toast) so the user can review what's there before
 *     deciding whether to merge.
 *   - "Merge into …" folds the rejected source into the existing block
 *     via `core.merge` with `'keepTarget'` content strategy. The
 *     property bag unions (so the colliding alias the user typed lands
 *     on the target along with the rest of the source's properties);
 *     source is soft-deleted.
 *
 * The merge is one-click — no confirmation step — because (a) the user
 * explicitly picked "Merge" knowing what it does, (b) `repo.undo()`
 * (and Cmd-Z) revert the whole tx if they change their mind. Mirrors
 * `RescheduleToast`'s direct-action-with-Undo philosophy.
 */
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { navigate } from '@/utils/navigation.js'
import { dismissToast, showError } from '@/utils/toast.js'
import type { Repo } from '@/data/repo'

export interface AliasCollisionToastProps {
  toastId: string | number
  message: string
  alias: string
  attemptedOn: string
  conflictingBlockId: string
  conflictingBlockTitle: string
  workspaceId: string
  repo: Repo
}

const truncate = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n - 1)}…`

export const AliasCollisionToast = ({
  toastId,
  message,
  alias,
  attemptedOn,
  conflictingBlockId,
  conflictingBlockTitle,
  workspaceId,
  repo,
}: AliasCollisionToastProps) => {
  const [pending, setPending] = useState(false)

  const openExisting = () => {
    navigate(repo, {target: 'main', blockId: conflictingBlockId, workspaceId})
    dismissToast(toastId)
  }

  const mergeIntoExisting = async () => {
    if (pending) return
    setPending(true)
    try {
      await repo.mutate.merge({
        intoId: conflictingBlockId,
        fromId: attemptedOn,
        contentStrategy: 'keepTarget',
      })
      // Navigate to the survivor so the user lands on something live —
      // especially important if they were viewing the source, which is
      // now soft-deleted.
      navigate(repo, {target: 'main', blockId: conflictingBlockId, workspaceId})
      dismissToast(toastId)
    } catch (error) {
      // Surface the failure rather than disappearing silently. Leave
      // the collision toast open so the user can retry or pick Open.
      showError(error instanceof Error ? error.message : 'Merge failed')
      setPending(false)
    }
  }

  const mergeLabel = conflictingBlockTitle.trim() === ''
    ? `Merge into "${alias}"`
    : `Merge into "${truncate(conflictingBlockTitle, 30)}"`

  return (
    <div className="flex w-full min-w-[280px] flex-col gap-2 rounded-md border border-destructive/40 bg-background px-4 py-3 text-sm shadow-lg">
      <span className="text-foreground">{message}</span>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={pending} onClick={openExisting}>
          Open
        </Button>
        <Button variant="default" size="sm" disabled={pending} onClick={() => { void mergeIntoExisting() }}>
          {pending ? 'Merging…' : mergeLabel}
        </Button>
      </div>
    </div>
  )
}
