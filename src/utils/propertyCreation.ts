import type { Block } from '@/data/block.js'
import type { BlockData } from '@/data/api'
import type { Repo } from '@/data/repo.js'
import { showPropertiesProp } from '@/data/properties.js'
import { requestPropertyCreate } from '@/utils/propertyNavigation.js'

/** Eligibility half of `convertEmptyChildBlockToProperty`, resolving to the
 *  block's data when the conversion may proceed and `null` when it must not.
 *
 *  Split out because the CodeMirror trigger has to REFUSE before it dispatches:
 *  the `::` gesture leaves its first colon in the live doc, and clearing that is
 *  a dispatch the editor's debounced commit persists on its own — a refusal
 *  discovered afterwards could not take it back. The conversion re-runs this
 *  against its own read, so the decision has one definition, not two. */
export const canConvertEmptyChildBlockToProperty = async (
  block: Block,
  repo: Repo,
): Promise<BlockData | null> => {
  if (repo.isReadOnly) return null

  const data = block.peek() ?? await block.load()
  if (!data?.parentId) return null

  // The CodeMirror caller owns the "the user hasn't typed anything real"
  // check against its LIVE document (which at trigger time still holds the
  // `::` gesture's first colon). Persisted content lags the editor debounce
  // either way, so do not use BlockData.content as the emptiness gate here.
  //
  // Load the STRUCTURAL child list (property field/value rows INCLUDED), not
  // the visible `block.childIds` facade (§9 excludes field rows). A block that
  // owns property data isn't empty — converting it `delete()`s the block and
  // strands/soft-deletes that data, incl. value-row comments. A child-backed
  // workspace can leave a block with hidden field/value rows but an EMPTY
  // projected cell: a forced find-replace or a direct value-row edit whose
  // content stops decoding makes PROJECT drop the cell key while the rows stay
  // live, so the visible facade AND the `properties` cell can BOTH look empty
  // while real data hangs off the block. The structural list is what sees it.
  const childIds = await repo.query.childIds({id: block.id, hidePropertyChildren: false}).load()
  if (childIds.length > 0) return null

  // The cell is the other shape property data takes — and the only one in a
  // non-flipped workspace (a child-backed one keeps the cell in sync via
  // PROJECT), so guarding it protects the block in both.
  if (Object.keys(data.properties).length > 0) return null

  return data
}

export const convertEmptyChildBlockToProperty = async (
  block: Block,
  repo: Repo,
): Promise<boolean> => {
  const data = await canConvertEmptyChildBlockToProperty(block, repo)
  const parentId = data?.parentId
  if (!parentId) return false

  const parent = repo.block(parentId)
  await parent.set(showPropertiesProp, true)
  requestPropertyCreate({blockId: parentId})
  // Reaping an empty scaffold block the user never saw — not a user-initiated
  // delete of their content, so the UI deletion guards don't apply.
  // eslint-disable-next-line no-restricted-syntax -- programmatic delete: scaffold cleanup
  await block.delete()
  return true
}
