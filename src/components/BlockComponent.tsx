import { Block } from '../data/block'
import { useRenderer } from '../hooks/useRendererRegistry.tsx'
import { useBlockContext } from '@/context/block.js'
import { useRepo } from '@/context/repo.js'
import { Suspense, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { BlockLoadingPlaceholder } from '@/components/BlockLoadingPlaceholder.js'
import { FallbackComponent } from '@/components/util/error.js'
import { ErrorBoundary } from 'react-error-boundary'
import { useChildIds } from '@/hooks/block.js'
import { LazyBlockComponent } from './LazyBlockComponent.tsx'
import { Button } from './ui/button.tsx'

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
  const [showHiddenPropertyChildren, setShowHiddenPropertyChildren] = useState(false)
  const visibleChildIds = useChildIds(block)
  const allChildIds = useChildIds(block, {includeHiddenPropertyChildren: true})
  const hiddenCount = Math.max(0, allChildIds.length - visibleChildIds.length)
  const isShowingHiddenPropertyChildren = showHiddenPropertyChildren && hiddenCount > 0
  const childIds = isShowingHiddenPropertyChildren ? allChildIds : visibleChildIds

  // LazyBlockComponent renders an empty placeholder until the block is
  // about to enter the viewport, then mounts the real BlockComponent.
  // For trees of thousands of blocks this drops initial-mount cost from
  // O(N) to O(visible-window) without flattening the tree.
  return <>
    {hiddenCount > 0 && (
      <div className="ml-5 flex h-7 items-center">
        <Button
          variant="ghost"
          size="sm"
          type="button"
          className="h-6 w-fit gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground"
          data-block-interaction="ignore"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            setShowHiddenPropertyChildren(value => !value)
          }}
        >
          {isShowingHiddenPropertyChildren
            ? <EyeOff className="h-3.5 w-3.5" />
            : <Eye className="h-3.5 w-3.5" />}
          {isShowingHiddenPropertyChildren
            ? 'Hide hidden fields'
            : `Show hidden fields (${hiddenCount})`}
        </Button>
      </div>
    )}
    {childIds.map((childId) => (
      <LazyBlockComponent
        key={childId}
        blockId={childId}
      />
    ))}
  </>
}
