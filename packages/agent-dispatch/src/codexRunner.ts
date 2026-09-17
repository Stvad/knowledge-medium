/**
 * Spawn one `codex exec` run for a task and parse its JSON result. Mirrors
 * runner.ts's runClaude shape (AgentRunOptions/AgentRunResult/RunEvent) so it
 * drops into the executor-agnostic engine lifecycle.
 *
 * Billing invariant: runs must hit the user's ChatGPT plan login, not the
 * OpenAI API. `codex` prefers an API key in the env over the ChatGPT-plan
 * OAuth session, so every credential var it reads
 * (CODEX_BILLING_ENV_DENYLIST) is scrubbed from the child env and the
 * machine's `codex login` state (auth.json) wins. A key stored via `codex
 * login --with-api-key` lives in auth.json, which env scrubbing cannot
 * touch — a login-state caveat documented in the README, not fixable here.
 *
 * Permissions: Codex defaults to `-s read-only` for daemon runs; a watcher
 * can opt into `workspace-write` plus declared extra roots and network
 * access through its `runner` config. `read-only` is NOT "no shell" — codex
 * still EXECUTES model-generated shell commands, and the sandbox only
 * restricts what those commands can do, so this is a materially weaker
 * posture than the claude executor's fail-closed allowlist (README,
 * "Executors"). km MCP is the graph write path in every mode.
 * `--ignore-user-config` skips `$CODEX_HOME/config.toml` (the user's own MCP
 * servers / settings there); it does NOT keep out plugins, skills or a
 * global AGENTS.md declared outside config.toml, so it is a weaker analogue
 * of claude's --strict-mcp-config rather than an equivalent.
 */
import { runJsonlProcess, type SpawnImpl } from './execProcess.js'
import { envForBilling, humanizeToolName } from './runner.js'
import type { AgentRunResult, CommonRunOptions, RunEvent } from './runner.js'
import type { CodexApprovalPolicy, CodexApprovalsReviewer, CodexSandbox } from './config.js'

export type { SpawnImpl }

/** Env vars that would redirect billing away from the ChatGPT plan login:
 *  codex's credential order reads any of these before falling back to the
 *  OAuth session in auth.json, and a base URL reroutes the API target
 *  outright. Mirrors runner.ts's BILLING_ENV_DENYLIST intent. */
export const CODEX_BILLING_ENV_DENYLIST = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
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

export interface CodexRunOptions extends CommonRunOptions {
  codexBin: string
  sandbox?: CodexSandbox
  addDirs?: string[]
  networkAccess?: boolean
  approvalPolicy?: CodexApprovalPolicy
  approvalsReviewer?: CodexApprovalsReviewer
  /** Injected via `-c mcp_servers.<name>.*` overrides (config.toml has
   *  no --mcp-config-file equivalent this build exposes over CLI). */
  mcpServer?: CodexMcpServer
}

/** The prompt is deliberately NOT an argv element — same rationale as
 *  buildClaudeArgs. `-` (stdin) is always LAST. */
export const buildCodexArgs = (options: CodexRunOptions): string[] => {
  const args = ['exec']
  args.push('--json', '-s', options.sandbox ?? 'read-only', '--skip-git-repo-check', '--ignore-user-config')
  for (const dir of options.addDirs ?? []) args.push('--add-dir', dir)
  if (options.networkAccess) args.push('-c', 'sandbox_workspace_write.network_access=true')
  if (options.approvalPolicy === 'on-request' && options.approvalsReviewer === 'auto_review') {
    args.push('-c', 'approval_policy="on-request"')
    args.push('-c', 'approvals_reviewer="auto_review"')
  }
  if (options.model) args.push('-m', options.model)
  if (options.mcpServer) {
    const {name, command, args: serverArgs, env} = options.mcpServer
    // -c values parse as TOML, not JSON: a JSON array of strings is
    // coincidentally valid TOML, but a JSON object is NOT a TOML map
    // ("expected a map"), so env goes as dotted per-key overrides.
    // JSON.stringify doubles as TOML basic-string escaping for the
    // quote/backslash cases these values can contain.
    args.push('-c', `mcp_servers.${name}.command=${JSON.stringify(command)}`)
    args.push('-c', `mcp_servers.${name}.args=${JSON.stringify(serverArgs)}`)
    // Headless exec has no user to approve MCP tool calls — without this,
    // every km call dies as "user cancelled MCP tool call". Auto-approving
    // km mirrors the claude executor's --allowedTools grant of the same
    // tools.
    args.push('-c', `mcp_servers.${name}.default_tools_approval_mode="approve"`)
    for (const [key, value] of Object.entries(env)) {
      args.push('-c', `mcp_servers.${name}.env.${key}=${JSON.stringify(value)}`)
    }
  }
  if (options.resumeSessionId) args.push('resume', options.resumeSessionId)
  args.push('-')
  return args
}

export interface ParsedCodexResult {
  resultText: string
  sessionId: string | null
  /** Terminal state comes from two INDEPENDENT flags, not one collapsed
   *  error boolean: runCodex derives ok = sawTurnCompleted && !failed, and
   *  needs them distinct so a plain "not yet terminal" state (e.g. a
   *  timeout with no turn.failed line at all) doesn't read as "failed with
   *  a message". */
  sawTurnCompleted: boolean
  failed: boolean
  errorMessage: string | null
  raw: Record<string, unknown>
}

/** Line-buffered parser for `codex exec --json`. Mirrors
 *  createStreamJsonParser's shape ({feed, finish}) so runCodex composes
 *  with runJsonlProcess exactly like runClaude does.
 *
 *  Never throws: unparseable or unknown lines, events and item types are
 *  silently skipped, since the transcript carries item types this parser has
 *  no branch for and codex can add more.
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
        console.warn('[agent-dispatch] onEvent handler threw — ignoring:', error)
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
        // A codex agent_message is a whole message, not a delta. A turn
        // usually emits one, but can emit several (interleaved with
        // reasoning) — accumulate them so an earlier message isn't lost,
        // then re-emit the running text (the cumulative contract the
        // engine's streamReply consumer expects, same as the claude
        // parser's).
        if (typeof text === 'string' && text.length > 0) {
          resultText = resultText ? `${resultText}\n\n${text}` : text
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
): Promise<AgentRunResult> => {
  const args = buildCodexArgs(options)
  const parser = createCodexJsonlParser(options.onEvent)

  const {exitCode, timedOut, stderr} = await runJsonlProcess({
    bin: options.codexBin,
    args,
    prompt: options.prompt,
    cwd: options.cwd,
    env: envForBilling(options.env ?? process.env, options.billing, scrubCodexEnv),
    timeoutMs: options.timeoutMs,
    onStdoutText: text => parser.feed(text),
    signal: options.signal,
    spawnImpl,
  })

  const parsed = parser.finish()
  const ok = !timedOut && exitCode === 0 && parsed.sawTurnCompleted && !parsed.failed

  // Surface a captured `error`/`turn.failed` message so the engine's ⚠️
  // reason (built from stderr/resultText) shows the real cause — codex
  // writes structured errors to stdout, not stderr, and its stderr often
  // carries unrelated warnings/update notices that would otherwise mask
  // the actual failure. Prefer the structured message whenever we have
  // one, keeping any stderr as secondary context.
  const effectiveStderr = parsed.errorMessage
    ? (stderr.trim() ? `${parsed.errorMessage}\n${stderr}` : parsed.errorMessage)
    : stderr

  return {
    ok,
    resultText: parsed.resultText,
    sessionId: parsed.sessionId,
    exitCode,
    timedOut,
    stderr: effectiveStderr,
    // Only the STRUCTURED error (error / turn.failed) — never resultText,
    // which for codex accumulates agent messages, i.e. the assistant's own
    // words. See runFailure.ts on why that separation matters.
    failureText: ok ? '' : (parsed.errorMessage ?? ''),
    raw: parsed.raw,
  }
}
