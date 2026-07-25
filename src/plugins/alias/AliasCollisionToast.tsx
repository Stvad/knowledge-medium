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
import { truncate } from '@/utils/string'
import { Button } from '@/components/ui/button'
import { getLayoutSessionBlock, getUIStateBlock } from '@/data/stateBlocks.js'
import { navigate } from '@/utils/navigation.js'
import { dismissToast, showError } from '@/utils/toast.js'
import { MergeIntoDescendantError } from '@/data/api'
import type { Repo } from '@/data/repo'
import { ALIAS_COLLISION_MERGE_MUTATOR } from './collisionMerge.ts'
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
  // Set once a merge fails a precondition that no retry can satisfy (the
  // target is nested inside the page being renamed). Hides the doomed
  // "Merge into…" button so the toast stops looping on the same failure
  // and steers the user to "Open" for manual resolution (#188).
  const [mergeBlocked, setMergeBlocked] = useState(false)

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
      const layoutSessionBlock = await getLayoutSessionBlock(uiState, repo.activeLayoutSessionId)
      try {
        await retargetPanelBlockIds(repo, layoutSessionBlock, attemptedOn, conflictingBlockId)
      } catch (error) {
        console.error('[AliasCollisionToast] Failed to retarget panels after merge', error)
        showError('Merge completed, but panel update failed')
      }
      dismissToast(toastId)
    } catch (error) {
      if (error instanceof MergeIntoDescendantError) {
        // The existing block is nested inside the page being renamed, so
        // this merge direction can never succeed. Don't re-offer the
        // doomed retry — explain the situation and leave "Open" so the
        // user can move the content manually.
        setMergeBlocked(true)
        setPending(false)
        const targetLabel = conflictingBlockTitle.trim() === ''
          ? alias
          : conflictingBlockTitle.trim()
        showError(
          `Can't merge into "${truncate(targetLabel, 30)}" — it's nested inside ` +
          `the page you're renaming. Open it to move the content manually.`,
        )
        return
      }
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
        {offerMerge && !mergeBlocked && (
          <Button variant="default" size="sm" disabled={pending} onClick={() => { void mergeIntoExisting() }}>
            {pending ? 'Merging…' : mergeLabel}
          </Button>
        )}
      </div>
    </div>
  )
}
