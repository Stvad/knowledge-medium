import { useCallback, useMemo, useState } from 'react'
import { Block } from '@/data/block'
import { BlockLoadingPlaceholder } from '@/components/BlockLoadingPlaceholder.tsx'
import { BlockComponent } from '@/components/BlockComponent.tsx'
import { BreadcrumbList } from '@/plugins/breadcrumbs/BreadcrumbList.tsx'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { LazyViewportMount } from '@/components/util/LazyViewportMount.tsx'
import type { LazyViewportPlaceholderProps } from '@/components/util/LazyViewportMount.tsx'
import { useParents } from '@/hooks/block.ts'
import { useRepo } from '@/context/repo.tsx'

const NESTED_OVERRIDES = {layoutBoundary: false, isNestedSurface: true, isBacklink: true}
const BREADCRUMB_OVERRIDES = {...NESTED_OVERRIDES, isBreadcrumb: true}
const BACKLINK_ESTIMATED_HEIGHT_PX = 96
const BACKLINK_OVERSCAN_PX = 600
const BACKLINK_BLOCK_PLACEHOLDER_HEIGHT_PX = 32

const EMPTY_PARENTS: readonly Block[] = []

interface BreadcrumbListProps {
  parents: readonly Block[]
  workspaceId: string
  onSelect: (parent: Block) => void
}

const BacklinkBreadcrumbList = ({parents, workspaceId, onSelect}: BreadcrumbListProps) => (
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

// Roam-style: breadcrumbs are the chain ABOVE the currently-shown block.
// Click a segment to "unfurl" — promote it to the shown block. The
// breadcrumb chain truncates accordingly and the body re-renders the
// chosen parent's subtree (which still contains the original backlink
// as a descendant).
//
// Two render paths so we can avoid an `useParents` query per visible
// entry in the *initial* state: when the parent component has already
// prefetched ancestors via `useManyParents`, it passes them in as
// `initialParents` and `BacklinkInitialBreadcrumbs` renders without
// firing its own ancestor handle. After the user clicks a breadcrumb
// the shown block changes, the conditional flips, and
// `BacklinkDynamicBreadcrumbs` (which DOES use `useParents`) takes
// over for the new id. Conditional rendering is what gives us the
// query skip — React unmounts whichever branch we're not on.

const BacklinkInitialBreadcrumbs = ({
  parents,
  onSelect,
}: {
  parents: readonly Block[]
  onSelect: (parent: Block) => void
}) => {
  const repo = useRepo()
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) return null
  return <BacklinkBreadcrumbList parents={parents} workspaceId={workspaceId} onSelect={onSelect}/>
}

const BacklinkDynamicBreadcrumbs = ({
  shownBlock,
  onSelect,
}: {
  shownBlock: Block
  onSelect: (parent: Block) => void
}) => {
  const repo = useRepo()
  const workspaceId = repo.activeWorkspaceId
  const parents = useParents(shownBlock)
  if (!workspaceId) return null
  return <BacklinkBreadcrumbList parents={parents} workspaceId={workspaceId} onSelect={onSelect}/>
}

const BacklinkItem = ({
  block,
  initialParents = EMPTY_PARENTS,
}: {
  block: Block
  initialParents?: readonly Block[]
}) => {
  const repo = useRepo()
  const [shownBlockId, setShownBlockId] = useState(block.id)
  const shownBlock = useMemo(() => repo.block(shownBlockId), [repo, shownBlockId])
  const isInitial = shownBlockId === block.id

  const handleSelect = useCallback((parent: Block) => {
    setShownBlockId(parent.id)
  }, [])

  return (
    <div className="border-l-2 border-muted pl-3 py-2">
      {isInitial
        ? <BacklinkInitialBreadcrumbs parents={initialParents} onSelect={handleSelect}/>
        : <BacklinkDynamicBreadcrumbs shownBlock={shownBlock} onSelect={handleSelect}/>}
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

export const LazyBacklinkItem = ({
  block,
  initialParents,
}: {
  block: Block
  initialParents?: readonly Block[]
}) => {
  return (
    <LazyViewportMount
      cacheKey={`backlink:${block.id}`}
      estimatedHeightPx={BACKLINK_ESTIMATED_HEIGHT_PX}
      overscanPx={BACKLINK_OVERSCAN_PX}
      renderPlaceholder={(props) => <BacklinkItemPlaceholder {...props} />}
    >
      <BacklinkItem block={block} initialParents={initialParents}/>
    </LazyViewportMount>
  )
}
