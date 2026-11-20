import type {Block} from '@/data/block'
import type {BlockData} from '@/data/api'
import type {PropertyDisplayMode} from '@/data/propertyDisplayMode'
import type {Repo} from '@/data/repo.js'
import {useChildIdsForMode, useHandle, usePropertyDisplayMode} from '@/hooks/block.js'
import {useFocusedChild, useFocusWithin} from './focusedChild'
import {unlistedSiblingIndex} from '@/utils/selection.js'
import {useState} from 'react'

interface FieldRetention {
  mode: PropertyDisplayMode
  focusedFieldId: string | null
  ids: string[]
}

export const useRetainedFieldRows = (block: Block, renderScopeId: unknown) => {
  const mode = usePropertyDisplayMode(block)
  const focusedChild = useFocusedChild(block, renderScopeId)
  const focusWithin = useFocusWithin(block, renderScopeId)
  const listed = useChildIdsForMode(block, mode)
  const placesUnlistedChild = focusedChild !== null && !listed.includes(focusedChild.id)
  const [retention, setRetention] = useState<FieldRetention>({mode, focusedFieldId: null, ids: []})
  const focusedFieldId = focusedChild?.isFieldForm ? focusedChild.id : null
  // Retention belongs to the view that admitted the field. Across a mode
  // switch, the current child stays mounted by focus until the user moves off it.
  const retainedFieldIds = retention.mode === mode && focusWithin !== false ? retention.ids : []
  const observesAllChildren = placesUnlistedChild || retainedFieldIds.length > 0 || focusedFieldId !== null
  // A row placed outside the listing sits by every sibling's order, which a
  // move can change without changing the listing: watch the full child list
  // while there is one (otherwise this is the listing's own handle again).
  const allChildIds = useHandle(block.repo.query.childIds({id: block.id, hydrate: true, propertyChildren: observesAllChildren ? 'all' : mode}),
    {selector: ids => ids})
  const retainedRows = retainedFieldIds.map(id => block.repo.block(id).peek()).filter((row): row is BlockData =>
    row?.parentId === block.id && row.isFieldForm === true && !row.deleted &&
      (allChildIds === undefined || allChildIds.includes(row.id)))
  const nextRetainedIds = retainedRows.map(row => row.id)
  if (focusedFieldId !== null && focusedFieldId !== retention.focusedFieldId && !nextRetainedIds.includes(focusedFieldId)) {
    nextRetainedIds.push(focusedFieldId)
  }
  if (focusedFieldId !== retention.focusedFieldId || nextRetainedIds.length !== retention.ids.length) {
    setRetention({mode, focusedFieldId, ids: nextRetainedIds})
  }
  const hasUnlistedChild = placesUnlistedChild || retainedRows.some(row => !listed.includes(row.id))
  let childIds = withFocusedChild(block.repo, listed, focusedChild)
  for (const row of retainedRows) childIds = withFocusedChild(block.repo, childIds, row)
  return {childIds, hasUnlistedChild, mode}
}

/** `childIds` with the focused child at its sibling position when the property
 *  display mode left it out: the row the user is on is never unmounted under
 *  them, whatever tier it turns into while they edit it. */
const withFocusedChild = (repo: Repo, childIds: string[], focused: BlockData | null): string[] => {
  if (!focused || childIds.includes(focused.id)) return childIds
  const at = unlistedSiblingIndex(repo, childIds, focused)
  return [...childIds.slice(0, at), focused.id, ...childIds.slice(at)]
}
