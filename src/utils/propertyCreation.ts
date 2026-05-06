import type { Block } from '@/data/block.ts'
import type { Repo } from '@/data/repo.ts'
import { showPropertiesProp } from '@/data/properties.ts'
import { requestPropertyCreate } from '@/utils/propertyNavigation.ts'

export const convertEmptyChildBlockToProperty = async (
  block: Block,
  repo: Repo,
): Promise<boolean> => {
  if (repo.isReadOnly) return false

  const data = block.peek() ?? await block.load()
  const parentId = data?.parentId
  if (!parentId) return false

  // The CodeMirror caller checks the live document is empty before this
  // runs. Persisted content can lag behind the editor debounce, so do not
  // use BlockData.content as the emptiness gate here.
  const childIds = await block.childIds.load()
  if (childIds.length > 0) return false

  const parent = repo.block(parentId)
  await parent.set(showPropertiesProp, true)
  requestPropertyCreate({blockId: parentId})
  await block.delete()
  return true
}
