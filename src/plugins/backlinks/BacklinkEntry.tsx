import { useCallback, useMemo, useState } from 'react'
import { Block } from '@/data/block'
import { BlockLoadingPlaceholder } from '@/components/BlockLoadingPlaceholder.tsx'
import { BlockComponent } from '@/components/BlockComponent.tsx'
import { BreadcrumbList } from '@/components/BreadcrumbList.tsx'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { LazyViewportMount } from '@/components/util/LazyViewportMount.tsx'
import type { LazyViewportPlaceholderProps } from '@/components/util/LazyViewportMount.tsx'
import { useParents } from '@/hooks/block.ts'
import { useRepo } from '@/context/repo.tsx'

const NESTED_OVERRIDES = {topLevel: false, isBacklink: true}
const BREADCRUMB_OVERRIDES = {...NESTED_OVERRIDES, isBreadcrumb: true}
const BACKLINK_ESTIMATED_HEIGHT_PX = 96
const BACKLINK_OVERSCAN_PX = 600
const BACKLINK_BLOCK_PLACEHOLDER_HEIGHT_PX = 32

interface BreadcrumbsProps {
  shownBlock: Block
  onSelect: (parent: Block) => void
}

// Roam-style: breadcrumbs are the chain ABOVE the currently-shown block.
// Click a segment to "unfurl" — promote it to the shown block. The
// breadcrumb chain truncates accordingly and the body re-renders the
// chosen parent's subtree (which still contains the original backlink as
// a descendant).
const BacklinkBreadcrumbs = ({shownBlock, onSelect}: BreadcrumbsProps) => {
  const repo = useRepo()
  const workspaceId = repo.activeWorkspaceId
  const parents = useParents(shownBlock)

  if (!workspaceId) return null

  return (
    <BreadcrumbList
      parents={parents}
      workspaceId={workspaceId}
      overrides={BREADCRUMB_OVERRIDES}
      onSelect={onSelect}
      className="flex items-center gap-1 text-xs text-muted-foreground/80 mb-1 flex-wrap"
      itemClassName="no-underline cursor-pointer truncate max-w-[24ch] hover:text-foreground"
      separatorClassName="mx-1 text-muted-foreground/40"
    />
  )
}

const BacklinkItem = ({block}: { block: Block }) => {
  const repo = useRepo()
  const [shownBlockId, setShownBlockId] = useState(block.id)
  const shownBlock = useMemo(() => repo.block(shownBlockId), [repo, shownBlockId])

  const handleSelect = useCallback((parent: Block) => {
    setShownBlockId(parent.id)
  }, [])

  return (
    <div className="border-l-2 border-muted pl-3 py-2">
      <BacklinkBreadcrumbs shownBlock={shownBlock} onSelect={handleSelect}/>
      <NestedBlockContextProvider overrides={NESTED_OVERRIDES}>
        <BlockComponent blockId={shownBlockId}/>
      </NestedBlockContextProvider>
    </div>
  )
}

const BacklinkItemPlaceholder = ({
  reservedHeight,
}: LazyViewportPlaceholderProps) => {
  return (
    <div
      className="border-l-2 border-muted pl-3 py-2"
      style={{minHeight: reservedHeight}}
      aria-hidden
    >
      <div className="mb-1 h-4 w-40 max-w-full rounded-sm bg-muted/60" />
      <BlockLoadingPlaceholder reservedHeight={BACKLINK_BLOCK_PLACEHOLDER_HEIGHT_PX} />
    </div>
  )
}

export const LazyBacklinkItem = ({block}: { block: Block }) => {
  return (
    <LazyViewportMount
      cacheKey={`backlink:${block.id}`}
      estimatedHeightPx={BACKLINK_ESTIMATED_HEIGHT_PX}
      overscanPx={BACKLINK_OVERSCAN_PX}
      renderPlaceholder={(props) => <BacklinkItemPlaceholder {...props} />}
    >
      <BacklinkItem block={block}/>
    </LazyViewportMount>
  )
}
