/**
 * The receipt for "Move block(s) to…". A moved block leaves the viewport
 * by definition, so the receipt names it, shows the destination, and offers
 * Undo and Go to. Built from the flow's own result rather than a dispatch
 * describer: the flow awaits a dialog, and a describer would attribute
 * whatever landed on the undo stack meanwhile to the move.
 */
import type { Repo } from '@/data/repo'
import { subjectOf, summarizeEntry, topEntry, type Receipt } from '@/plugins/action-receipts'

export const moveReceipt = (
  repo: Repo,
  workspaceId: string,
  movedIds: readonly string[],
  destinationId: string,
): Receipt | null => {
  const entry = topEntry(repo, workspaceId)
  if (entry === null) return null
  // Every root moves in one undo group, so the group's entry is the move.
  const subject = subjectOf(summarizeEntry(entry), 'forward')
  if (subject === undefined || subject.kind !== 'move') return null
  return {
    key: 'action:move',
    verb: 'Moved',
    subject,
    riders: movedIds.length > 1 ? `and ${movedIds.length - 1} more` : undefined,
    location: {id: destinationId, workspaceId},
    revert: {direction: 'undo', entry, workspaceId},
  }
}
