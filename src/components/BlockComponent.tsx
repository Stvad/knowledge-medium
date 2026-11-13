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
import { useUIStateBlock } from '@/data/globalState.js'
import { focusedBlockLocationFromProperties } from '@/data/properties.js'
import { siblingPrecedes } from '@/data/orderKey.js'
import type { Repo } from '@/data/repo.js'
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
  const focusedChildId = useFocusedChildId(block)
  const childIds = withFocusedChild(block.repo, useChildIdsForMode(block, mode), focusedChildId)

  return <PropertyRowListingContext value={mode !== 'none' ? block.id : null}>
    {childIds.map((childId) => (
      <LazyBlockComponent
        key={childId}
        blockId={childId}
        renderScopeId={renderScopeId}
      />
    ))}
  </PropertyRowListingContext>
}

/** The child of `parent` focused in this panel, or null. Per-parent, same
 *  selector pattern as `useInFocus`: a focus move re-renders only the parents
 *  it enters or leaves. The focused row's own parent is read reactively too,
 *  so moving it while focused (an indent) drops it from the parent it left. */
const useFocusedChildId = (parent: Block): string | null => {
  const candidate = useHandle(useUIStateBlock(), {
    selector: doc => {
      const location = focusedBlockLocationFromProperties(doc?.properties)
      if (!location) return null
      return parent.repo.block(location.blockId).peek()?.parentId === parent.id ? location.blockId : null
    },
  })
  const candidateParentId = useHandle(parent.repo.block(candidate ?? parent.id), {selector: data => data?.parentId})
  // Defence in depth: the selector above also re-checks on each re-render.
  return candidate !== null && candidateParentId === parent.id ? candidate : null
}

/** `childIds` with the focused child at its sibling position when the property
 *  display mode left it out: the row the user is on is never unmounted under
 *  them, whatever tier it turns into while they edit it. */
const withFocusedChild = (repo: Repo, childIds: string[], focusedId: string | null): string[] => {
  if (focusedId === null || childIds.includes(focusedId)) return childIds
  const focused = repo.block(focusedId).peek()
  if (!focused) return childIds
  const before = childIds.findIndex(id => {
    const sibling = repo.block(id).peek()
    return !!sibling && siblingPrecedes(focused, sibling)
  })
  return before === -1
    ? [...childIds, focusedId]
    : [...childIds.slice(0, before), focusedId, ...childIds.slice(before)]
}
