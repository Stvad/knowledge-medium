import type { Block } from '@/data/block.js'
import type { Repo } from '@/data/repo.js'
import { showPropertiesProp } from '@/data/properties.js'
import { requestPropertyCreate } from '@/utils/propertyNavigation.js'

export const convertEmptyChildBlockToProperty = async (
  block: Block,
  repo: Repo,
): Promise<boolean> => {
  if (repo.isReadOnly) return false

  const data = block.peek() ?? await block.load()
  const parentId = data?.parentId
  if (!data || !parentId) return false

  // The CodeMirror caller checks the live document is empty before this
  // runs. Persisted content can lag behind the editor debounce, so do not
  // use BlockData.content as the emptiness gate here.
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
  if (childIds.length > 0) return false

  // The cell is the other shape property data takes — and the only one in a
  // non-flipped workspace (a child-backed one keeps the cell in sync via
  // PROJECT), so guarding it protects the block in both.
  if (Object.keys(data.properties).length > 0) return false

  const parent = repo.block(parentId)
  await parent.set(showPropertiesProp, true)
  requestPropertyCreate({blockId: parentId})
  await block.delete()
  return true
}
