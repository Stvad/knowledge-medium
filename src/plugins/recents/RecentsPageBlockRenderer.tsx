/** Renderer for the Recents page. Wraps the default page layout and
 *  swaps the content area for a Tana-style list of recently-edited
 *  blocks, backed by the kernel `recentBlocks` query. Each row uses
 *  `BlockEmbed` so the block goes through the regular renderer chain
 *  (markdown, wikilinks, click semantics) instead of a custom
 *  string-truncating row. */

import { useRepo } from '@/context/repo.js'
import { useHandle } from '@/hooks/block.js'
import { useMinuteClock } from '@/hooks/useMinuteClock.js'
import { RECENTS_PAGE_TYPE } from '@/data/blockTypes.js'
import type { BlockData } from '@/data/api'
import { MarkdownContentRenderer } from '@/components/renderer/MarkdownContentRenderer.js'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'
import { BlockEmbed } from '@/components/references/BlockEmbed.js'
import { BlockLoadingPlaceholder } from '@/components/BlockLoadingPlaceholder.js'
import { LazyViewportMount } from '@/components/util/LazyViewportMount.js'
import type { LazyViewportPlaceholderProps } from '@/components/util/LazyViewportMount.js'
import type { BlockRenderer, BlockRendererProps } from '@/types.js'
import { formatRelativeTime } from '@/utils/relativeTime.js'

const RECENTS_LIMIT = 50
const ROW_ESTIMATED_HEIGHT_PX = 64
const ROW_OVERSCAN_PX = 600

const RecentRowPlaceholder = ({reservedHeight}: LazyViewportPlaceholderProps) => (
  <div className="py-2" style={{minHeight: reservedHeight}} aria-hidden>
    <BlockLoadingPlaceholder reservedHeight={32}/>
  </div>
)

interface RecentRowProps {
  data: BlockData
  now: number
}

function RecentRow({data, now}: RecentRowProps) {
  return (
    <LazyViewportMount
      cacheKey={`recents:${data.id}`}
      blockId={data.id}
      estimatedHeightPx={ROW_ESTIMATED_HEIGHT_PX}
      overscanPx={ROW_OVERSCAN_PX}
      renderPlaceholder={(props) => <RecentRowPlaceholder {...props}/>}
    >
      <div className="flex items-start justify-between gap-3 py-1">
        <div className="min-w-0 flex-1">
          <BlockEmbed
            blockId={data.id}
            sourceBlockId="recents"
            occurrenceId={`row:${data.id}`}
          />
        </div>
        <span className="shrink-0 pt-1 text-xs text-muted-foreground tabular-nums">
          {formatRelativeTime(data.userUpdatedAt, now)}
        </span>
      </div>
    </LazyViewportMount>
  )
}

interface RecentsListProps {
  workspaceId: string
}

function RecentsList({workspaceId}: RecentsListProps) {
  const repo = useRepo()
  const recents = useHandle(
    repo.query.recentBlocks({workspaceId, limit: RECENTS_LIMIT}),
    {selector: data => data ?? []},
  )
  const now = useMinuteClock()

  if (recents.length === 0) {
    return (
      <div className="py-6 text-sm text-muted-foreground">
        No recent edits yet — edit a block and it will show up here.
      </div>
    )
  }

  return (
    <ul className="flex flex-col divide-y divide-border/40 border-t border-border/40">
      {recents.map(data => (
        <li key={data.id}>
          <RecentRow data={data} now={now}/>
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
