import { useCallback, useState } from 'react'
import { Filter } from 'lucide-react'
import { Block } from '../../data/block'
import { BlockRendererProps } from '@/types.ts'
import { useData } from '@/hooks/block.ts'
import { useRepo } from '@/context/repo.tsx'
import { useBacklinks } from './useBacklinks.ts'
import { BacklinkFilters } from './BacklinkFilters.tsx'
import {
  hasBacklinksFilter,
  type BacklinksFilter,
} from './query.ts'
import { useStoredBacklinkFilter } from './useStoredBacklinkFilter.ts'
import { LazyBacklinkItem } from './BacklinkEntry.tsx'

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
  const [filter, setStoredFilter] = useStoredBacklinkFilter(block)
  const filterActive = hasBacklinksFilter(filter)
  const unfilteredBacklinks = useBacklinks(block)
  const filteredBacklinks = useBacklinks(block, filterActive ? filter : undefined)
  const backlinks = filterActive ? filteredBacklinks : unfilteredBacklinks
  const [open, setOpen] = useState(true)
  const [filtersOpen, setFiltersOpen] = useState(filterActive)

  const setFilter = useCallback((next: BacklinksFilter) => {
    setStoredFilter(next)
    if (hasBacklinksFilter(next)) setFiltersOpen(true)
  }, [setStoredFilter])

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
