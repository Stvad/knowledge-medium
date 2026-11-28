/** Agent task status chip — a small pill in the block's right gutter
 *  driven purely by the `agent:*` properties the agent-dispatch daemon
 *  writes (running → replied ✓ / failed ⚠). The graph is the feedback
 *  channel: props sync reactively to every device, so this needs no
 *  daemon connection — it just makes the lifecycle visible.
 *
 *  A top-right gutter item: `BlockGutterHost` places it, and with no chip
 *  the item renders null. */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ClipboardCopy, RotateCcw, Square } from 'lucide-react'
import type { Block } from '@/data/block'
import { useHandle } from '@/hooks/block.js'
import { useIsReadOnly } from '@/hooks/useIsReadOnly.js'
import type {
  BlockGutterItem,
  BlockGutterItemContribution,
} from '@/extensions/blockInteraction.js'
import type { BlockRenderer } from '@/types.js'
import { GUTTER_PILL_CLASS } from '@/components/GutterPill.js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { showError } from '@/utils/toast.js'
import { AGENT_PROPS, activityStateFor, chipActivityDetails, chipStateFor, chipTitle, compactActivityLabel, type ActivityState, type ChipState } from './chipState.ts'
import { clearAskedAgent, isAskedAgent, subscribeAskedAgent } from './askedStore.ts'
import { cancelAgent } from './cancelAgent.ts'
import { agentResumeCommandForProperties, copyAgentResumeCommand } from './resumeCommand.ts'
import { hasLegacyMentionReply, retryAgent, retrySourceFor, type RetrySource } from './retryAgent.ts'

/** One clock serves the elapsed run time and activity age. */
const useRunningClock = (running: boolean): number => {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNowMs(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [running])
  return nowMs
}

/** Keep every lifecycle state the same width so age and warning changes never rewrap the gutter. */
const CHIP_CLASS = `group ${GUTTER_PILL_CLASS} w-24 gap-0.5 bg-muted px-1 text-muted-foreground`

const ChipLabel = ({children}: {children: ReactNode}) => (
  <span className="min-w-0 flex-1 truncate text-left leading-4">{children}</span>
)

const RunningChip = ({ chip, activity }: { chip: ChipState; activity: ActivityState | null }) => {
  return (
    <>
      <span className={activity?.stalled ? 'text-amber-600' : 'animate-pulse text-amber-600'}>{activity?.stalled ? '⚠' : '●'}</span>
      {chip.cancelling ? (
        <ChipLabel>cancelling…</ChipLabel>
      ) : (
        <>
          <ChipLabel>{compactActivityLabel(chip.activity)}</ChipLabel>
          {activity?.ageLabel && <span className="shrink-0 tabular-nums">{activity.ageLabel}</span>}
        </>
      )}
    </>
  )
}

const chipBody = (chip: ChipState, activity: ActivityState | null, retryPending: boolean) => {
  switch (chip.kind) {
    case 'queued':
      return (
        <>
          <span className="text-muted-foreground">●</span>
          <ChipLabel>{chip.executorLabel}…</ChipLabel>
        </>
      )
    case 'running':
      return <RunningChip chip={chip} activity={activity} />
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
          <ChipLabel>{retryPending ? 'Retry pending' : chip.executorLabel}</ChipLabel>
        </>
      )
  }
}

type ChipViewState = ChipState & {
  resumeCommand: string | null
  retrySource: RetrySource | null
  retryRequested: boolean
}

type ChipMenuProps = {chip: ChipViewState; block: Block}

const AgentStatusChipMenu = ({
  chip,
  block,
  supportsRetry,
}: ChipMenuProps & {supportsRetry: boolean}) => {
  const nowMs = useRunningClock(chip.kind === 'running' && !chip.cancelling)
  const activity = activityStateFor(chip, nowMs)
  const statusTitle = chipTitle(chip, activity, nowMs)
  const retryPending = supportsRetry && chip.retryRequested
  const title = retryPending ? `${statusTitle} · Retry requested` : statusTitle
  const className = `${CHIP_CLASS}${activity?.stalled ? ' text-amber-700 dark:text-amber-400 ring-1 ring-amber-500' : ''}`
  const readOnly = useIsReadOnly(block.repo)
  const canRetry = supportsRetry && !retryPending && !readOnly
  const canStop = chip.kind === 'running' && !chip.cancelling
  if (!chip.resumeCommand && !canStop && !canRetry) {
    return (
      <span
        title={title}
        data-agent-dispatch-chip={chip.kind}
        className={className}
      >
        {chipBody(chip, activity, retryPending)}
      </span>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={title}
          aria-label={`${title}; task actions`}
          data-agent-dispatch-chip={chip.kind}
          onClick={event => event.stopPropagation()}
          className={`${className} hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
        >
          {chipBody(chip, activity, retryPending)}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {canStop && (
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            {chip.executorLabel} · {chipActivityDetails(chip, activity, nowMs)}
          </DropdownMenuLabel>
        )}
        {canRetry && (
          <DropdownMenuItem onSelect={() => {
            void retryAgent(block).catch(() => showError("Couldn't request the Agent retry."))
          }}>
            <RotateCcw className="h-4 w-4" />
            Retry
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
            Stop running task
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const LegacyAgentStatusChipMenu = ({chip, block, replyKey}: ChipMenuProps & {replyKey: string}) => {
  const supportsRetry = useHandle(block.repo.query.children({id: block.id, propertyChildren: 'none'}), {
    selector: children => hasLegacyMentionReply(children, replyKey),
  })
  return <AgentStatusChipMenu chip={chip} block={block} supportsRetry={supportsRetry} />
}

/** Optimistic "queued" shown between the Ask Agent action and the
 *  daemon's claim writing real props. */
const OPTIMISTIC_QUEUED: ChipViewState = {kind: 'queued', executor: 'claude', executorLabel: 'Claude', updatedAtMs: null, attempts: 1, errorMessage: '', activity: '', activityAtMs: null, cancelling: false, resumeCommand: null, retrySource: null, retryRequested: false}

const AgentStatusChipItem: BlockRenderer = ({block}) => {
  const propsChip = useHandle(block, {
    selector: doc => {
      const properties = doc?.properties
      const chip = chipStateFor(properties)
      if (!chip) return null
      const retryAt = properties?.[AGENT_PROPS.retryAt]
      return {
        ...chip,
        resumeCommand: agentResumeCommandForProperties(properties),
        retrySource: retrySourceFor(doc),
        retryRequested: chip.kind === 'error' && typeof retryAt === 'number' && Number.isFinite(retryAt) && retryAt > 0,
      }
    },
  })
  const asked = useSyncExternalStore(subscribeAskedAgent, () => isAskedAgent(block.id))

  // Real lifecycle props supersede the optimistic mark.
  useEffect(() => {
    if (propsChip) clearAskedAgent(block.id)
  }, [propsChip, block.id])

  const chip = propsChip ?? (asked ? OPTIMISTIC_QUEUED : null)
  if (!chip) return null

  if (chip.retrySource?.kind === 'legacy') {
    return <LegacyAgentStatusChipMenu chip={chip} block={block} replyKey={chip.retrySource.replyKey} />
  }
  return <AgentStatusChipMenu key={`${chip.kind}:${chip.cancelling}`} chip={chip} block={block} supportsRetry={chip.retrySource?.kind === 'mention'} />
}

const statusChipItem: BlockGutterItem = {corner: 'top-right', component: AgentStatusChipItem}

/** On every surface that renders the block as a full row — the outline,
 *  backlink entries, and embeds — where run status is genuinely useful (a
 *  page's backlink list is exactly where you review what the daemon just
 *  picked up, and a bare mention there otherwise shows no status). Inline
 *  references and breadcrumbs get no gutter at all (`BlockGutterHost`). */
export const agentStatusChipContribution: BlockGutterItemContribution = () => statusChipItem
