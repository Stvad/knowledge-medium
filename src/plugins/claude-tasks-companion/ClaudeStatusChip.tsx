/** Claude task status chip — a small pill in the block's right gutter
 *  driven purely by the `claude:*` properties the claude-tasks daemon
 *  writes (running → replied ✓ / failed ⚠). The graph is the feedback
 *  channel: props sync reactively to every device, so this needs no
 *  daemon connection — it just makes the lifecycle visible.
 *
 *  Same gutter pattern as the inline backlink count badge: with no
 *  chip, content renders untouched (no wrapper). */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Block } from '@/data/block'
import { useHandle } from '@/hooks/block.js'
import {
  cachedContentDecorator,
  type BlockContentDecoratorContribution,
} from '@/extensions/blockInteraction.js'
import type { BlockRenderer } from '@/types.js'
import { chipStateFor, chipTitle, type ChipState } from './chipState.ts'
import { clearAskedClaude, isAskedClaude, subscribeAskedClaude } from './askedStore.ts'

/** Ticks once a second while mounted — only running chips mount it. */
const useElapsedLabel = (sinceMs: number | null): string | null => {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])
  if (sinceMs === null) return null
  const seconds = Math.max(0, Math.round((nowMs - sinceMs) / 1_000))
  if (seconds < 100) return `${seconds}s`
  return `${Math.round(seconds / 60)}m`
}

const RunningChip = ({ chip }: { chip: ChipState }) => {
  const elapsed = useElapsedLabel(chip.updatedAtMs)
  return (
    <>
      <span className="animate-pulse text-amber-600">●</span>
      <span>Claude{elapsed ? ` · ${elapsed}` : ''}</span>
    </>
  )
}

const chipBody = (chip: ChipState) => {
  switch (chip.kind) {
    case 'queued':
      return (
        <>
          <span className="text-muted-foreground">●</span>
          <span>Claude…</span>
        </>
      )
    case 'running':
      return <RunningChip chip={chip} />
    case 'done':
      return (
        <>
          <span className="text-emerald-600">✓</span>
          <span>Claude</span>
        </>
      )
    case 'error':
      return (
        <>
          <span className="text-red-600">⚠</span>
          <span>Claude</span>
        </>
      )
  }
}

/** Optimistic "queued" shown between the Ask Claude action and the
 *  daemon's claim writing real props. */
const OPTIMISTIC_QUEUED: ChipState = {kind: 'queued', updatedAtMs: null, attempts: 1, errorMessage: ''}

const ClaudeStatusChipRow = ({
  block,
  Inner,
}: {
  block: Block
  Inner: BlockRenderer
}) => {
  const propsChip = useHandle(block, {
    selector: doc => chipStateFor(doc?.properties as Record<string, unknown> | undefined),
  })
  const asked = useSyncExternalStore(subscribeAskedClaude, () => isAskedClaude(block.id))

  // Real lifecycle props supersede the optimistic mark.
  useEffect(() => {
    if (propsChip) clearAskedClaude(block.id)
  }, [propsChip, block.id])

  const chip = propsChip ?? (asked ? OPTIMISTIC_QUEUED : null)
  if (!chip) return <Inner block={block} />

  return (
    <div className="flex w-full items-start gap-1">
      <div className="min-w-0 flex-1">
        <Inner block={block} />
      </div>
      <span
        title={chipTitle(chip)}
        data-claude-chip={chip.kind}
        className="mt-0.5 inline-flex h-4 shrink-0 select-none items-center gap-1 rounded-full bg-muted px-1.5 text-xs leading-none text-muted-foreground"
      >
        {chipBody(chip)}
      </span>
    </div>
  )
}

const decorate = cachedContentDecorator(ClaudeStatusChipRow, 'WithClaudeStatusChip')

/** Chips attach everywhere except nested surfaces (embeds, backlink
 *  entries, breadcrumbs) — a status pill repeated through every embed
 *  of a mention is noise; the canonical block carries it. */
export const claudeStatusChipContribution: BlockContentDecoratorContribution = (ctx) =>
  ctx.blockContext?.isNestedSurface ? null : decorate
