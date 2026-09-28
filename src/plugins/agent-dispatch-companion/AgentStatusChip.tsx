/** Agent task status chip — a small pill in the block's right gutter
 *  driven purely by the `agent:*` properties the agent-dispatch daemon
 *  writes (running → replied ✓ / failed ⚠). The graph is the feedback
 *  channel: props sync reactively to every device, so this needs no
 *  daemon connection — it just makes the lifecycle visible.
 *
 *  Same gutter pattern as the inline backlink count badge: with no
 *  chip, content renders untouched (no wrapper). */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { ClipboardCopy, RotateCcw, Square } from 'lucide-react'
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
import { chipStateFor, chipTitle, isDeferredRetry, type ChipState } from './chipState.ts'
import { clearAskedAgent, isAskedAgent, subscribeAskedAgent } from './askedStore.ts'
import { cancelAgent } from './cancelAgent.ts'
import { retryAgentTask } from './retryAgent.ts'
import { agentResumeCommandForProperties, copyAgentResumeCommand } from './resumeCommand.ts'

/** Ticks once a second while mounted — only the chips with a live clock
 *  (running, waiting to retry) mount it. */
const useNowTick = (): number => {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])
  return nowMs
}

const durationLabel = (seconds: number): string =>
  seconds < 100 ? `${seconds}s` : `${Math.round(seconds / 60)}m`

const RunningChip = ({ chip }: { chip: ChipState }) => {
  const nowMs = useNowTick()
  const elapsed = chip.updatedAtMs === null
    ? null
    : durationLabel(Math.max(0, Math.round((nowMs - chip.updatedAtMs) / 1_000)))
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

/** A task the daemon could not even attempt (out of credits, expired
 *  login, network) and will re-run by itself. Distinct from a plain
 *  "queued" chip on purpose: nothing is wrong with the task, and the user
 *  needs to see that a clock — not a person — is what it's waiting on. */
const DeferredChip = ({ chip }: { chip: ChipState }) => {
  const nowMs = useNowTick()
  const remaining = Math.round(((chip.retryAfterMs ?? 0) - nowMs) / 1_000)
  return (
    <>
      <span className="text-amber-600">⏳</span>
      <span>{chip.executorLabel} · {remaining > 0 ? `retry in ${durationLabel(remaining)}` : 'retrying…'}</span>
    </>
  )
}

const chipBody = (chip: ChipState) => {
  switch (chip.kind) {
    case 'queued':
      if (isDeferredRetry(chip)) return <DeferredChip chip={chip} />
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
  const deferred = isDeferredRetry(chip)
  // Stop covers both "kill the child" (running) and "stop waiting to
  // retry" (deferred) — the daemon honors agent:cancel for each.
  const canStop = (chip.kind === 'running' && !chip.cancelling) || deferred
  // A failed task retries on demand; a deferred one is already retrying,
  // so the offer is to skip its wait.
  const canRetry = chip.kind === 'error' || deferred
  if (!chip.resumeCommand && !canStop && !canRetry) {
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
        {canRetry && (
          <DropdownMenuItem onSelect={() => { void retryAgentTask(block) }}>
            <RotateCcw className="h-4 w-4" />
            {deferred ? 'Retry now' : 'Retry task'}
          </DropdownMenuItem>
        )}
        {chip.resumeCommand && (
          <DropdownMenuItem onSelect={() => { void copyAgentResumeCommand(block) }}>
            <ClipboardCopy className="h-4 w-4" />
            Copy resume command
          </DropdownMenuItem>
        )}
        {canStop && (
          <DropdownMenuItem onSelect={() => { void cancelAgent(block) }}>
            <Square className="h-4 w-4" />
            {deferred ? 'Stop retrying' : 'Stop running task'}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Optimistic "queued" shown between the Ask Agent action and the
 *  daemon's claim writing real props. */
const OPTIMISTIC_QUEUED: ChipState = {kind: 'queued', executor: 'claude', executorLabel: 'Claude', updatedAtMs: null, attempts: 1, errorMessage: '', activity: '', cancelling: false, retryAfterMs: null}

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
