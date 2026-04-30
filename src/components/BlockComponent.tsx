import { Block } from '@/data/internals/block'
import { useRenderer } from '../hooks/useRendererRegistry.tsx'
import { useBlockContext } from '@/context/block.tsx'
import { useRepo } from '@/context/repo.tsx'
import { Suspense } from 'react'
import { SuspenseFallback } from '@/components/util/suspense.tsx'
import { FallbackComponent } from '@/components/util/error.tsx'
import { ErrorBoundary } from 'react-error-boundary'
import { useChildIds } from '@/hooks/block.ts'

interface BlockComponentProps {
  blockId: string;
}

export function BlockComponent({blockId}: BlockComponentProps) {
  const repo = useRepo()
  const block = repo.block(blockId)
  const context = useBlockContext()
  const Renderer = useRenderer({block, context})

  return <ErrorBoundary FallbackComponent={FallbackComponent}>
    <Suspense fallback={<SuspenseFallback/>}>
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
  return <>
    {useChildIds(block).map((childId) => (
      <BlockComponent
        key={childId}
        blockId={childId}
      />
    ))}
  </>
}
