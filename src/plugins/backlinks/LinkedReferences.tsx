import { useCallback, useState } from 'react'
import { Filter } from 'lucide-react'
import { Block } from '../../data/block'
import { useManyParents, useWorkspaceId } from '@/hooks/block.js'
import { useRepo } from '@/context/repo.js'
import { useNavigateFromGlobalCommand } from '@/utils/navigation.js'
import type { BacklinksViewRendererProps } from '@/plugins/backlinks-view/facet.js'
import { BacklinksEmptyState } from '@/plugins/backlinks-view/BacklinksEmptyState.js'
import { useBacklinks } from './useBacklinks.ts'
import { BacklinkFilters } from './BacklinkFilters.tsx'
import {
  hasBacklinksFilter,
  type BacklinksFilter,
} from './query.ts'
import { useBacklinkFilterState } from './useStoredBacklinkFilter.ts'
import { LazyBacklinkItem } from './BacklinkEntry.tsx'

export function LinkedReferences({block, controls}: BacklinksViewRendererProps) {
  const repo = useRepo()
  const workspaceId = useWorkspaceId(block, repo.activeWorkspaceId ?? '')

  return (
    <LinkedReferencesInner
      key={`${workspaceId}:${block.id}`}
      block={block}
      workspaceId={workspaceId}
      controls={controls}
    />
  )
}

function LinkedReferencesInner({
  block,
  workspaceId,
  controls,
}: {
  block: Block
  workspaceId: string
  controls?: BacklinksViewRendererProps['controls']
}) {
  const {
    filter,
    defaultFilter,
    effectiveFilter,
    defaultFilterConfigBlock,
    setFilter: setStoredFilter,
  } = useBacklinkFilterState(block)
  const navigateFromGlobalCommand = useNavigateFromGlobalCommand()
  const filterActive = hasBacklinksFilter(effectiveFilter)
  const unfilteredBacklinks = useBacklinks(block, workspaceId)
  const filteredBacklinks = useBacklinks(
    block,
    workspaceId,
    filterActive ? effectiveFilter : undefined,
  )
  const backlinks = filterActive ? filteredBacklinks : unfilteredBacklinks
  // Prefetch ancestors for every visible backlink in one batched
  // query, instead of N concurrent `useParents` calls. Each entry's
  // breadcrumbs read from this map; the per-entry `core.ancestors`
  // handle only fires when the user clicks a breadcrumb (changing
  // shownBlock to one we didn't prefetch).
  const initialParentsByBacklinkId = useManyParents(backlinks)
  const [open, setOpen] = useState(true)
  const [filtersOpenOverride, setFiltersOpenOverride] = useState<boolean | null>(null)
  const filtersOpen = filtersOpenOverride ?? filterActive

  const setFilter = useCallback((next: BacklinksFilter) => {
    setStoredFilter(next)
    if (hasBacklinksFilter(next)) setFiltersOpenOverride(true)
  }, [setStoredFilter])
  const openDefaultFilterConfig = useCallback(() => {
    navigateFromGlobalCommand({blockId: defaultFilterConfigBlock.id, workspaceId})
  }, [defaultFilterConfigBlock.id, navigateFromGlobalCommand, workspaceId])

  if (unfilteredBacklinks.length === 0) return <BacklinksEmptyState controls={controls}/>

  const countLabel = filterActive
    ? `${backlinks.length} / ${unfilteredBacklinks.length}`
    : String(backlinks.length)

  return (
    <>
      {controls}
      <div className="mt-4 pt-3 border-t border-border">
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
            onClick={() => setFiltersOpenOverride(prev => !(prev ?? filterActive))}
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
                baseFilter={defaultFilter}
                baseLabel="Daily note defaults"
                baseConfigLabel="Open daily note defaults"
                onBaseConfigClick={openDefaultFilterConfig}
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
                  <LazyBacklinkItem
                    key={backlinkBlock.id}
                    block={backlinkBlock}
                    initialParents={initialParentsByBacklinkId.get(backlinkBlock.id)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}
