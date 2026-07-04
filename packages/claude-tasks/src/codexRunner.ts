/**
 * Spawn one `codex exec` run for a task and parse its JSON result. The
 * engine is executor-agnostic (see engine.ts's runOptionsFor + `executor`
 * dispatch in daemon.ts) — this mirrors runner.ts's runClaude shape
 * (ClaudeRunOptions/ClaudeRunResult/RunEvent) so it drops into the same
 * lifecycle.
 *
 * Billing invariant: runs must hit the user's ChatGPT plan login, not
 * the OpenAI API. `codex` prefers an API key over the ChatGPT-plan OAuth
 * session when OPENAI_API_KEY / OPENAI_BASE_URL are present, so both are
 * scrubbed from the child env — the machine's `codex login` state then
 * wins.
 *
 * Permissions: `-s read-only` — no filesystem/exec beyond what the km
 * MCP server exposes. `--ignore-user-config` keeps the user's global
 * config.toml (their own MCP servers, hooks) out of daemon runs — the
 * codex analogue of claude's --strict-mcp-config.
 */
import { runJsonlProcess, type SpawnImpl } from './execProcess.js'
import { humanizeToolName } from './runner.js'
import type { ClaudeRunResult, RunEvent } from './runner.js'

export type { SpawnImpl }

/** Env vars that would redirect billing away from the ChatGPT plan login
 *  (an API key beats OAuth in codex's credential order; a proxy base
 *  URL reroutes entirely). Mirrors runner.ts's BILLING_ENV_DENYLIST. */
export const CODEX_BILLING_ENV_DENYLIST = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
] as const

export const scrubCodexEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const scrubbed = {...env}
  for (const key of CODEX_BILLING_ENV_DENYLIST) delete scrubbed[key]
  return scrubbed
}

export interface CodexMcpServer {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
}

export interface CodexRunOptions {
  codexBin: string
  prompt: string
  cwd?: string
  model?: string
  /** Resume an existing thread (thread follow-up). */
  resumeSessionId?: string
  timeoutMs: number
  env?: NodeJS.ProcessEnv
  /** Called for each parsed progress event as the run streams. Errors
   *  thrown by the handler are caught and logged — a broken consumer
   *  must never kill the run. */
  onEvent?: (event: RunEvent) => void
  /** Injected via `-c mcp_servers.<name>.*` overrides (config.toml has
   *  no --mcp-config-file equivalent this build exposes over CLI). */
  mcpServer?: CodexMcpServer
}

/** The prompt is deliberately NOT an argv element — same rationale as
 *  buildClaudeArgs: argv is `ps`-visible and ARG_MAX-capped, and note
 *  content belongs in neither failure mode. `-` (stdin) is always LAST. */
export const buildCodexArgs = (options: CodexRunOptions): string[] => {
  const args = ['exec']
  if (options.resumeSessionId) args.push('resume', options.resumeSessionId)
  args.push('--json', '-s', 'read-only', '--skip-git-repo-check', '--ignore-user-config')
  if (options.model) args.push('-m', options.model)
  if (options.mcpServer) {
    const {name, command, args: serverArgs, env} = options.mcpServer
    // -c values parse as TOML, not JSON (live-verified): a JSON array of
    // strings is coincidentally valid TOML, but a JSON object is NOT a
    // TOML map ("expected a map"), so env goes as dotted per-key
    // overrides. JSON.stringify doubles as TOML basic-string escaping
    // for the quote/backslash cases these values can contain.
    args.push('-c', `mcp_servers.${name}.command=${JSON.stringify(command)}`)
    args.push('-c', `mcp_servers.${name}.args=${JSON.stringify(serverArgs)}`)
    // Headless exec has no user to approve MCP tool calls — without
    // this, every km call dies as "user cancelled MCP tool call"
    // (live-verified). Auto-approving km mirrors the claude executor's
    // --allowedTools grant of the same tools.
    args.push('-c', `mcp_servers.${name}.default_tools_approval_mode="approve"`)
    for (const [key, value] of Object.entries(env)) {
      args.push('-c', `mcp_servers.${name}.env.${key}=${JSON.stringify(value)}`)
    }
  }
  args.push('-')
  return args
}

export interface ParsedCodexResult {
  resultText: string
  sessionId: string | null
  /** True if the run never reached turn.completed OR reached
   *  turn.failed. Named to mirror the claude parser's `isError`. */
  isError: boolean
  /** Independent flags behind isError's collapse — runCodex needs these
   *  distinct from a plain "not yet terminal" state (e.g. a timeout with
   *  no turn.failed line at all must not read as "failed with a
   *  message"). */
  sawTurnCompleted: boolean
  failed: boolean
  errorMessage: string | null
  raw: Record<string, unknown>
}

/** Line-buffered parser for `codex exec --json`. Mirrors
 *  createStreamJsonParser's shape ({feed, finish}) so runCodex composes
 *  with runJsonlProcess exactly like runClaude does.
 *
 *  Never throws: unparseable/unknown lines, events, and item types are
 *  silently skipped — the real transcript has item types (reasoning,
 *  command_execution, web_search, mcp_tool_call) we haven't observed
 *  live, and future codex versions may add more.
 *
 *  Terminal state comes from turn.completed / turn.failed, NOT from
 *  reaching end-of-stream — a `result` sentinel line doesn't exist in
 *  this protocol. */
export const createCodexJsonlParser = (onEvent?: (event: RunEvent) => void) => {
  let sessionId: string | null = null
  let resultText = ''
  let sawTurnCompleted = false
  let failed = false
  let errorMessage: string | null = null
  let lastLine: Record<string, unknown> | null = null
  let warnedOnEventError = false

  const emit = (event: RunEvent) => {
    if (!onEvent) return
    try {
      onEvent(event)
    } catch (error) {
      if (!warnedOnEventError) {
        warnedOnEventError = true
        console.warn('[claude-tasks] onEvent handler threw — ignoring:', error)
      }
    }
  }

  /** Best-effort tool name for an mcp_tool_call item — the shape wasn't
   *  observed live, so try a few plausible string fields before
   *  falling back to a generic label. */
  const mcpToolActivityLabel = (item: Record<string, unknown>): string => {
    const tool = item.tool
    if (typeof tool === 'string' && tool.length > 0) return humanizeToolName(tool)
    const name = item.name
    if (typeof name === 'string' && name.length > 0) return humanizeToolName(name)
    const server = item.server
    if (typeof server === 'string' && server.length > 0) {
      const toolField = item.toolName
      const suffix = typeof toolField === 'string' && toolField.length > 0 ? `: ${toolField}` : ''
      return `${server}${suffix}`
    }
    return 'Using a tool'
  }

  const activityForItem = (item: Record<string, unknown>) => {
    const type = item.type
    if (type === 'command_execution') emit({kind: 'activity', label: 'Running a command'})
    else if (type === 'web_search') emit({kind: 'activity', label: 'Searching the web'})
    else if (type === 'mcp_tool_call') emit({kind: 'activity', label: mcpToolActivityLabel(item)})
    else if (type === 'reasoning') emit({kind: 'activity', label: 'Thinking'})
  }

  const handleLine = (line: Record<string, unknown>) => {
    const type = line.type

    if (type === 'thread.started') {
      const id = line.thread_id
      if (typeof id === 'string') {
        sessionId = id
        emit({kind: 'session', sessionId: id})
      }
      return
    }

    if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
      const item = line.item
      if (!item || typeof item !== 'object') return
      const itemRecord = item as Record<string, unknown>
      if (type === 'item.completed' && itemRecord.type === 'agent_message') {
        const text = itemRecord.text
        // Full text, cumulative contract — a codex agent_message is
        // whole, not a delta, but re-emitting keeps the contract
        // identical to the claude parser's (each event carries the
        // full in-progress reply so far).
        if (typeof text === 'string') {
          resultText = text
          emit({kind: 'text', text: resultText})
        }
        return
      }
      activityForItem(itemRecord)
      return
    }

    if (type === 'error') {
      const message = line.message
      if (typeof message === 'string') errorMessage = message
      return
    }

    if (type === 'turn.completed') {
      sawTurnCompleted = true
      lastLine = line
      return
    }

    if (type === 'turn.failed') {
      failed = true
      lastLine = line
      const error = line.error
      if (error && typeof error === 'object') {
        const message = (error as Record<string, unknown>).message
        if (typeof message === 'string') errorMessage = message
      }
      return
    }
    // Unknown line type (e.g. turn.started) — tolerate silently.
  }

  const feedLine = (rawLine: string) => {
    const trimmed = rawLine.trim()
    if (!trimmed) return
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return
    }
    if (!parsed || typeof parsed !== 'object') return
    try {
      handleLine(parsed as Record<string, unknown>)
    } catch {
      // A malformed-but-valid-JSON line shouldn't take down the parser.
    }
  }

  let buffer = ''
  const feed = (chunk: string) => {
    buffer += chunk
    let newlineIndex: number
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      feedLine(line)
    }
  }

  const finish = (): ParsedCodexResult => {
    if (buffer.length > 0) {
      feedLine(buffer)
      buffer = ''
    }
    return {
      resultText,
      sessionId,
      isError: failed || !sawTurnCompleted,
      sawTurnCompleted,
      failed,
      errorMessage,
      raw: lastLine ?? {},
    }
  }

  return {feed, finish}
}

export const runCodex = async (
  options: CodexRunOptions,
  spawnImpl?: SpawnImpl,
): Promise<ClaudeRunResult> => {
  const args = buildCodexArgs(options)
  const parser = createCodexJsonlParser(options.onEvent)

  const {exitCode, timedOut, stderr} = await runJsonlProcess({
    bin: options.codexBin,
    args,
    prompt: options.prompt,
    cwd: options.cwd,
    env: scrubCodexEnv(options.env ?? process.env),
    timeoutMs: options.timeoutMs,
    onStdoutText: text => parser.feed(text),
    spawnImpl,
  })

  const parsed = parser.finish()
  const ok = !timedOut && exitCode === 0 && parsed.sawTurnCompleted && !parsed.failed

  // Surface a captured `error` event's message so the engine's ⚠️ reason
  // (built from stderr/resultText) has something to show even though
  // codex writes structured errors to stdout, not stderr.
  const effectiveStderr = stderr.length === 0 && parsed.errorMessage ? parsed.errorMessage : stderr

  return {
    ok,
    resultText: parsed.resultText,
    sessionId: parsed.sessionId,
    exitCode,
    timedOut,
    stderr: effectiveStderr,
    raw: parsed.raw,
  }
}
