/**
 * Receipts for core actions. Core cannot import this plugin, so the
 * describers for its actions live here.
 */
import { recordedReceipt, type ReceiptDescriber } from './facet.ts'

/** A delete whose subtree took folded children with it. A leaf delete is
 *  visible where it happened and gets nothing. A multi-select delete
 *  records one entry per block; the receipt names the last, which is the
 *  one its Undo (and cmd-Z) reverts. */
const describeDelete: ReceiptDescriber['describe'] = ({entry, summary}) => {
  const receipt = recordedReceipt(entry, summary, 'delete', 'action:delete')
  return receipt !== null && summary !== null && summary.others > 0 ? receipt : null
}

export const deleteBlockReceipt: ReceiptDescriber = {actionId: 'delete_block', describe: describeDelete}
export const multiSelectDeleteReceipt: ReceiptDescriber = {actionId: 'multi_select.delete_block', describe: describeDelete}
