/** Agent task status chip — a small pill in the block's right gutter
 *  driven purely by the `agent:*` properties the agent-dispatch daemon
 *  writes (running → replied ✓ / failed ⚠). The graph is the feedback
 *  channel: props sync reactively to every device, so this needs no
 *  daemon connection — it just makes the lifecycle visible.
 *
 *  Same gutter pattern as the inline backlink count badge: with no
 *  chip, content renders untouched (no wrapper). */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { ClipboardCopy, Square } from 'lucide-react'
import type { Block } from '@/data/block'
import { useHandle } from '@/hooks/block.js'
import {
  cachedContentDecorator,
  type BlockContentDecoratorContribution,
} from '@/extensions/blockInteraction.js'
import type { BlockRenderer } from '@/types.js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { chipStateFor, chipTitle, type ChipState } from './chipState.ts'
import { clearAskedAgent, isAskedAgent, subscribeAskedAgent } from './askedStore.ts'
import { cancelAgent } from './cancelAgent.ts'
import { agentResumeCommandForProperties, copyAgentResumeCommand } from './resumeCommand.ts'

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
      {chip.cancelling ? (
        <span>{chip.executorLabel} · cancelling…</span>
      ) : (
        <>
          <span>{chip.executorLabel}{elapsed ? ` · ${elapsed}` : ''}</span>
          {chip.activity && <span className="truncate max-w-40"> · {chip.activity}</span>}
        </>
      )}
    </>
  )
}

const chipBody = (chip: ChipState) => {
  switch (chip.kind) {
    case 'queued':
      return (
        <>
          <span className="text-muted-foreground">●</span>
          <span>{chip.executorLabel}…</span>
        </>
      )
    case 'running':
      return <RunningChip chip={chip} />
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

type ChipViewState = ChipState & {
  resumeCommand: string | null
}

const AgentStatusChipMenu = ({
  chip,
  block,
}: {
  chip: ChipViewState
  block: Block
}) => {
  const canStop = chip.kind === 'running' && !chip.cancelling
  if (!chip.resumeCommand && !canStop) {
    return (
      <span
        title={chipTitle(chip)}
        data-agent-dispatch-chip={chip.kind}
        className="group mt-0.5 inline-flex h-4 shrink-0 select-none items-center gap-1 rounded-full bg-muted px-1.5 text-xs leading-none text-muted-foreground"
      >
        {chipBody(chip)}
      </span>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={chipTitle(chip)}
          aria-label={`${chip.executorLabel} task actions`}
          data-agent-dispatch-chip={chip.kind}
          onClick={event => event.stopPropagation()}
          className="group mt-0.5 inline-flex h-4 shrink-0 select-none items-center gap-1 rounded-full bg-muted px-1.5 text-xs leading-none text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {chipBody(chip)}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {chip.resumeCommand && (
          <DropdownMenuItem onSelect={() => { void copyAgentResumeCommand(block) }}>
            <ClipboardCopy className="h-4 w-4" />
            Copy resume command
          </DropdownMenuItem>
        )}
        {canStop && (
          <DropdownMenuItem onSelect={() => { void cancelAgent(block) }}>
            <Square className="h-4 w-4" />
            Stop running task
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
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
    selector: doc => {
      const properties = doc?.properties as Record<string, unknown> | undefined
      const chip = chipStateFor(properties)
      return chip ? {...chip, resumeCommand: agentResumeCommandForProperties(properties)} : null
    },
  })
  const asked = useSyncExternalStore(subscribeAskedAgent, () => isAskedAgent(block.id))

  // Real lifecycle props supersede the optimistic mark.
  useEffect(() => {
    if (propsChip) clearAskedAgent(block.id)
  }, [propsChip, block.id])

  const chip: ChipViewState | null = propsChip ?? (asked ? {...OPTIMISTIC_QUEUED, resumeCommand: null} : null)
  if (!chip) return <Inner block={block} />

  return (
    <div className="flex w-full items-start gap-1">
      <div className="min-w-0 flex-1">
        <Inner block={block} />
      </div>
      <AgentStatusChipMenu chip={chip} block={block} />
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
