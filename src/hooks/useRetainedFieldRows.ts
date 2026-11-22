import type {Block} from '@/data/block'
import type {BlockData} from '@/data/api'
import {useChildIdsForMode, useHandle, usePropertyDisplayMode} from '@/hooks/block.js'
import {useFocusPlacedChildIds, useFocusWithin, withFocusedChild} from './focusedChild'
import {useState} from 'react'

export const useRetainedFieldRows = (block: Block, renderScopeId: unknown) => {
  const mode = usePropertyDisplayMode(block)
  const queried = useChildIdsForMode(block, mode)
  const {focusedChild, listed, childIds: placed} = useFocusPlacedChildIds(block, renderScopeId, queried)
  const focusWithin = useFocusWithin(block, renderScopeId)
  const placesUnlistedChild = focusedChild !== null && !listed.includes(focusedChild.id)
  const [retainedFieldIds, setRetainedFieldIds] = useState<string[]>([])
  const observesAllChildren = placesUnlistedChild || retainedFieldIds.length > 0 || focusedChild?.isFieldForm === true
  // A row placed outside the listing sits by every sibling's order, which a
  // move can change without changing the listing: watch the full child list
  // while there is one (otherwise this is the listing's own handle again).
  const allChildIds = useHandle(block.repo.query.childIds({id: block.id, hydrate: true, propertyChildren: observesAllChildren ? 'all' : mode}),
    {selector: ids => ids})
  const retainedRows = retainedFieldIds.map(id => block.repo.block(id).peek()).filter((row): row is BlockData =>
    row?.parentId === block.id && row.isFieldForm === true && !row.deleted &&
      (allChildIds === undefined || allChildIds.includes(row.id)))
  const nextRetainedIds = focusWithin === false ? [] : [...new Set([
    ...retainedRows.map(row => row.id),
    ...(focusedChild?.isFieldForm ? [focusedChild.id] : []),
  ])]
  if (nextRetainedIds.length !== retainedFieldIds.length || nextRetainedIds.some((id, index) => id !== retainedFieldIds[index])) {
    setRetainedFieldIds(nextRetainedIds)
  }
  const hasUnlistedChild = placesUnlistedChild || retainedRows.some(row => !listed.includes(row.id))
  let childIds = placed
  for (const row of retainedRows) childIds = withFocusedChild(block.repo, childIds, row)
  return {childIds, hasUnlistedChild, mode}
}
