/**
 * The receipt for "Move block(s) to…". A moved block leaves the viewport
 * by definition, so the receipt names it, shows the destination, and offers
 * Undo and Go to. Both action variants (single block, multi-select) move
 * their roots as one undo group, so one entry carries every root.
 */
import { locationOf, subjectOf, type ReceiptDescriber } from '@/plugins/action-receipts/facet.ts'
import { MOVE_BLOCKS_ACTION_ID, MULTI_SELECT_MOVE_BLOCKS_ACTION_ID } from './moveAction.ts'

const describeMove: ReceiptDescriber['describe'] = ({entry, summary, phrase}) => {
  if (entry === null || summary === null || phrase === null) return null
  const subject = subjectOf(summary, 'forward')
  if (subject === undefined || subject.kind !== 'move') return null
  return {
    key: 'action:move',
    verb: phrase.verb,
    subject,
    riders: phrase.riders,
    location: locationOf(summary, 'forward'),
    revert: {direction: 'undo', entry, workspaceId: subject.workspaceId},
  }
}

export const moveBlockReceipt: ReceiptDescriber = {actionId: MOVE_BLOCKS_ACTION_ID, describe: describeMove}
export const moveBlocksReceipt: ReceiptDescriber = {actionId: MULTI_SELECT_MOVE_BLOCKS_ACTION_ID, describe: describeMove}
