import { useCallback, useMemo, useState } from 'react'
import { Filter } from 'lucide-react'
import { Block } from '../../data/block'
import { BlockRendererProps } from '@/types.ts'
import { BlockLoadingPlaceholder } from '@/components/BlockLoadingPlaceholder.tsx'
import { BlockComponent } from '@/components/BlockComponent.tsx'
import { BreadcrumbList } from '@/components/BreadcrumbList.tsx'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { LazyViewportMount } from '@/components/util/LazyViewportMount.tsx'
import type { LazyViewportPlaceholderProps } from '@/components/util/LazyViewportMount.tsx'
import { useData, useParents } from '@/hooks/block.ts'
import { useRepo } from '@/context/repo.tsx'
import { useBacklinks } from './useBacklinks.ts'
import { BacklinkFilters } from './BacklinkFilters.tsx'
import {
  hasBacklinksFilter,
  normalizeBacklinksFilter,
  type BacklinksFilter,
} from './query.ts'
import {
  loadBacklinkFilter,
  saveBacklinkFilter,
} from './filterStorage.ts'

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

const LazyBacklinkItem = ({block}: { block: Block }) => {
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

export function LinkedReferences({block}: BlockRendererProps) {
  const repo = useRepo()
  const data = useData(block)
  const workspaceId = data?.workspaceId ?? repo.activeWorkspaceId ?? ''

  return (
    <LinkedReferencesInner
      key={`${workspaceId}:${block.id}`}
      block={block}
      workspaceId={workspaceId}
    />
  )
}

function LinkedReferencesInner({
  block,
  workspaceId,
}: {
  block: Block
  workspaceId: string
}) {
  const [filter, setFilterState] = useState<BacklinksFilter>(() =>
    workspaceId ? loadBacklinkFilter(workspaceId, block.id) : {},
  )
  const filterActive = hasBacklinksFilter(filter)
  const unfilteredBacklinks = useBacklinks(block)
  const filteredBacklinks = useBacklinks(block, filterActive ? filter : undefined)
  const backlinks = filterActive ? filteredBacklinks : unfilteredBacklinks
  const [open, setOpen] = useState(true)
  const [filtersOpen, setFiltersOpen] = useState(filterActive)

  const setFilter = useCallback((next: BacklinksFilter) => {
    const normalized = normalizeBacklinksFilter(next)
    setFilterState(normalized)
    if (hasBacklinksFilter(normalized)) setFiltersOpen(true)
    if (workspaceId) saveBacklinkFilter(workspaceId, block.id, normalized)
  }, [block.id, workspaceId])

  if (unfilteredBacklinks.length === 0) return null

  const countLabel = filterActive
    ? `${backlinks.length} / ${unfilteredBacklinks.length}`
    : String(backlinks.length)

  return (
    <div className="mt-8 pt-4 border-t border-border">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen(prev => !prev)}
          className="flex min-w-0 items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          <span className="text-base leading-none">{open ? '▾' : '▸'}</span>
          <span>Linked References</span>
          <span className="text-xs text-muted-foreground/70">{countLabel}</span>
        </button>
        <button
          type="button"
          onClick={() => setFiltersOpen(prev => !prev)}
          className={`rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
            filterActive ? 'bg-accent text-foreground' : ''
          }`}
          title="Filters"
          aria-label="Filters"
          aria-pressed={filtersOpen}
        >
          <Filter className="h-4 w-4" />
        </button>
      </div>

      {open && (
        <>
          {filtersOpen && workspaceId && (
            <BacklinkFilters
              workspaceId={workspaceId}
              filter={filter}
              onChange={setFilter}
            />
          )}
          {backlinks.length === 0 ? (
            <div className="mt-3 text-xs text-muted-foreground">
              No matching references.
            </div>
          ) : (
            <div className="mt-3 flex flex-col gap-3">
              {backlinks.map(backlinkBlock => (
                <LazyBacklinkItem key={backlinkBlock.id} block={backlinkBlock}/>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
