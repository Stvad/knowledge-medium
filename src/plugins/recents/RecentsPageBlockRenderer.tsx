/** Renderer for the Recents page. Wraps the default page layout and
 *  swaps the content area for a Tana-style feed of recent activity,
 *  backed by the kernel `recentBlocks` query (`excludeSystem`, so panels,
 *  preferences and other app-owned rows never read as edits) plus
 *  `manyAncestors`, which is what lets `groupRecentActivity` fold an
 *  edited tree back into the one thing it was.
 *
 *  Rows render as `BlockRef` — one navigating line of the block's own
 *  content. Not `BlockEmbed`: an embed mounts the target's whole subtree,
 *  which for a feed whose entries are usually PAGES means rendering the
 *  page inline. */

import { useMemo, useState } from 'react'
import { useRepo } from '@/context/repo.js'
import { useHandle } from '@/hooks/block.js'
import { useMinuteClock } from '@/hooks/useMinuteClock.js'
import { RECENTS_PAGE_TYPE } from '@/data/blockTypes.js'
import type { BlockData } from '@/data/api'
import { MarkdownContentRenderer } from '@/components/renderer/MarkdownContentRenderer.js'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'
import { BlockRef } from '@/components/references/BlockRef.js'
import { BlockLoadingPlaceholder } from '@/components/BlockLoadingPlaceholder.js'
import { LazyViewportMount } from '@/components/util/LazyViewportMount.js'
import type { LazyViewportPlaceholderProps } from '@/components/util/LazyViewportMount.js'
import type { BlockRenderer, BlockRendererProps } from '@/types.js'
import { formatRelativeTime } from '@/utils/relativeTime.js'
import { groupRecentActivity, type RecentActivityGroup } from './grouping.js'

/** Rows scanned before grouping. Deliberately larger than the number of
 *  entries shown: one entry can absorb a whole imported tree, so a
 *  window sized to the entry count would render a handful of entries on
 *  a day with one big import. */
const RECENTS_ROW_LIMIT = 200
const RECENTS_GROUP_LIMIT = 50
/** Members shown before "+N more". Enough to see what an entry covers
 *  without an import's 80 rows pushing the next entry off the screen. */
const COLLAPSED_MEMBER_COUNT = 3
const ROW_ESTIMATED_HEIGHT_PX = 48
const ROW_OVERSCAN_PX = 600

const EMPTY_ROWS: BlockData[] = []

const RecentRowPlaceholder = ({reservedHeight}: LazyViewportPlaceholderProps) => (
  <div className="py-2" style={{minHeight: reservedHeight}} aria-hidden>
    <BlockLoadingPlaceholder reservedHeight={24}/>
  </div>
)

/** A page can host several sessions, so the anchor alone isn't unique. */
const groupKey = (group: RecentActivityGroup) => `${group.anchorId}:${group.lastEditedAt}`

interface RecentGroupRowProps {
  group: RecentActivityGroup
  now: number
}

function RecentGroupRow({group, now}: RecentGroupRowProps) {
  const [expanded, setExpanded] = useState(false)
  const key = groupKey(group)
  const visible = expanded ? group.memberIds : group.memberIds.slice(0, COLLAPSED_MEMBER_COUNT)
  const hidden = group.memberIds.length - visible.length

  return (
    <LazyViewportMount
      cacheKey={`recents:${key}`}
      blockId={group.anchorId}
      estimatedHeightPx={ROW_ESTIMATED_HEIGHT_PX}
      overscanPx={ROW_OVERSCAN_PX}
      renderPlaceholder={(props) => <RecentRowPlaceholder {...props}/>}
    >
      <div className="flex flex-col gap-1 py-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 text-sm">
            <BlockRef blockId={group.anchorId} sourceBlockId="recents" occurrenceId={`anchor:${key}`}/>
            {!group.anchorEdited && (
              <span className="ml-2 text-xs text-muted-foreground">
                {group.memberIds.length === 1 ? '1 block changed' : `${group.memberIds.length} blocks changed`}
              </span>
            )}
          </div>
          <span className="shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">
            {formatRelativeTime(group.lastEditedAt, now)}
          </span>
        </div>
        {visible.length > 0 && (
          <ul className="ml-1 flex flex-col gap-0.5 border-l border-border/60 pl-3 text-sm">
            {visible.map(id => (
              <li key={id} className="min-w-0 truncate">
                <BlockRef blockId={id} sourceBlockId="recents" occurrenceId={`member:${key}:${id}`}/>
              </li>
            ))}
          </ul>
        )}
        {hidden > 0 && (
          <button
            type="button"
            className="self-start pl-4 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setExpanded(true)}
          >
            +{hidden} more
          </button>
        )}
      </div>
    </LazyViewportMount>
  )
}

interface RecentsListProps {
  workspaceId: string
}

export function RecentsList({workspaceId}: RecentsListProps) {
  const repo = useRepo()
  const rows = useHandle(
    repo.query.recentBlocks({workspaceId, limit: RECENTS_ROW_LIMIT, excludeSystem: true}),
    {selector: data => data ?? EMPTY_ROWS},
  )
  const ids = useMemo(() => rows.map(row => row.id), [rows])
  const ancestors = useHandle(
    repo.query.manyAncestors({ids}),
    {selector: data => data ?? []},
  )
  const now = useMinuteClock()

  const groups = useMemo(() => {
    const ancestorsById = new Map(ancestors.map(entry => [entry.startId, entry.ancestors]))
    return groupRecentActivity(rows, ancestorsById).slice(0, RECENTS_GROUP_LIMIT)
  }, [rows, ancestors])

  if (groups.length === 0) {
    return (
      <div className="py-6 text-sm text-muted-foreground">
        No recent edits yet — edit a block and it will show up here.
      </div>
    )
  }

  return (
    <ul
      aria-label="Recent activity"
      className="flex flex-col divide-y divide-border/40 border-t border-border/40"
    >
      {groups.map(group => (
        <li key={groupKey(group)}>
          <RecentGroupRow group={group} now={now}/>
        </li>
      ))}
    </ul>
  )
}

const RecentsPageContentRenderer: BlockRenderer = (props: BlockRendererProps) => {
  const {block} = props
  const workspaceId = block.peek()?.workspaceId
  return (
    <div className="flex w-full flex-col gap-3">
      <MarkdownContentRenderer {...props} />
      {workspaceId && <RecentsList workspaceId={workspaceId}/>}
    </div>
  )
}
RecentsPageContentRenderer.displayName = 'RecentsPageContentRenderer'

export const RecentsPageBlockRenderer: BlockRenderer = Object.assign(
  (props: BlockRendererProps) => (
    <DefaultBlockRenderer
      {...props}
      ContentRenderer={RecentsPageContentRenderer}
    />
  ),
  {
    canRender: ({block}: BlockRendererProps): boolean => {
      const data = block.peek()
      if (!data) return false
      const types = data.properties.types
      return Array.isArray(types) && types.includes(RECENTS_PAGE_TYPE)
    },
    priority: () => 100,
  },
)
RecentsPageBlockRenderer.displayName = 'RecentsPageBlockRenderer'
