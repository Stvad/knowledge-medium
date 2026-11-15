import { Block } from '../data/block'
import { useRenderer } from '../hooks/useRendererRegistry.tsx'
import { useBlockContext } from '@/context/block.js'
import { PropertyRowListingContext } from '@/context/propertyDisplay.js'
import { useRepo } from '@/context/repo.js'
import { Suspense, useState } from 'react'
import { BlockLoadingPlaceholder } from '@/components/BlockLoadingPlaceholder.js'
import { FallbackComponent } from '@/components/util/error.js'
import { ErrorBoundary } from 'react-error-boundary'
import { useChildIdsForMode, useHandle, usePropertyDisplayMode } from '@/hooks/block.js'
import type { BlockData } from '@/data/api'
import type { Repo } from '@/data/repo.js'
import { unlistedSiblingIndex } from '@/utils/selection.js'
import { useFocusWithin, useFocusedChild } from '@/hooks/focusedChild'
import { LazyBlockComponent } from './LazyBlockComponent.tsx'

interface BlockComponentProps {
  blockId: string;
}

export function BlockComponent({blockId}: BlockComponentProps) {
  const repo = useRepo()
  const block = repo.block(blockId)
  const context = useBlockContext()
  const Renderer = useRenderer({block, context})

  return <ErrorBoundary FallbackComponent={FallbackComponent}>
    {/* Block-shaped placeholder keeps the layout frame stable whenever
        anything in the renderer chain suspends, matching the shape
        `LazyViewportMount` shows for not-yet-mounted blocks. */}
    <Suspense fallback={<BlockLoadingPlaceholder/>}>
      {/* Renderer is selected from the runtime registry, not constructed
          here — its identity is stable across renders for a given key.
          The static-components rule can't see through the lookup. */}
      {/* eslint-disable-next-line react-hooks/static-components */}
      <Renderer block={block} context={context}/>
    </Suspense>
  </ErrorBoundary>
}

/**
 * An interesting idea here is to keep building the context as we go deeper,
 * so push all the properties from the parent to the context - overrides would automatically happen in the hierarchy
 * we can also add things like "youtube parent" and such
 *
 * two concerns:
 * - memory usage
 * - this diverges the behavior in ui vs pure block operation, given the block in isolation, we won't have the context
 *
 * youtube context seems more immediately meaningful/actionable
 */
export const BlockChildren = ({block}: { block: Block }) => {
  // LazyBlockComponent renders an empty placeholder until the block is
  // about to enter the viewport, then mounts the real BlockComponent.
  // For trees of thousands of blocks this drops initial-mount cost from
  // O(N) to O(visible-window) without flattening the tree.
  //
  // The scope is read ONCE here and passed down rather than each child reading
  // context for itself: a deferred row publishes it (see `LazyViewportMount`),
  // and a `useContext` per placeholder would make every context change re-render
  // thousands of them — the per-block subscription fan-out the spatial-nav
  // shell decorator documents as the pitfall to avoid. Children render in this
  // context, so its scope is the one they will have.
  const {renderScopeId} = useBlockContext()
  const mode = usePropertyDisplayMode(block)
  const focusedChild = useFocusedChild(block, renderScopeId)
  const focusWithin = useFocusWithin(block, renderScopeId)
  const listed = useChildIdsForMode(block, mode)
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
  let childIds = withFocusedChild(block.repo, listed, focusedChild)
  for (const row of retainedRows) childIds = withFocusedChild(block.repo, childIds, row)

  return <PropertyRowListingContext value={mode !== 'none' || hasUnlistedChild ? block.id : null}>
    {childIds.map((childId) => (
      <LazyBlockComponent
        key={childId}
        blockId={childId}
        renderScopeId={renderScopeId}
      />
    ))}
  </PropertyRowListingContext>
}

/** `childIds` with the focused child at its sibling position when the property
 *  display mode left it out: the row the user is on is never unmounted under
 *  them, whatever tier it turns into while they edit it. */
const withFocusedChild = (repo: Repo, childIds: string[], focused: BlockData | null): string[] => {
  if (!focused || childIds.includes(focused.id)) return childIds
  const at = unlistedSiblingIndex(repo, childIds, focused)
  return [...childIds.slice(0, at), focused.id, ...childIds.slice(at)]
}
