/**
 * Block metadata card — the content shown in the bullet hover-card (and in
 * the "Block info" dialog). Two rows: when the block was last edited and
 * when it was created, each with a relative + absolute timestamp and the
 * user responsible (linked to their user page when resolvable).
 *
 * All data is read straight off `BlockData` — `createdAt` / `createdBy` and
 * the user-facing `userUpdatedAt` / `updatedBy` (NOT the row-version
 * `updatedAt`, which is a sync discriminator, not a display stamp).
 */
import type { ReactNode } from 'react'
import type { Block } from '@/data/block'
import { useHandle } from '@/hooks/block.js'
import { useMinuteClock } from '@/hooks/useMinuteClock.js'
import { useUserPage } from '@/data/globalState.js'
import { buildAppHash } from '@/utils/routing.js'
import { useOpenBlock } from '@/utils/navigation.js'
import { formatAbsoluteDateTime, formatRelativeTime } from '@/utils/relativeTime.js'

interface CardMeta {
  createdAt: number
  createdBy: string
  userUpdatedAt: number
  updatedBy: string
  workspaceId: string
}

// Narrow selector — subscribes to the block handle but only re-renders when
// one of the metadata fields actually changes (avoids `no-broad-block-
// subscriptions`; content edits that don't touch these fields are deduped).
const useCardMeta = (block: Block): CardMeta | undefined =>
  useHandle(block, {
    selector: doc =>
      doc
        ? {
            createdAt: doc.createdAt,
            createdBy: doc.createdBy,
            userUpdatedAt: doc.userUpdatedAt,
            updatedBy: doc.updatedBy,
            workspaceId: doc.workspaceId,
          }
        : undefined,
  })

const Author = ({userId, workspaceId}: {userId: string; workspaceId: string}): ReactNode => {
  // Resolve the user page in the block's own workspace so the name and the
  // link href agree even when it isn't the active workspace.
  const {name, blockId} = useUserPage(userId, workspaceId)
  // Hook must run unconditionally; the handler is only wired when there's a
  // user page to open.
  const openUser = useOpenBlock({blockId: blockId ?? '', workspaceId})
  return (
    <span>
      by{' '}
      {blockId ? (
        <a
          href={buildAppHash(workspaceId, blockId)}
          className="hover:underline"
          onClick={openUser}
        >
          {name}
        </a>
      ) : (
        name
      )}
    </span>
  )
}

const MetaRow = ({
  label,
  ts,
  by,
  now,
}: {
  label: string
  ts: number
  by: ReactNode
  now: number
}): ReactNode => {
  const relative = formatRelativeTime(ts, now)
  const absolute = formatAbsoluteDateTime(ts)
  return (
    <div className="flex flex-col">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{relative || '—'}</span>
      </div>
      <div className="flex items-baseline justify-between gap-3 text-muted-foreground">
        <span>{by}</span>
        {absolute && <span className="tabular-nums">{absolute}</span>}
      </div>
    </div>
  )
}

export const BlockMetaCard = ({block}: {block: Block}): ReactNode => {
  const meta = useCardMeta(block)
  const now = useMinuteClock()
  if (!meta) {
    return <div className="text-xs text-muted-foreground">Loading…</div>
  }
  return (
    <div className="flex flex-col gap-2 text-xs">
      <MetaRow
        label="Edited"
        ts={meta.userUpdatedAt}
        now={now}
        by={<Author userId={meta.updatedBy} workspaceId={meta.workspaceId}/>}
      />
      <MetaRow
        label="Created"
        ts={meta.createdAt}
        now={now}
        by={<Author userId={meta.createdBy} workspaceId={meta.workspaceId}/>}
      />
    </div>
  )
}
