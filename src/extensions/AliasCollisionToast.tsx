/**
 * Custom toast body for `alias.collision` rejections. Two affordances:
 *   - "Open" navigates to the existing block (same as the legacy
 *     single-button toast) so the user can review what's there before
 *     deciding whether to merge.
 *   - "Merge into …" folds the rejected source into the existing block
 *     via the alias-collision merge mutator. Source is soft-deleted,
 *     target content is kept, and rename-origin metadata decides which
 *     source alias should be rewritten to the colliding alias.
 *
 * The merge is one-click — no confirmation step — because (a) the user
 * explicitly picked "Merge" knowing what it does, (b) `repo.undo()`
 * (and Cmd-Z) revert the whole tx if they change their mind. Mirrors
 * `RescheduleToast`'s direct-action-with-Undo philosophy.
 */
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { getLayoutSessionBlock, getUIStateBlock } from '@/data/stateBlocks.js'
import { navigate } from '@/utils/navigation.js'
import { dismissToast, showError } from '@/utils/toast.js'
import type { Repo } from '@/data/repo'
import { ALIAS_COLLISION_MERGE_MUTATOR } from '@/plugins/alias/collisionMerge'
import { getLayoutSessionId } from '@/utils/layoutSessionId.js'
import { retargetPanelBlockIds } from '@/utils/panelLayoutProjection.js'

export interface AliasCollisionToastProps {
  toastId: string | number
  message: string
  alias: string
  attemptedOn: string
  conflictingBlockId: string
  conflictingBlockTitle: string
  workspaceId: string
  dropSourceAliases?: string[]
  /** False when the rejected source block was created inside the
   *  rolled-back tx — it no longer exists, so a merge would throw
   *  "source not found". The merge button is hidden instead. */
  offerMerge: boolean
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
  dropSourceAliases,
  offerMerge,
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
      await repo.run(ALIAS_COLLISION_MERGE_MUTATOR, {
        intoId: conflictingBlockId,
        fromId: attemptedOn,
        collisionAlias: alias,
        dropSourceAliases,
      })
      const uiState = await getUIStateBlock(repo, workspaceId, repo.user, {})
      const layoutSessionBlock = await getLayoutSessionBlock(uiState, getLayoutSessionId())
      try {
        await retargetPanelBlockIds(repo, layoutSessionBlock, attemptedOn, conflictingBlockId)
      } catch (error) {
        console.error('[AliasCollisionToast] Failed to retarget panels after merge', error)
        showError('Merge completed, but panel update failed')
      }
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
        {offerMerge && (
          <Button variant="default" size="sm" disabled={pending} onClick={() => { void mergeIntoExisting() }}>
            {pending ? 'Merging…' : mergeLabel}
          </Button>
        )}
      </div>
    </div>
  )
}
