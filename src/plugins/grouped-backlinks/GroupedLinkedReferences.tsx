import { useCallback, useEffect, useMemo, useState, type Dispatch, type MouseEvent, type SetStateAction } from 'react'
import { Filter, Pause, Play } from 'lucide-react'
import { Block } from '@/data/block'
import { useWorkspaceId } from '@/hooks/block.js'
import { useRepo } from '@/context/repo.js'
import { useBlockOpener } from '@/utils/navigation.js'
import { BacklinkFilters } from '@/plugins/backlinks/BacklinkFilters.js'
import { LazyBacklinkItem } from '@/plugins/backlinks/BacklinkEntry.js'
import type { BacklinksViewRendererProps } from '@/plugins/backlinks-view/facet.js'
import { BacklinksEmptyState } from '@/plugins/backlinks-view/BacklinksEmptyState.js'
import {
  hasBacklinksFilter,
  type BacklinksFilter,
} from '@/plugins/backlinks/query.js'
import { useBacklinkFilterState } from '@/plugins/backlinks/useStoredBacklinkFilter.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import type { GroupedBacklinkGroup } from './grouping.ts'
import { useGroupedBacklinksConfig } from './useGroupedBacklinksConfig.ts'
import { useGroupedBacklinks } from './useGroupedBacklinks.ts'
import type { GroupedBacklinksConfig } from './config.ts'
import {
  GROUPED_BACKLINKS_FOR_BLOCK_QUERY,
  type GroupedBacklinksResult,
} from './query.ts'
import { groupedBacklinksGroupHeaderActionsFacet } from './facet.ts'
import { GroupHeaderActionButton } from './GroupHeaderActionButton.tsx'

interface GroupedBacklinksSnapshot {
  unfilteredBacklinks: Block[]
  grouped: GroupedBacklinksResult
  initialParentsByBacklinkId: ReadonlyMap<string, Block[]>
}

interface GroupedQueryArgs {
  workspaceId: string
  id: string
  groupingConfig: GroupedBacklinksConfig
  filter?: BacklinksFilter
}

interface SnapshotState {
  data: GroupedBacklinksSnapshot
  queryKey: string
  groupOrder: string[]
}

interface StableGroupedResult {
  grouped: GroupedBacklinksResult
  groupOrder: string[]
}

const EMPTY_GROUPED_BACKLINKS_SNAPSHOT: GroupedBacklinksSnapshot = {
  unfilteredBacklinks: [],
  grouped: {
    groups: [],
    total: 0,
    unfilteredSourceIds: [],
    sourceParents: [],
  },
  initialParentsByBacklinkId: new Map(),
}

const buildGroupedQueryArgs = (
  workspaceId: string,
  blockId: string,
  groupingConfig: GroupedBacklinksConfig,
  effectiveFilter: BacklinksFilter,
): GroupedQueryArgs => ({
  workspaceId,
  id: blockId,
  groupingConfig,
  ...(hasBacklinksFilter(effectiveFilter) ? {filter: effectiveFilter} : {}),
})

const snapshotFromGroupedResult = (
  repo: Block['repo'],
  grouped: GroupedBacklinksResult,
): GroupedBacklinksSnapshot => ({
  unfilteredBacklinks: grouped.unfilteredSourceIds.map(id => repo.block(id)),
  grouped,
  initialParentsByBacklinkId: new Map(
    grouped.sourceParents.map(entry => [
      entry.sourceId,
      entry.parentIds.map(parentId => repo.block(parentId)),
    ]),
  ),
})

const stabilizeGroupedResult = (
  grouped: GroupedBacklinksResult,
  previousOrder: readonly string[] | null,
): StableGroupedResult => {
  const nextGroups = grouped.groups.filter(group => !group.fallback)
  const fallbackGroup = grouped.groups.find(group => group.fallback)
  const nextGroupsById = new Map(nextGroups.map(group => [group.groupId, group]))
  const groupOrder = [
    ...(previousOrder ?? []),
    ...nextGroups
      .map(group => group.groupId)
      .filter(groupId => !(previousOrder ?? []).includes(groupId)),
  ]

  return {
    grouped: {
      ...grouped,
      groups: [
        ...groupOrder
          .map(groupId => nextGroupsById.get(groupId))
          .filter((group): group is GroupedBacklinkGroup => group !== undefined),
        ...(fallbackGroup ? [fallbackGroup] : []),
      ],
    },
    groupOrder,
  }
}

const stabilizeSnapshotData = (
  data: GroupedBacklinksSnapshot,
  previousOrder: readonly string[] | null,
): {data: GroupedBacklinksSnapshot; groupOrder: string[]} => {
  const {grouped, groupOrder} = stabilizeGroupedResult(data.grouped, previousOrder)
  return {
    data: {
      ...data,
      grouped,
    },
    groupOrder,
  }
}

const GroupItems = ({
  sourceBlocks,
  group,
  parentsBySourceId,
}: {
  group: GroupedBacklinkGroup
  sourceBlocks: Block[]
  parentsBySourceId: ReadonlyMap<string, Block[]>
}) => {
  const runtime = useAppRuntime()
  const headerActions = runtime.read(groupedBacklinksGroupHeaderActionsFacet)
  const [open, setOpen] = useState(true)

  return (
    <div className="border-l border-border/80 pl-3">
      <div className="flex min-w-0 items-center gap-1 py-1">
        <button
          type="button"
          onClick={() => setOpen(prev => !prev)}
          className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          <span className="text-base leading-none">{open ? '▾' : '▸'}</span>
          <span className="truncate">{group.label}</span>
          <span className="text-xs text-muted-foreground/70">{group.sourceIds.length}</span>
        </button>
        {headerActions.length > 0 && (
          <div className="flex shrink-0 items-center gap-0.5">
            {headerActions.map((entry, index) => (
              <GroupHeaderActionButton
                key={`${entry.actionId}:${index}`}
                actionId={entry.actionId}
                sourceBlocks={sourceBlocks}
                icon={entry.icon}
                label={entry.label}
                triggerDetail={entry.triggerDetail}
              />
            ))}
          </div>
        )}
      </div>
      {open && (
        <div className="mt-1 flex flex-col gap-2">
          {sourceBlocks.map(source => (
            <LazyBacklinkItem
              key={source.id}
              block={source}
              scopeId={`group:${group.groupId}:${source.id}`}
              initialParents={parentsBySourceId.get(source.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

const GroupedReferencesGroup = ({
  group,
  parentsBySourceId,
}: {
  group: GroupedBacklinkGroup
  parentsBySourceId: ReadonlyMap<string, Block[]>
}) => {
  const repo = useRepo()
  const sourceBlocks = useMemo(
    () => group.sourceIds.map(id => repo.block(id)),
    [group.sourceIds, repo],
  )

  return (
    <GroupItems
      group={group}
      sourceBlocks={sourceBlocks}
      parentsBySourceId={parentsBySourceId}
    />
  )
}

export function GroupedLinkedReferences({block, controls}: BacklinksViewRendererProps) {
  const repo = useRepo()
  const workspaceId = useWorkspaceId(block, repo.activeWorkspaceId ?? '')

  return (
    <GroupedLinkedReferencesInner
      key={`${workspaceId}:${block.id}`}
      block={block}
      workspaceId={workspaceId}
      controls={controls}
    />
  )
}

interface SharedViewProps {
  block: Block
  workspaceId: string
  controls?: BacklinksViewRendererProps['controls']
  open: boolean
  setOpen: Dispatch<SetStateAction<boolean>>
  filter: BacklinksFilter
  defaultFilter: BacklinksFilter
  filterActive: boolean
  filtersOpen: boolean
  setFiltersOpenOverride: Dispatch<SetStateAction<boolean | null>>
  setFilter: (next: BacklinksFilter) => void
  openDefaultFilterConfig: (event: MouseEvent) => void
}

function GroupedLinkedReferencesInner({
  block,
  workspaceId,
  controls,
}: {
  block: Block
  workspaceId: string
  controls?: BacklinksViewRendererProps['controls']
}) {
  const repo = block.repo
  const {
    filter,
    defaultFilter,
    effectiveFilter,
    defaultFilterConfigBlock,
    setFilter: setStoredFilter,
  } = useBacklinkFilterState(block)
  const openBlock = useBlockOpener({plainClick: 'navigator'})
  const filterActive = hasBacklinksFilter(effectiveFilter)
  // `groupingConfig` lives in the parent so paused mode can compare it
  // against the snapshot's captured args and trigger a one-shot recompute
  // when it (or the filter) changes.
  const groupingConfig = useGroupedBacklinksConfig(block)
  const [open, setOpen] = useState(true)
  const [filtersOpenOverride, setFiltersOpenOverride] = useState<boolean | null>(null)
  const filtersOpen = filtersOpenOverride ?? filterActive
  const [liveUpdates, setLiveUpdates] = useState(true)
  const [snapshot, setSnapshot] = useState<SnapshotState | null>(null)

  const groupedArgs = useMemo(
    () => buildGroupedQueryArgs(workspaceId, block.id, groupingConfig, effectiveFilter),
    [workspaceId, block.id, groupingConfig, effectiveFilter],
  )
  // Stable string identity of the grouped-query args. The snapshot
  // carries the key of the args it was captured under; whenever the
  // current key drifts (filter or config change while paused), the
  // parent fires a one-shot `handle.load()` to refresh the whole
  // render snapshot — no subscription, so unrelated row edits still
  // don't trigger work.
  const currentQueryKey = useMemo(() => JSON.stringify(groupedArgs), [groupedArgs])

  const setFilter = useCallback((next: BacklinksFilter) => {
    setStoredFilter(next)
    if (hasBacklinksFilter(next)) setFiltersOpenOverride(true)
  }, [setStoredFilter])
  const openDefaultFilterConfig = useCallback((event: MouseEvent) => {
    openBlock(event, {blockId: defaultFilterConfigBlock.id, workspaceId})
  }, [defaultFilterConfigBlock.id, openBlock, workspaceId])

  const handleLiveData = useCallback(
    (data: GroupedBacklinksSnapshot) => {
      setSnapshot(prev => {
        const previousOrder = prev?.queryKey === currentQueryKey ? prev.groupOrder : null
        const stabilized = stabilizeSnapshotData(data, previousOrder)
        return {
          ...stabilized,
          queryKey: currentQueryKey,
        }
      })
    },
    [currentQueryKey],
  )
  const handleToggleLiveUpdates = useCallback(() => {
    setLiveUpdates(prev => !prev)
  }, [])

  const snapshotQueryKey = snapshot?.queryKey
  const snapshotStale = snapshotQueryKey !== undefined && snapshotQueryKey !== currentQueryKey

  // While paused, keep the visible tree mounted and run the same one-shot
  // refresh the old frozen body used when filter/config args drift. This
  // refresh loads imperatively, so it does not subscribe to live query
  // invalidations.
  useEffect(() => {
    if (liveUpdates || !snapshotStale) return
    let cancelled = false
    const handle = repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY](groupedArgs)
    handle.load().then(
      result => {
        if (cancelled) return
        setSnapshot(prev => {
          const previousOrder = prev?.queryKey === currentQueryKey ? prev.groupOrder : null
          const stabilized = stabilizeSnapshotData(
            snapshotFromGroupedResult(repo, result),
            previousOrder,
          )
          return {
            ...stabilized,
            queryKey: currentQueryKey,
          }
        })
      },
      () => {/* error is stored on the handle */},
    )
    return () => { cancelled = true }
  }, [liveUpdates, snapshotStale, repo, groupedArgs, currentQueryKey])

  const shared: SharedViewProps = {
    block,
    workspaceId,
    controls,
    open,
    setOpen,
    filter,
    defaultFilter,
    filterActive,
    filtersOpen,
    setFiltersOpenOverride,
    setFilter,
    openDefaultFilterConfig,
  }
  const data = snapshot?.data ?? EMPTY_GROUPED_BACKLINKS_SNAPSHOT

  return (
    <>
      <GroupedReferencesView
        {...shared}
        data={data}
        liveUpdates={liveUpdates}
        onToggleLiveUpdates={handleToggleLiveUpdates}
      />
      {liveUpdates && (
        <GroupedBacklinksLiveBridge
          block={block}
          workspaceId={workspaceId}
          groupingConfig={groupingConfig}
          filter={filterActive ? effectiveFilter : undefined}
          onData={handleLiveData}
        />
      )}
    </>
  )
}

function GroupedBacklinksLiveBridge({
  block,
  workspaceId,
  groupingConfig,
  filter,
  onData,
}: {
  block: Block
  workspaceId: string
  groupingConfig: GroupedBacklinksConfig
  filter?: BacklinksFilter
  onData: (data: GroupedBacklinksSnapshot) => void
}) {
  const grouped = useGroupedBacklinks(
    block,
    workspaceId,
    groupingConfig,
    filter,
  )

  const data = useMemo<GroupedBacklinksSnapshot>(
    () => snapshotFromGroupedResult(block.repo, grouped),
    [block.repo, grouped],
  )

  useEffect(() => {
    onData(data)
  }, [onData, data])

  return null
}

function GroupedReferencesView({
  workspaceId,
  controls,
  data,
  liveUpdates,
  onToggleLiveUpdates,
  open,
  setOpen,
  filter,
  defaultFilter,
  filterActive,
  filtersOpen,
  setFiltersOpenOverride,
  setFilter,
  openDefaultFilterConfig,
}: SharedViewProps & {
  data: GroupedBacklinksSnapshot
  liveUpdates: boolean
  onToggleLiveUpdates: () => void
}) {
  const {unfilteredBacklinks, grouped, initialParentsByBacklinkId} = data

  if (unfilteredBacklinks.length === 0) return <BacklinksEmptyState controls={controls}/>

  const countLabel = filterActive
    ? `${grouped.total} / ${unfilteredBacklinks.length}`
    : String(grouped.total)

  return (
    <>
      <div className="mt-4 pt-3 border-t border-border">
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
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={onToggleLiveUpdates}
              className={`rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                !liveUpdates ? 'bg-accent text-foreground' : ''
              }`}
              title={liveUpdates ? 'Pause live updates' : 'Resume live updates'}
              aria-label={liveUpdates ? 'Pause live updates' : 'Resume live updates'}
              aria-pressed={!liveUpdates}
            >
              {liveUpdates ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
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
            {controls}
          </div>
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
            {grouped.total === 0 ? (
              <div className="mt-3 text-xs text-muted-foreground">
                No matching references.
              </div>
            ) : (
              <div className="mt-3 flex flex-col gap-4">
                {grouped.groups.map(group => (
                  <GroupedReferencesGroup
                    key={group.groupId}
                    group={group}
                    parentsBySourceId={initialParentsByBacklinkId}
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
