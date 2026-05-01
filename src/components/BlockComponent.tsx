import { Block } from '@/data/internals/block'
import { useRenderer } from '../hooks/useRendererRegistry.tsx'
import { useBlockContext } from '@/context/block.tsx'
import { useRepo } from '@/context/repo.tsx'
import { Suspense, useEffect } from 'react'
import { SuspenseFallback } from '@/components/util/suspense.tsx'
import { FallbackComponent } from '@/components/util/error.tsx'
import { ErrorBoundary } from 'react-error-boundary'
import { useChildIds } from '@/hooks/block.ts'
import { LazyBlockComponent } from './LazyBlockComponent.tsx'

interface BlockComponentProps {
  blockId: string;
}

interface BlockStatsBucket {
  mounts: number
  unmounts: number
  live: number
  // Track ids currently mounted so we can size the per-instance set.
  liveIds: Set<string>
}

const getBlockStats = (): BlockStatsBucket => {
  if (typeof window === 'undefined') {
    return {mounts: 0, unmounts: 0, live: 0, liveIds: new Set()}
  }
  const w = window as unknown as Record<string, unknown>
  let stats = w.__blockStats as BlockStatsBucket | undefined
  if (!stats) {
    stats = {mounts: 0, unmounts: 0, live: 0, liveIds: new Set()}
    w.__blockStats = stats
  }
  return stats
}

export function BlockComponent({blockId}: BlockComponentProps) {
  const repo = useRepo()
  const block = repo.block(blockId)
  const context = useBlockContext()
  const Renderer = useRenderer({block, context})

  useEffect(() => {
    if (!import.meta.env.DEV) return
    const stats = getBlockStats()
    stats.mounts += 1
    stats.live += 1
    stats.liveIds.add(blockId)
    return () => {
      stats.unmounts += 1
      stats.live -= 1
      stats.liveIds.delete(blockId)
    }
  }, [blockId])

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
  const {lazyChildren} = useBlockContext()
  const Component = lazyChildren ? LazyBlockComponent : BlockComponent
  return <>
    {useChildIds(block).map((childId) => (
      <Component
        key={childId}
        blockId={childId}
      />
    ))}
  </>
}
