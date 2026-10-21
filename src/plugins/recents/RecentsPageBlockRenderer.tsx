/** Renderer for the Recents page. Wraps the default page layout and
 *  swaps the content area for a Tana-style feed of recent activity,
 *  backed by the kernel `recentActivity` query, which returns
 *  user-authored rows only (panels, preferences and other app-owned rows
 *  never read as edits) each with its ancestor chain — what lets
 *  `groupRecentActivity` fold an edited tree back into the one thing it
 *  was.
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
import { MarkdownContentRenderer } from '@/components/renderer/MarkdownContentRenderer.js'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'
import { BlockRef } from '@/components/references/BlockRef.js'
import { BlockLoadingPlaceholder } from '@/components/BlockLoadingPlaceholder.js'
import { LazyViewportMount } from '@/components/util/LazyViewportMount.js'
import type { LazyViewportPlaceholderProps } from '@/components/util/LazyViewportMount.js'
import type { BlockRenderer, BlockRendererProps } from '@/types.js'
import { formatRelativeTime } from '@/utils/relativeTime.js'
import { groupRecentActivity, type RecentActivityGroup } from './grouping.js'
import type { BlockRendererRegistration } from '@/extensions/blockInteraction.js'

/** Rows scanned per page of the feed. Sized in ROWS, not entries,
 *  because one entry can absorb a whole imported tree — which is also
 *  why the window has to be extendable: a 500-block import would
 *  otherwise fill the window with a single entry and put every older
 *  entry permanently out of reach. "Show older" adds another page. */
const RECENTS_ROW_PAGE = 200
/** Members shown before "+N more". Enough to see what an entry covers
 *  without an import's 80 rows pushing the next entry off the screen. */
const COLLAPSED_MEMBER_COUNT = 3
const ANCHOR_LINE_HEIGHT_PX = 24
const MEMBER_LINE_HEIGHT_PX = 22
const ROW_PADDING_PX = 16
const ROW_OVERSCAN_PX = 600

/** What a collapsed entry actually occupies — an anchor line plus its
 *  visible members. A flat estimate reserves one line for every entry
 *  and lets multi-member rows grow on mount, which shoves the feed down
 *  under the reader as they scroll. */
const estimatedRowHeight = (group: RecentActivityGroup): number =>
  ANCHOR_LINE_HEIGHT_PX
  + Math.min(group.memberIds.length, COLLAPSED_MEMBER_COUNT) * MEMBER_LINE_HEIGHT_PX
  + ROW_PADDING_PX

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
      estimatedHeightPx={estimatedRowHeight(group)}
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
  const [rowLimit, setRowLimit] = useState(RECENTS_ROW_PAGE)
  // `null` while the first window is still loading — distinct from a
  // resolved empty window, which is what the empty state is about.
  const entries = useHandle(
    repo.query.recentActivity({workspaceId, limit: rowLimit}),
    {selector: data => data ?? null},
  )
  const now = useMinuteClock()

  const groups = useMemo(() => {
    if (!entries) return null
    return groupRecentActivity(
      entries.map(entry => entry.block),
      new Map(entries.map(entry => [entry.block.id, entry.ancestors])),
    )
  }, [entries])

  // A full window means the query hit the limit rather than running out
  // of history, so there IS more to show. Every entry the window
  // produced is rendered (the rows are lazily mounted anyway) — capping
  // entries on top of capping rows would drop activity with nothing on
  // screen to say so.
  const hasMore = (entries?.length ?? 0) >= rowLimit

  if (groups === null) return null
  if (groups.length === 0) {
    return (
      <div className="py-6 text-sm text-muted-foreground">
        No recent edits yet — edit a block and it will show up here.
      </div>
    )
  }

  return (
    <div className="flex flex-col">
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
      {hasMore && (
        <button
          type="button"
          className="self-start py-3 text-sm text-muted-foreground hover:text-foreground"
          onClick={() => setRowLimit(limit => limit + RECENTS_ROW_PAGE)}
        >
          Show older activity
        </button>
      )}
    </div>
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

export const RecentsPageBlockRenderer: BlockRenderer = (props: BlockRendererProps) => (
  <DefaultBlockRenderer
    {...props}
    ContentRenderer={RecentsPageContentRenderer}
    contentShowsOtherBlocks
  />
)
RecentsPageBlockRenderer.displayName = 'RecentsPageBlockRenderer'

export const recentsPageRendererRegistration: BlockRendererRegistration = {
  id: 'recentsPage',
  label: 'Recents page',
  resolve: ctx =>
    ctx.types.includes(RECENTS_PAGE_TYPE) ? {render: RecentsPageBlockRenderer} : null,
}
