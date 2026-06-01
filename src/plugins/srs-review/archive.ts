import type { Block } from '@/data/block'
import { getBlockTypes } from '@/data/properties.js'
import { SRS_SM25_TYPE, srsArchivedProp } from '@/plugins/srs-rescheduling'

/** Mark an SRS card archived. Archived cards drop out of the due-cards
 *  query (`buildDueCardsQuery` excludes `archived: true`), so this is
 *  how a card leaves review for good. No-op on non-SRS or read-only
 *  blocks. Returns whether the write happened. */
export const archiveSrsCard = async (block: Block): Promise<boolean> => {
  if (block.repo.isReadOnly) return false
  const data = block.peek() ?? (await block.load())
  if (!data || !getBlockTypes(data).includes(SRS_SM25_TYPE)) return false
  await block.set(srsArchivedProp, true)
  return true
}
