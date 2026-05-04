import { useCallback, useMemo, useState } from 'react'
import { Filter } from 'lucide-react'
import type { BlockRendererProps } from '@/types.ts'
import { Block } from '@/data/block'
import { useWorkspaceId } from '@/hooks/block.ts'
import { useRepo } from '@/context/repo.tsx'
import { BacklinkFilters } from '@/plugins/backlinks/BacklinkFilters.tsx'
import { LazyBacklinkItem } from '@/plugins/backlinks/BacklinkEntry.tsx'
import {
  hasBacklinksFilter,
  type BacklinksFilter,
} from '@/plugins/backlinks/query.ts'
import { useBacklinks } from '@/plugins/backlinks/useBacklinks.ts'
import { useStoredBacklinkFilter } from '@/plugins/backlinks/useStoredBacklinkFilter.ts'
import type { GroupedBacklinkGroup } from './grouping.ts'
import { useGroupedBacklinks } from './useGroupedBacklinks.ts'

const GroupItems = ({
  group,
  sourceBlocks,
}: {
  group: GroupedBacklinkGroup
  sourceBlocks: Block[]
}) => {
  const [open, setOpen] = useState(true)

  return (
    <div className="border-l border-border/80 pl-3">
      <button
        type="button"
        onClick={() => setOpen(prev => !prev)}
        className="flex min-w-0 items-center gap-2 py-1 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <span className="text-base leading-none">{open ? '▾' : '▸'}</span>
        <span className="truncate">{group.label}</span>
        <span className="text-xs text-muted-foreground/70">{group.sourceIds.length}</span>
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-2">
          {sourceBlocks.map(source => (
            <LazyBacklinkItem key={source.id} block={source}/>
          ))}
        </div>
      )}
    </div>
  )
}

const GroupedReferencesGroup = ({group}: { group: GroupedBacklinkGroup }) => {
  const repo = useRepo()
  const sourceBlocks = useMemo(
    () => group.sourceIds.map(id => repo.block(id)),
    [group.sourceIds, repo],
  )

  return <GroupItems group={group} sourceBlocks={sourceBlocks}/>
}

export function GroupedLinkedReferences({block}: BlockRendererProps) {
  const repo = useRepo()
  const workspaceId = useWorkspaceId(block, repo.activeWorkspaceId ?? '')

  return (
    <GroupedLinkedReferencesInner
      key={`${workspaceId}:${block.id}`}
      block={block}
      workspaceId={workspaceId}
    />
  )
}

function GroupedLinkedReferencesInner({
  block,
  workspaceId,
}: {
  block: Block
  workspaceId: string
}) {
  const [filter, setStoredFilter] = useStoredBacklinkFilter(block)
  const filterActive = hasBacklinksFilter(filter)
  const unfilteredBacklinks = useBacklinks(block, workspaceId)
  const grouped = useGroupedBacklinks(block, workspaceId, filterActive ? filter : undefined)
  const [open, setOpen] = useState(true)
  const [filtersOpen, setFiltersOpen] = useState(filterActive)

  const setFilter = useCallback((next: BacklinksFilter) => {
    setStoredFilter(next)
    if (hasBacklinksFilter(next)) setFiltersOpen(true)
  }, [setStoredFilter])

  if (unfilteredBacklinks.length === 0) return null

  const countLabel = filterActive
    ? `${grouped.total} / ${unfilteredBacklinks.length}`
    : String(grouped.total)

  return (
    <div className="mt-8 pt-4 border-t border-border">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen(prev => !prev)}
          className="flex min-w-0 items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          <span className="text-base leading-none">{open ? '▾' : '▸'}</span>
          <span>Grouped References</span>
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
          {grouped.total === 0 ? (
            <div className="mt-3 text-xs text-muted-foreground">
              No matching references.
            </div>
          ) : (
            <div className="mt-3 flex flex-col gap-4">
              {grouped.groups.map(group => (
                <GroupedReferencesGroup key={group.groupId} group={group}/>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
