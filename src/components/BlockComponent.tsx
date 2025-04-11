import { Block, useData } from '../data/block'
import { useRenderer } from '../hooks/useRendererRegistry.tsx'
import { useBlockContext } from '@/context/block.tsx'
import { useRepo } from '@/context/repo.tsx'
import { Suspense } from 'react'
import { SuspenseFallback } from '@/components/util/suspense.tsx'
import { FallbackComponent } from '@/components/util/error.tsx'
import { ErrorBoundary } from 'react-error-boundary'

interface BlockComponentProps {
  blockId: string;
}

export function BlockComponent({blockId}: BlockComponentProps) {
  const repo = useRepo()
  const block = repo.find(blockId)
  const context = useBlockContext()
  const Renderer = useRenderer({block, context})

  return <ErrorBoundary FallbackComponent={FallbackComponent}>
    <Suspense fallback={<SuspenseFallback/>}>
      <Renderer block={block} context={context}/>
    </Suspense>
  </ErrorBoundary>
}

export const BlockChildren = ({block}: { block: Block }) => {
  return <>
    {useData(block)?.childIds.map((childId) => (
      <BlockComponent
        key={childId}
        blockId={childId}
      />
    ))}
  </>
}
