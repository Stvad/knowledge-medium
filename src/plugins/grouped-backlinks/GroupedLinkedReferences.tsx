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

interface StickySourceClaims {
  claimedSourceIds: Set<string>
  fieldClaimedSourceIds: Set<string>
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

const currentSourceIdsForGroupedResult = (
  grouped: GroupedBacklinksResult,
): ReadonlySet<string> => {
  const parentSourceIds = grouped.sourceParents.map(entry => entry.sourceId)
  if (parentSourceIds.length > 0 || grouped.total === 0) return new Set(parentSourceIds)
  return new Set(grouped.groups.flatMap(group => group.sourceIds))
}

const groupCanShareClaimedSources = (groupId: string): boolean =>
  groupId.startsWith('field:')

const stickySourceIdsForGroup = ({
  groupId,
  previousGroup,
  nextGroup,
  currentSourceIds,
  claims,
  retainedSourceIds,
}: {
  groupId: string
  previousGroup?: GroupedBacklinkGroup
  nextGroup?: GroupedBacklinkGroup
  currentSourceIds: ReadonlySet<string>
  claims: StickySourceClaims
  retainedSourceIds?: ReadonlySet<string>
}): string[] => {
  const canShareClaimedSources = groupCanShareClaimedSources(groupId)
  const sourceIds: string[] = []
  const seenSourceIds = new Set<string>()
  const append = (sourceId: string) => {
    if (!currentSourceIds.has(sourceId)) return
    if (seenSourceIds.has(sourceId)) return
    if (
      claims.claimedSourceIds.has(sourceId) &&
      !retainedSourceIds?.has(sourceId) &&
      (!canShareClaimedSources || !claims.fieldClaimedSourceIds.has(sourceId))
    ) return
    seenSourceIds.add(sourceId)
    sourceIds.push(sourceId)
  }

  for (const sourceId of previousGroup?.sourceIds ?? []) append(sourceId)
  for (const sourceId of nextGroup?.sourceIds ?? []) append(sourceId)
  for (const sourceId of sourceIds) {
    claims.claimedSourceIds.add(sourceId)
    if (canShareClaimedSources) claims.fieldClaimedSourceIds.add(sourceId)
  }

  return sourceIds
}

const stabilizeGroupedResult = (
  grouped: GroupedBacklinksResult,
  previousState: SnapshotState | null,
): StableGroupedResult => {
  const nextGroups = grouped.groups.filter(group => !group.fallback)
  const previousGroups = previousState?.data.grouped.groups.filter(group => !group.fallback) ?? []
  const nextGroupsById = new Map(nextGroups.map(group => [group.groupId, group]))
  const previousGroupsById = new Map(previousGroups.map(group => [group.groupId, group]))
  const previousGroupOrder = previousState?.groupOrder ?? []
  const knownGroupIds = new Set(previousGroupOrder)
  const groupOrder = [
    ...previousGroupOrder,
    ...nextGroups
      .map(group => group.groupId)
      .filter(groupId => !knownGroupIds.has(groupId)),
  ]
  const currentSourceIds = currentSourceIdsForGroupedResult(grouped)
  const previousFallbackGroup = previousState?.data.grouped.groups.find(group => group.fallback)
  const retainedFallbackSourceIds = new Set(
    previousFallbackGroup?.sourceIds.filter(sourceId => currentSourceIds.has(sourceId)) ?? [],
  )
  const claims: StickySourceClaims = {
    claimedSourceIds: new Set(retainedFallbackSourceIds),
    fieldClaimedSourceIds: new Set(),
  }
  const groups = groupOrder
    .map(groupId => {
      const previousGroup = previousGroupsById.get(groupId)
      const nextGroup = nextGroupsById.get(groupId)
      const group = nextGroup ?? previousGroup
      if (!group) return undefined
      const sourceIds = stickySourceIdsForGroup({
        groupId,
        previousGroup,
        nextGroup,
        currentSourceIds,
        claims,
      })
      if (sourceIds.length === 0) return undefined
      return {...group, sourceIds, fallback: false}
    })
    .filter((group): group is GroupedBacklinkGroup => group !== undefined)

  const nextFallbackGroup = grouped.groups.find(group => group.fallback)
  const fallbackGroup = nextFallbackGroup ?? previousFallbackGroup
  if (fallbackGroup) {
    const sourceIds = stickySourceIdsForGroup({
      groupId: fallbackGroup.groupId,
      previousGroup: previousFallbackGroup,
      nextGroup: nextFallbackGroup,
      currentSourceIds,
      claims,
      retainedSourceIds: retainedFallbackSourceIds,
    })
    if (sourceIds.length > 0) groups.push({...fallbackGroup, sourceIds, fallback: true})
  }

  return {
    grouped: {
      ...grouped,
      groups,
    },
    groupOrder,
  }
}

const stabilizeSnapshotData = (
  data: GroupedBacklinksSnapshot,
  previousState: SnapshotState | null,
): {data: GroupedBacklinksSnapshot; groupOrder: string[]} => {
  const {grouped, groupOrder} = stabilizeGroupedResult(data.grouped, previousState)
  return {
    data: {
      ...data,
      grouped,
    },
    groupOrder,
  }
}

const waitForPostSettleReload = (): Promise<void> =>
  new Promise(resolve => queueMicrotask(resolve))

const loadSettledGroupedResult = async (
  handle: {load: () => Promise<GroupedBacklinksResult>},
): Promise<GroupedBacklinksResult> => {
  let result = await handle.load()
  // A LoaderHandle load invalidated mid-flight resolves with its dirty
  // read, then schedules a clean rerun in a microtask. Drain that rerun
  // before using the result as a new display-order baseline.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await waitForPostSettleReload()
    const next = await handle.load()
    if (Object.is(next, result)) return next
    result = next
  }
  return result
}

const loadSettledGroupedResultWithRetry = async (
  handle: {load: () => Promise<GroupedBacklinksResult>},
): Promise<GroupedBacklinksResult> => {
  try {
    return await loadSettledGroupedResult(handle)
  } catch (error) {
    await waitForPostSettleReload()
    try {
      return await loadSettledGroupedResult(handle)
    } catch {
      throw error
    }
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
  const groupedHandle = useMemo(
    () => repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY](groupedArgs),
    [repo, groupedArgs],
  )
  // Stable string identity of the grouped-query args. The snapshot
  // carries the key of the args it was captured under; whenever the
  // current key drifts (filter or config change while paused), the
  // parent fires a one-shot `handle.load()` to refresh the whole
  // render snapshot — no subscription, so unrelated row edits still
  // don't trigger work.
  const currentQueryKey = groupedHandle.key

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
        const previousState = prev?.queryKey === currentQueryKey ? prev : null
        const stabilized = stabilizeSnapshotData(data, previousState)
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

  // A query-key change establishes a new display-order baseline from an
  // explicit fresh load. `useHandle` may synchronously expose a cached
  // stale `peek()` value before its own load settles; accepting that
  // payload would preserve the old order after switching back to a
  // previously used filter/config key.
  useEffect(() => {
    let cancelled = false
    loadSettledGroupedResultWithRetry(groupedHandle).then(
      result => {
        if (cancelled) return
        setSnapshot(prev => {
          const previousState = prev?.queryKey === currentQueryKey ? prev : null
          const stabilized = stabilizeSnapshotData(
            snapshotFromGroupedResult(repo, result),
            previousState,
          )
          return {
            ...stabilized,
            queryKey: currentQueryKey,
          }
        })
      },
      () => {
        if (cancelled) return
        setSnapshot(prev => (
          prev?.queryKey === currentQueryKey
            ? prev
            : {
                data: EMPTY_GROUPED_BACKLINKS_SNAPSHOT,
                groupOrder: [],
                queryKey: currentQueryKey,
              }
        ))
      },
    )
    return () => { cancelled = true }
  }, [repo, groupedHandle, currentQueryKey])

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
  const groupedArgs = useMemo(
    () => buildGroupedQueryArgs(
      workspaceId,
      block.id,
      groupingConfig,
      filter ?? {},
    ),
    [workspaceId, block.id, groupingConfig, filter],
  )
  const groupedHandle = useMemo(
    () => block.repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY](groupedArgs),
    [block.repo, groupedArgs],
  )

  useEffect(() => {
    return groupedHandle.subscribe(grouped => {
      onData(snapshotFromGroupedResult(block.repo, grouped))
    })
  }, [block.repo, groupedHandle, onData])

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
