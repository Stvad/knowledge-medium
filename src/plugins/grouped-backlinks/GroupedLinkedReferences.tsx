import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { Filter, Pause, Play } from 'lucide-react'
import type { BlockRendererProps } from '@/types.ts'
import { Block } from '@/data/block'
import { useManyParents, useWorkspaceId } from '@/hooks/block.ts'
import { useRepo } from '@/context/repo.tsx'
import { useNavigateFromGlobalCommand } from '@/utils/navigation.ts'
import { BacklinkFilters } from '@/plugins/backlinks/BacklinkFilters.tsx'
import { LazyBacklinkItem } from '@/plugins/backlinks/BacklinkEntry.tsx'
import {
  hasBacklinksFilter,
  type BacklinksFilter,
} from '@/plugins/backlinks/query.ts'
import { useBacklinks } from '@/plugins/backlinks/useBacklinks.ts'
import { useBacklinkFilterState } from '@/plugins/backlinks/useStoredBacklinkFilter.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
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

const EMPTY_GROUPED_BACKLINKS_RESULT: GroupedBacklinksResult = {groups: [], total: 0}

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

interface SharedViewProps {
  block: Block
  workspaceId: string
  open: boolean
  setOpen: Dispatch<SetStateAction<boolean>>
  filter: BacklinksFilter
  defaultFilter: BacklinksFilter
  filterActive: boolean
  filtersOpen: boolean
  setFiltersOpenOverride: Dispatch<SetStateAction<boolean | null>>
  setFilter: (next: BacklinksFilter) => void
  openDefaultFilterConfig: () => void
}

function GroupedLinkedReferencesInner({
  block,
  workspaceId,
}: {
  block: Block
  workspaceId: string
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
  // `groupingConfig` lives in the parent so the paused body can compare
  // it against the snapshot's captured args and trigger a one-shot
  // recompute when it (or the filter) changes.
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
  // frozen body fires a one-shot `handle.load()` to refresh just the
  // `grouped` field — no subscription, so unrelated row edits still
  // don't trigger work.
  const currentQueryKey = useMemo(() => JSON.stringify(groupedArgs), [groupedArgs])

  const setFilter = useCallback((next: BacklinksFilter) => {
    setStoredFilter(next)
    if (hasBacklinksFilter(next)) setFiltersOpenOverride(true)
  }, [setStoredFilter])
  const openDefaultFilterConfig = useCallback(() => {
    navigateFromGlobalCommand({blockId: defaultFilterConfigBlock.id, workspaceId})
  }, [defaultFilterConfigBlock.id, navigateFromGlobalCommand, workspaceId])

  const handlePause = useCallback((data: GroupedBacklinksSnapshot) => {
    setSnapshot({data, queryKey: currentQueryKey})
    setLiveUpdates(false)
  }, [currentQueryKey])
  const handleResume = useCallback(() => {
    setSnapshot(null)
    setLiveUpdates(true)
  }, [])
  const handleSnapshotRefreshed = useCallback(
    (grouped: GroupedBacklinksResult, queryKey: string) => {
      setSnapshot(prev => (prev ? {data: {...prev.data, grouped}, queryKey} : prev))
    },
    [],
  )

  const shared: SharedViewProps = {
    block,
    workspaceId,
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

  // While paused, mount the frozen body — the live body (which is what
  // subscribes to the grouped-backlinks query, the backlinks list, and
  // the manyAncestors prefetch) is unmounted, so those handles lose
  // their subscribers and the underlying queries stop recomputing on
  // edits the user makes while inspecting the snapshot.
  if (liveUpdates) {
    return (
      <LiveGroupedReferencesBody
        {...shared}
        effectiveFilter={effectiveFilter}
        groupingConfig={groupingConfig}
        onPause={handlePause}
      />
    )
  }
  return (
    <FrozenGroupedReferencesBody
      {...shared}
      snapshot={snapshot!}
      groupedArgs={groupedArgs}
      currentQueryKey={currentQueryKey}
      onResume={handleResume}
      onSnapshotRefreshed={handleSnapshotRefreshed}
    />
  )
}

function LiveGroupedReferencesBody({
  effectiveFilter,
  groupingConfig,
  onPause,
  ...shared
}: SharedViewProps & {
  effectiveFilter: BacklinksFilter
  groupingConfig: GroupedBacklinksConfig
  onPause: (data: GroupedBacklinksSnapshot) => void
}) {
  const {block, workspaceId, filterActive} = shared
  const unfilteredBacklinks = useBacklinks(block, workspaceId)
  const grouped = useGroupedBacklinks(
    block,
    workspaceId,
    groupingConfig,
    filterActive ? effectiveFilter : undefined,
  )
  // Same prefetch as `LinkedReferences` — one batched manyAncestors
  // covering every visible source so per-entry breadcrumbs don't each
  // fire `core.ancestors`. We use the `unfilteredBacklinks` set as
  // the seed list so the prefetch handle is stable across filter
  // toggles.
  const initialParentsByBacklinkId = useManyParents(unfilteredBacklinks)

  const data = useMemo<GroupedBacklinksSnapshot>(
    () => ({unfilteredBacklinks, grouped, initialParentsByBacklinkId}),
    [unfilteredBacklinks, grouped, initialParentsByBacklinkId],
  )

  const handleTogglePause = useCallback(() => onPause(data), [onPause, data])

  return (
    <GroupedReferencesView
      {...shared}
      data={data}
      liveUpdates
      onToggleLiveUpdates={handleTogglePause}
    />
  )
}

function FrozenGroupedReferencesBody({
  snapshot,
  groupedArgs,
  currentQueryKey,
  onResume,
  onSnapshotRefreshed,
  ...shared
}: SharedViewProps & {
  snapshot: SnapshotState
  groupedArgs: GroupedQueryArgs
  currentQueryKey: string
  onResume: () => void
  onSnapshotRefreshed: (grouped: GroupedBacklinksResult, queryKey: string) => void
}) {
  const {block} = shared
  const repo = block.repo
  const stale = snapshot.queryKey !== currentQueryKey

  // One-shot refresh when the user adjusts the filter or grouping
  // config while paused. Uses `handle.load()` directly rather than
  // `useHandle(...)` so we never subscribe — unrelated row edits won't
  // wake the handle, and once the load resolves the new result lands
  // in the snapshot and we settle back into the frozen view.
  useEffect(() => {
    if (!stale) return
    let cancelled = false
    const handle = repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY](groupedArgs)
    handle.load().then(
      result => {
        if (cancelled) return
        onSnapshotRefreshed(result ?? EMPTY_GROUPED_BACKLINKS_RESULT, currentQueryKey)
      },
      () => {/* error is stored on the handle */},
    )
    return () => { cancelled = true }
  }, [stale, repo, groupedArgs, currentQueryKey, onSnapshotRefreshed])

  return (
    <GroupedReferencesView
      {...shared}
      data={snapshot.data}
      liveUpdates={false}
      onToggleLiveUpdates={onResume}
    />
  )
}

function GroupedReferencesView({
  workspaceId,
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

  if (unfilteredBacklinks.length === 0) return null

  const countLabel = filterActive
    ? `${grouped.total} / ${unfilteredBacklinks.length}`
    : String(grouped.total)

  return (
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
        <div className="flex shrink-0 items-center gap-0.5">
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
  )
}
