/**
 * Receipts for core actions. Core cannot import this plugin, so the
 * describers for its actions live here; a plugin describes its own
 * actions next to them (move-blocks does).
 */
import { ActionContextTypes } from '@/shortcuts/types.js'
import { subjectOf, type Receipt, type ReceiptDescriber } from './facet.ts'

/** A delete whose subtree took folded children with it. A leaf delete is
 *  visible where it happened and gets nothing. */
export const deleteBlockReceipt: ReceiptDescriber = {
  actionId: 'delete_block',
  context: ActionContextTypes.NORMAL_MODE,
  describe: ({entry, summary, phrase}) => {
    if (entry === null || summary === null || phrase === null) return null
    const subject = subjectOf(summary, 'forward')
    if (subject === undefined || subject.kind !== 'delete' || summary.others === 0) return null
    return {
      key: 'action:delete',
      verb: phrase.verb,
      subject,
      riders: phrase.riders,
      revert: {direction: 'undo', entry, workspaceId: subject.workspaceId},
    }
  },
}

/** A multi-select delete fans out into one tx per selected block, so the
 *  count of what left is the receipt; Undo steps back one, like cmd-Z. */
export const multiSelectDeleteReceipt: ReceiptDescriber = {
  actionId: 'multi_select.delete_block',
  describe: ({entry, summary, phrase, recorded}) => {
    if (entry === null || summary === null || phrase === null) return null
    const subject = subjectOf(summary, 'forward')
    if (subject === undefined || subject.kind !== 'delete') return null
    if (recorded <= 1 && summary.others === 0) return null
    const riders = [
      recorded > 1 ? `and ${recorded - 1} more` : '',
      summary.others > 0 ? phrase.riders : '',
    ].filter(Boolean).join(', ')
    const receipt: Receipt = {
      key: 'action:delete',
      verb: phrase.verb,
      subject,
      riders,
      revert: {direction: 'undo', entry, workspaceId: subject.workspaceId},
    }
    return receipt
  },
}
