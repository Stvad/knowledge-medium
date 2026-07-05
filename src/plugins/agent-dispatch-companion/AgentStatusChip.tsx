/** Agent task status chip — a small pill in the block's right gutter
 *  driven purely by the `agent:*` properties the agent-dispatch daemon
 *  writes (running → replied ✓ / failed ⚠). The graph is the feedback
 *  channel: props sync reactively to every device, so this needs no
 *  daemon connection — it just makes the lifecycle visible.
 *
 *  Same gutter pattern as the inline backlink count badge: with no
 *  chip, content renders untouched (no wrapper). */
import { useEffect, useState, useSyncExternalStore, type MouseEvent } from 'react'
import type { Block } from '@/data/block'
import { useHandle } from '@/hooks/block.js'
import {
  cachedContentDecorator,
  type BlockContentDecoratorContribution,
} from '@/extensions/blockInteraction.js'
import type { BlockRenderer } from '@/types.js'
import { chipStateFor, chipTitle, type ChipState } from './chipState.ts'
import { clearAskedAgent, isAskedAgent, subscribeAskedAgent } from './askedStore.ts'
import { cancelAgent } from './cancelAgent.ts'

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

const RunningChip = ({ chip, block }: { chip: ChipState; block: Block }) => {
  const elapsed = useElapsedLabel(chip.updatedAtMs)
  const onStop = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (chip.cancelling) return
    void cancelAgent(block)
  }
  return (
    <>
      <span className="animate-pulse text-amber-600">●</span>
      {chip.cancelling ? (
        <span>{chip.executorLabel} · cancelling…</span>
      ) : (
        <>
          <span>{chip.executorLabel}{elapsed ? ` · ${elapsed}` : ''}</span>
          {chip.activity && <span className="truncate max-w-40"> · {chip.activity}</span>}
          <button
            type="button"
            title={`Stop the running ${chip.executorLabel} task`}
            aria-label={`Stop the running ${chip.executorLabel} task`}
            onClick={onStop}
            className="hidden shrink-0 rounded-full leading-none text-muted-foreground hover:text-foreground group-hover:inline"
          >
            ⏹
          </button>
        </>
      )}
    </>
  )
}

const chipBody = (chip: ChipState, block: Block) => {
  switch (chip.kind) {
    case 'queued':
      return (
        <>
          <span className="text-muted-foreground">●</span>
          <span>{chip.executorLabel}…</span>
        </>
      )
    case 'running':
      return <RunningChip chip={chip} block={block} />
    case 'done':
      return (
        <>
          <span className="text-emerald-600">✓</span>
          <span>{chip.executorLabel}</span>
        </>
      )
    case 'error':
      return (
        <>
          <span className="text-red-600">⚠</span>
          <span>{chip.executorLabel}</span>
        </>
      )
  }
}

/** Optimistic "queued" shown between the Ask Agent action and the
 *  daemon's claim writing real props. */
const OPTIMISTIC_QUEUED: ChipState = {kind: 'queued', executor: 'claude', executorLabel: 'Claude', updatedAtMs: null, attempts: 1, errorMessage: '', activity: '', cancelling: false}

const AgentStatusChipRow = ({
  block,
  Inner,
}: {
  block: Block
  Inner: BlockRenderer
}) => {
  const propsChip = useHandle(block, {
    selector: doc => chipStateFor(doc?.properties as Record<string, unknown> | undefined),
  })
  const asked = useSyncExternalStore(subscribeAskedAgent, () => isAskedAgent(block.id))

  // Real lifecycle props supersede the optimistic mark.
  useEffect(() => {
    if (propsChip) clearAskedAgent(block.id)
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
        data-agent-dispatch-chip={chip.kind}
        className="group mt-0.5 inline-flex h-4 shrink-0 select-none items-center gap-1 rounded-full bg-muted px-1.5 text-xs leading-none text-muted-foreground"
      >
        {chipBody(chip, block)}
      </span>
    </div>
  )
}

const decorate = cachedContentDecorator(AgentStatusChipRow, 'WithAgentStatusChip')

/** The chip is a block-level pill in the right gutter, so it attaches on
 *  every surface that renders the block as a full row — the outline,
 *  backlink entries, and embeds — where run status is genuinely useful
 *  (a page's backlink list is exactly where you review what the daemon
 *  just picked up, and a bare mention there otherwise shows no status).
 *  It's suppressed only where the block renders as inline text or a
 *  compact path preview — an inline `((reference))` or a breadcrumb
 *  segment — because a full-width gutter row can't lay out there. */
export const agentStatusChipContribution: BlockContentDecoratorContribution = (ctx) =>
  ctx.blockContext?.isReference || ctx.blockContext?.isBreadcrumb ? null : decorate
