import { Block } from '../data/block'
import { useRenderer } from '../hooks/useRendererRegistry.tsx'
import { useBlockContext } from '@/context/block.js'
import { PropertyRowListingContext } from '@/context/propertyDisplay.js'
import { useRepo } from '@/context/repo.js'
import { Suspense } from 'react'
import { BlockLoadingPlaceholder } from '@/components/BlockLoadingPlaceholder.js'
import { FallbackComponent } from '@/components/util/error.js'
import { ErrorBoundary } from 'react-error-boundary'
import { useChildIdsForMode, useHandle, usePropertyDisplayMode } from '@/hooks/block.js'
import type { BlockData } from '@/data/api'
import { unlistedSiblingIndex } from '@/utils/selection.js'
import { useFocusedChild } from '@/hooks/focusedChild'
import { OutlinePropertyDrafts, useOutlinePropertyListing } from './propertyPanel/OutlinePropertyDrafts'
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
  const transient = useOutlinePropertyListing(block)
  const listed = useChildIdsForMode(block, mode)
  const placesUnlistedChild = focusedChild !== null && !listed.includes(focusedChild.id)
  // Temporary rows need the full child list: a move can change their parent
  // or sibling position without changing the mode's filtered listing.
  const hasTemporaryRows = placesUnlistedChild || transient.revealed.length > 0
  useHandle(block.repo.query.childIds({id: block.id, hydrate: true, propertyChildren: hasTemporaryRows ? 'all' : mode}),
    {selector: ids => ids})
  let childIds = withUnlistedChild(block, listed, focusedChild)
  for (const id of transient.revealed) childIds = withUnlistedChild(block, childIds, block.repo.block(id).peek() ?? null)

  return <PropertyRowListingContext value={mode !== 'none' || placesUnlistedChild || transient.revealed.length ? block.id : null}>
    <OutlinePropertyDrafts owner={block} mode={mode} children={childIds.map(childId => ({
      id: childId,
      element: <LazyBlockComponent key={childId} blockId={childId} renderScopeId={renderScopeId}/>,
    }))}/>
  </PropertyRowListingContext>
}

/** Place a focused or revealed row at its sibling position only while it
 *  remains a direct child of this listing. */
const withUnlistedChild = (parent: Block, childIds: string[], child: BlockData | null): string[] => {
  if (!child || child.parentId !== parent.id || childIds.includes(child.id)) return childIds
  const at = unlistedSiblingIndex(parent.repo, childIds, child)
  return [...childIds.slice(0, at), child.id, ...childIds.slice(at)]
}
