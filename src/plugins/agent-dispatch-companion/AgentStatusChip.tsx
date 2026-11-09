/** Agent task status chip — a small pill in the block's right gutter
 *  driven purely by the `agent:*` properties the agent-dispatch daemon
 *  writes (running → replied ✓ / failed ⚠). The graph is the feedback
 *  channel: props sync reactively to every device, so this needs no
 *  daemon connection — it just makes the lifecycle visible.
 *
 *  A top-right gutter item: `BlockGutterHost` places it, and with no chip
 *  the item renders null. */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ClipboardCopy, Square } from 'lucide-react'
import type { Block } from '@/data/block'
import { useHandle } from '@/hooks/block.js'
import type {
  BlockGutterItem,
  BlockGutterItemContribution,
} from '@/extensions/blockInteraction.js'
import type { BlockRenderer } from '@/types.js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { chipStateFor, chipTitle, elapsedLabel, type ChipState } from './chipState.ts'
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
  return elapsedLabel(Math.max(0, Math.round((nowMs - sinceMs) / 1_000)))
}

/** One width for every state and every tick: the pill sits in the block's
 *  gutter, so any change in its width re-wraps the block's text. Anything
 *  variable (the run's activity, a long executor name) goes in the title and
 *  the menu. */
const CHIP_CLASS = 'group inline-flex h-4 w-24 shrink-0 select-none items-center gap-1 rounded-full bg-muted px-1 text-xs leading-none text-muted-foreground'

const ChipLabel = ({children}: {children: ReactNode}) => (
  <span className="min-w-0 flex-1 truncate text-left leading-4">{children}</span>
)

const RunningChip = ({ chip }: { chip: ChipState }) => {
  const elapsed = useElapsedLabel(chip.updatedAtMs)
  return (
    <>
      <span className="animate-pulse text-amber-600">●</span>
      {chip.cancelling ? (
        <ChipLabel>cancelling…</ChipLabel>
      ) : (
        <>
          <ChipLabel>{chip.executorLabel}</ChipLabel>
          {elapsed && <span className="shrink-0 tabular-nums">{elapsed}</span>}
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
          <ChipLabel>{chip.executorLabel}…</ChipLabel>
        </>
      )
    case 'running':
      return <RunningChip chip={chip} />
    case 'done':
      return (
        <>
          <span className="text-emerald-600">✓</span>
          <ChipLabel>{chip.executorLabel}</ChipLabel>
        </>
      )
    case 'error':
      return (
        <>
          <span className="text-red-600">⚠</span>
          <ChipLabel>{chip.executorLabel}</ChipLabel>
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
        className={CHIP_CLASS}
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
          className={`${CHIP_CLASS} hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
        >
          {chipBody(chip)}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {canStop && chip.activity && (
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            {chip.activity}
          </DropdownMenuLabel>
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

const AgentStatusChipItem: BlockRenderer = ({block}) => {
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
  if (!chip) return null

  return <AgentStatusChipMenu chip={chip} block={block} />
}

const statusChipItem: BlockGutterItem = {corner: 'top-right', component: AgentStatusChipItem}

/** On every surface that renders the block as a full row — the outline,
 *  backlink entries, and embeds — where run status is genuinely useful (a
 *  page's backlink list is exactly where you review what the daemon just
 *  picked up, and a bare mention there otherwise shows no status). Inline
 *  references and breadcrumbs get no gutter at all (`BlockGutterHost`). */
export const agentStatusChipContribution: BlockGutterItemContribution = () => statusChipItem
