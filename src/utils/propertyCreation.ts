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
  const childIds = await block.childIds.load()
  if (childIds.length > 0) return false

  // A block that owns property data isn't empty — converting it `delete()`s
  // the block and loses that data. `childIds` above is the VISIBLE facade,
  // which deliberately hides property field/value rows, so it can't be the
  // guard for this. Check the properties cell directly: it's flip-independent
  // (a non-flipped workspace holds the properties in the cell; a child-backed
  // one keeps the cell in sync via PROJECT), so it protects the block — and any
  // hidden field/value rows or value-row comments under it — in both.
  if (Object.keys(data.properties).length > 0) return false

  const parent = repo.block(parentId)
  await parent.set(showPropertiesProp, true)
  requestPropertyCreate({blockId: parentId})
  await block.delete()
  return true
}
