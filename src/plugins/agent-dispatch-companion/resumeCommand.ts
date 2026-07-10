/**
 * Copy Agent resume command — bridges the daemon's persisted `agent:session`
 * protocol to a terminal command a user can paste into an interactive CLI.
 */
import type { Block } from '@/data/block'
import {
  ActionContextTypes,
  type ActionConfig,
  type BlockShortcutDependencies,
  type CodeMirrorEditModeDependencies,
} from '@/shortcuts/types.js'
import { showError, showSuccess } from '@/utils/toast.js'
import { AGENT_PROPS } from './chipState.ts'

export const COPY_AGENT_RESUME_COMMAND_ACTION_ID = 'agent-dispatch.copy-resume-command'
export const EDIT_MODE_COPY_AGENT_RESUME_COMMAND_ACTION_ID = 'edit.cm.agent-dispatch.copy-resume-command'

const CODEX_SESSION_PREFIX = 'codex:'

/** Keep in sync with packages/agent-dispatch/src/engine.ts. The session is
 * copied into a shell command as an argv token, so reject anything that could
 * become an option or shell syntax. */
const SESSION_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/

type Properties = Record<string, unknown> | undefined
type ResumeExecutor = 'claude' | 'codex'

interface ParsedResumeSession {
  executor: ResumeExecutor
  id: string
}

interface ResumeOptions {
  executor: ResumeExecutor
  cwd?: string
  model?: string
}

const shellQuote = (value: string): string => {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value
  return `'${value.replace(/'/g, "'\\''")}'`
}

const formatCodexCommand = (lines: string[]): string =>
  lines.length === 1 ? lines[0]! : lines.join(' \\\n')

const parseSession = (stored: unknown): ParsedResumeSession | null => {
  if (typeof stored !== 'string' || stored.length === 0) return null
  if (stored.startsWith(CODEX_SESSION_PREFIX)) {
    const threadId = stored.slice(CODEX_SESSION_PREFIX.length)
    return SESSION_ID_SHAPE.test(threadId) ? {executor: 'codex', id: threadId} : null
  }
  return SESSION_ID_SHAPE.test(stored) ? {executor: 'claude', id: stored} : null
}

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const parseResumeOptions = (raw: unknown, executor: ResumeExecutor): ResumeOptions | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  if (record.version !== 1 || record.executor !== executor) return null
  const cwd = stringValue(record.cwd)
  const model = stringValue(record.model)
  return {executor, ...(cwd ? {cwd} : {}), ...(model ? {model} : {})}
}

const buildCodexResumeCommand = (threadId: string, options: ResumeOptions | null): string => {
  const lines = ['codex resume --include-non-interactive']
  if (options?.cwd) lines.push(`  -C ${shellQuote(options.cwd)}`)
  if (options?.model) lines.push(`  -m ${shellQuote(options.model)}`)
  lines.push(`  ${shellQuote(threadId)}`)
  return formatCodexCommand(lines)
}

export const agentResumeCommandForProperties = (properties: Properties): string | null => {
  const session = parseSession(properties?.[AGENT_PROPS.session])
  if (!session) return null

  const options = parseResumeOptions(properties?.[AGENT_PROPS.resumeOptions], session.executor)
  if (session.executor === 'codex') return buildCodexResumeCommand(session.id, options)

  const parts = ['claude', '--resume', shellQuote(session.id)]
  if (options?.model) parts.push('--model', shellQuote(options.model))
  return parts.join(' ')
}

export const copyAgentResumeCommand = async (block: Block): Promise<void> => {
  const data = await block.load()
  const command = agentResumeCommandForProperties(data?.properties)
  if (!command) {
    showError('No resumable Agent session is available for this block.')
    return
  }

  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      throw new Error('Clipboard API is unavailable')
    }
    await navigator.clipboard.writeText(command)
    showSuccess('Agent resume command copied.')
  } catch {
    showError("Couldn't copy the Agent resume command.")
  }
}

const canCopyAgentResumeCommand = ({block}: BlockShortcutDependencies): boolean => {
  const data = block.peek()
  return agentResumeCommandForProperties(data?.properties) !== null
}

const normalModeCopyResumeCommand: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: COPY_AGENT_RESUME_COMMAND_ACTION_ID,
  description: 'Copy Agent resume command',
  context: ActionContextTypes.NORMAL_MODE,
  isVisible: canCopyAgentResumeCommand,
  handler: async ({block}) => {
    await copyAgentResumeCommand(block)
  },
}

const editModeCopyResumeCommand: ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> = {
  id: EDIT_MODE_COPY_AGENT_RESUME_COMMAND_ACTION_ID,
  description: 'Copy Agent resume command',
  context: ActionContextTypes.EDIT_MODE_CM,
  isVisible: (deps: CodeMirrorEditModeDependencies) => canCopyAgentResumeCommand(deps),
  handler: async ({block}) => {
    await copyAgentResumeCommand(block)
  },
}

export const copyAgentResumeCommandActions: readonly ActionConfig[] = [
  normalModeCopyResumeCommand,
  editModeCopyResumeCommand,
]
