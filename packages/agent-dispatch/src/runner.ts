/**
 * Spawn one `claude -p` run for a task and parse its JSON result.
 *
 * Billing: by default runs must hit the user's Claude subscription, not
 * the API. `claude` prefers ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
 * over subscription OAuth when they're present, so both are scrubbed
 * from the child env — the machine's `claude login` state then wins.
 * Opt into usage-based billing per config (`billing: 'api'`), which
 * skips the scrub (see config.ts + AgentRunOptions.billing).
 *
 * Each live run checks the CLI's startup tool and MCP inventories
 * before accepting progress or a result.
 */
import { runJsonlProcess, type SpawnImpl } from './execProcess.js'
import type { ClaudeEffort, CodexApprovalPolicy, CodexApprovalsReviewer, CodexSandbox } from './config.js'

export const THINKING_ACTIVITY = 'Thinking'

/** Progress observed while a run is in flight — fed to `onEvent` as the
 *  stream-json transcript arrives. `text` is CUMULATIVE: each event
 *  carries the full in-progress reply text so far, not a delta, which
 *  keeps consumers (graph writes, UI) idempotent no matter which event
 *  they last saw. */
export type RunEvent =
  | {kind: 'session', sessionId: string}
  | {kind: 'activity', label: string, stepId: string}
  | {kind: 'activity-end', stepId: string}
  | {kind: 'text', text: string}

/** What the engine sets for a run whichever executor it dispatches to.
 *  Declared once so the two executors' option types cannot drift. */
export interface CommonRunOptions {
  prompt: string
  cwd?: string
  model?: string
  timeoutMs: number
  env?: NodeJS.ProcessEnv
  /** Resume an existing session/thread (a follow-up in the same thread). */
  resumeSessionId?: string
  /** Billing mode (config.ts). 'api' skips the env scrub so the run can
   *  use usage-based credentials; anything else (incl. undefined) scrubs
   *  — the safe default, so a missing value never accidentally bills the
   *  API. */
  billing?: 'subscription' | 'api'
  /** Called for each parsed progress event as the run streams. Errors
   *  thrown by the handler are caught and logged — a broken consumer
   *  must never kill the run. */
  onEvent?: (event: RunEvent) => void
  /** Abort the in-flight run (UI Stop). The engine holds the controller
   *  and reads `signal.aborted` after the run to tell a cancel apart from
   *  a timeout/crash. */
  signal?: AbortSignal
}

export interface AgentRunOptions extends CommonRunOptions {
  claudeBin: string
  allowedTools: string[]
  effort?: ClaudeEffort
  mcpConfig?: {path: string, serverNames: readonly string[]}
  /** Which CLI the engine should dispatch this run to (daemon.ts's
   *  runTask wiring); the engine itself stays executor-agnostic — this
   *  field just rides along with the rest of the run options. */
  executor?: 'claude' | 'codex'
  codexSandbox?: CodexSandbox
  codexAddDirs?: string[]
  codexNetworkAccess?: boolean
  codexApprovalPolicy?: CodexApprovalPolicy
  codexApprovalsReviewer?: CodexApprovalsReviewer
}

export interface AgentRunResult {
  ok: boolean
  /** Final assistant text — what gets posted as the reply block. */
  resultText: string
  sessionId: string | null
  exitCode: number | null
  timedOut: boolean
  stderr: string
  /** Parsed --output-format json envelope (null if unparseable). */
  raw: Record<string, unknown> | null
  /** Token counts summed over every request of the run; null when the
   *  executor reported none (a crash or timeout before its final line). */
  usage: RunUsage | null
}

export interface RunUsage {
  /** Input billed at the full rate: neither read from nor written to the cache. */
  inputTokens: number
  cacheReadTokens: number
  /** null for an executor that doesn't report cache writes (codex). */
  cacheWriteTokens: number | null
  outputTokens: number
}

/** A token count off an executor's usage object; 0 for a missing field. */
export const tokenCount = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object'

/** The run's usage from a claude `result` line. `modelUsage` totals the whole
 *  process, every model and subagent; `usage` covers only the turn that line
 *  ends, and a run that waits on a background subagent has one per turn. */
export const claudeUsageFrom = (raw: Record<string, unknown> | null): RunUsage | null => {
  if (isRecord(raw?.modelUsage)) {
    const perModel = Object.values(raw.modelUsage).filter(isRecord)
    const sum = (key: string) => perModel.reduce((total, counts) => total + tokenCount(counts[key]), 0)
    return {
      inputTokens: sum('inputTokens'),
      cacheReadTokens: sum('cacheReadInputTokens'),
      cacheWriteTokens: sum('cacheCreationInputTokens'),
      outputTokens: sum('outputTokens'),
    }
  }
  if (!isRecord(raw?.usage)) return null
  const counts = raw.usage
  return {
    inputTokens: tokenCount(counts.input_tokens),
    cacheReadTokens: tokenCount(counts.cache_read_input_tokens),
    cacheWriteTokens: tokenCount(counts.cache_creation_input_tokens),
    outputTokens: tokenCount(counts.output_tokens),
  }
}

const compactCount = (count: number): string =>
  count >= 1_000_000 ? `${(count / 1_000_000).toFixed(1)}M`
    : count >= 1_000 ? `${(count / 1_000).toFixed(1)}k`
      : String(count)

export const formatRunUsage = (usage: RunUsage): string => [
  `tokens: in ${compactCount(usage.inputTokens)}`,
  `cache read ${compactCount(usage.cacheReadTokens)}`,
  ...(usage.cacheWriteTokens === null ? [] : [`cache write ${compactCount(usage.cacheWriteTokens)}`]),
  `out ${compactCount(usage.outputTokens)}`,
].join(' · ')

/** Env vars that would redirect billing away from the subscription
 *  (API key / bearer token beat OAuth in claude's credential order;
 *  the cloud-provider switches and a proxy base URL reroute entirely).
 *  User settings are excluded. Trusted project/local or managed settings
 *  can still configure credentials outside the inherited environment. */
export const BILLING_ENV_DENYLIST = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const

export const scrubEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const scrubbed = {...env}
  for (const key of BILLING_ENV_DENYLIST) delete scrubbed[key]
  return scrubbed
}

/** Resolve the child env for a given billing mode. 'api' passes the env
 *  through (usage-based billing opted in); anything else scrubs. Fails
 *  SAFE — only an explicit 'api' skips the scrub. */
export const envForBilling = (
  env: NodeJS.ProcessEnv,
  billing: 'subscription' | 'api' | undefined,
  scrub: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv = scrubEnv,
): NodeJS.ProcessEnv => (billing === 'api' ? {...env} : scrub(env))

// Claude accepts comma- and whitespace-separated names in a --tools value.
// Separators inside permission arguments must never produce additional names.
const splitToolNames = (value: string): string[] => {
  const names: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (char === '(') depth++
    else if (char === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0 && /[\s,]/.test(char)) {
      if (i > start) names.push(value.slice(start, i))
      start = i + 1
    }
  }
  if (start < value.length) names.push(value.slice(start))
  return names
}

/** A single permission rule such as Bash(git *) offers its built-in by name.
 *  MCP namespaces come exclusively from the generated server configuration. */
const builtInToolsAllowed = (allowedTools: readonly string[]): string[] => [
  ...new Set(allowedTools
    .flatMap(rule => splitToolNames(rule.trim().replace(/\(.*\)$/, '')))
    .filter(name => !name.startsWith('mcp__'))),
]

/** The prompt is deliberately NOT an argv element — it goes via stdin
 *  (claude -p reads stdin when no prompt argument is given). Argv is
 *  visible to every local process in `ps` and capped by ARG_MAX; note
 *  content belongs in neither failure mode. */
export const buildClaudeArgs = (options: AgentRunOptions): string[] => {
  // stream-json in print mode requires --verbose; --include-partial-
  // messages turns on the incremental stream_event lines (below) so
  // activity/text can be reported before the run finishes.
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--setting-sources', 'project,local', '--strict-mcp-config',
  ]
  if (options.resumeSessionId) args.push('--resume', options.resumeSessionId)
  if (options.model) args.push('--model', options.model)
  if (options.effort) args.push('--effort', options.effort)
  if (options.mcpConfig) args.push('--mcp-config', options.mcpConfig.path)
  // Settings scope and --tools reduce what Claude loads. Its init inventory
  // is checked independently because plugins can register additional tools.
  // Skill also needs slash commands enabled.
  const offeredTools = builtInToolsAllowed(options.allowedTools)
  if (!offeredTools.includes('Skill')) args.push('--disable-slash-commands')
  args.push('--tools', offeredTools.join(','))
  if (options.allowedTools.length > 0) {
    args.push('--allowedTools', options.allowedTools.join(','))
  }
  return args
}

const startupHookEvents: ReadonlySet<unknown> = new Set(['hook_started', 'hook_progress', 'hook_response'])

interface ClaudeToolSet {
  builtIns: readonly string[]
  serverNames: readonly string[]
}

export const unexpectedClaudeInventory = (init: Record<string, unknown>, intended: ClaudeToolSet): string[] => {
  const extras: string[] = []
  if (!Array.isArray(init.tools)) extras.push('missing or malformed tools list')
  else for (const tool of init.tools) {
    if (typeof tool !== 'string') extras.push('malformed tool name')
    else if (!intended.builtIns.includes(tool) && !intended.serverNames.some(name => tool.startsWith(`mcp__${name}__`))) {
      extras.push(`tool ${tool}`)
    }
  }
  if (!Array.isArray(init.mcp_servers)) extras.push('missing or malformed mcp_servers list')
  else for (const server of init.mcp_servers) {
    if (!isRecord(server) || typeof server.name !== 'string') extras.push('malformed MCP server')
    else if (!intended.serverNames.includes(server.name) || server.source !== 'dynamic') {
      extras.push(`MCP server ${server.name} (expected a configured server with dynamic source)`)
    }
  }
  return extras
}

/** Humanize a tool name for the `activity` event — this is what a user
 *  sees in the status chip while a run is in flight, so it should read
 *  as an action, not a raw tool identifier. Exported for codexRunner.ts,
 *  which maps its own tool-shaped fields through the same km rules. */
export const humanizeToolName = (name: string): string => {
  if (name === 'WebSearch') return 'Searching the web'
  if (name === 'WebFetch') return 'Fetching a page'
  const kmMatch = /^mcp__km__(.+)$/.exec(name)
  if (kmMatch) return `km: ${kmMatch[1]}`
  return name
}

export interface ParsedClaudeResult {
  resultText: string
  sessionId: string | null
  isError: boolean
  raw: Record<string, unknown>
}

/** Line-buffered parser for `--output-format stream-json` (with
 *  `--include-partial-messages`). Feed raw stdout chunks — they may
 *  split mid-line — and read back progress via `onEvent`; call
 *  `finish()` once the child exits to get the terminal result (from the
 *  `type: "result"` line) and flush any trailing unterminated line.
 *
 *  Never throws: unparseable/unknown lines and events are silently
 *  skipped, and `onEvent` dispatch is wrapped so a broken consumer can't
 *  kill the run. */
export const createStreamJsonParser = (onEvent?: (event: RunEvent) => void, intended?: ClaudeToolSet) => {
  let initPassed = false
  let refusal: string | null = null
  let buffer = ''
  let result: ParsedClaudeResult | null = null
  let textAccumulator = ''
  let warnedOnEventError = false
  // Captured from the `system/init` line, which arrives BEFORE any
  // `result` line. On a timeout/crash there is no result line, so this is
  // the only way to recover the (billed, possibly long) session id for a
  // retry to `--resume` — mirrors the codex parser retaining thread.started.
  let initSessionId: string | null = null

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

  const activityForToolUse = (toolUse: Record<string, unknown>) => {
    const {id, name} = toolUse
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) return
    emit({kind: 'activity', label: humanizeToolName(name), stepId: id})
  }

  const handleLine = (line: Record<string, unknown>) => {
    const type = line.type

    if (type === 'system' && line.subtype === 'init') {
      const sessionId = line.session_id
      if (typeof sessionId === 'string') {
        initSessionId = sessionId
        emit({kind: 'session', sessionId})
      }
      return
    }

    if (type === 'user' || type === 'assistant') {
      const message = line.message as {content?: unknown} | undefined
      const content = Array.isArray(message?.content) ? message?.content : []
      if (type === 'user') {
        for (const item of content) {
          if (isRecord(item) && item.type === 'tool_result' && typeof item.tool_use_id === 'string' && item.tool_use_id.length > 0) {
            emit({kind: 'activity-end', stepId: item.tool_use_id})
          }
        }
        return
      }
      // Concatenate ALL text blocks in this finalized message (a single
      // message can carry more than one — e.g. a web-search turn is
      // [text, server_tool_use, web_search_result, text]), matching how
      // the content_block_delta path accumulates them with no separator.
      let messageText = ''
      for (const item of content ?? []) {
        if (!item || typeof item !== 'object') continue
        const block = item as Record<string, unknown>
        if (block.type === 'tool_use') {
          activityForToolUse(block)
        } else if (block.type === 'text' && typeof block.text === 'string') {
          messageText += block.text
        }
      }
      // The finalized summary must only ADVANCE the cumulative text, never
      // rewrite it backwards: the partial-message deltas (always on) have
      // already built the full running text, and re-emitting per-block would
      // SHRINK it, the last block superseding the whole. Adopting the summary
      // only when it is longer covers the rare case where deltas didn't fire
      // without losing streamed text on a multi-text-block message.
      if (messageText.length > textAccumulator.length) {
        textAccumulator = messageText
        emit({kind: 'text', text: textAccumulator})
      }
      return
    }

    if (type === 'stream_event') {
      const streamEvent = line.event as Record<string, unknown> | undefined
      if (!streamEvent) return
      const eventType = streamEvent.type

      if (eventType === 'message_start') {
        textAccumulator = ''
        return
      }
      if (eventType === 'content_block_delta') {
        const delta = streamEvent.delta as Record<string, unknown> | undefined
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          textAccumulator += delta.text
          emit({kind: 'text', text: textAccumulator})
        }
        return
      }
      return
    }

    if (type === 'result') {
      result = {
        resultText: typeof line.result === 'string' ? line.result : '',
        sessionId: typeof line.session_id === 'string' ? line.session_id : null,
        isError: line.is_error === true,
        raw: line,
      }
      return
    }
    // Unknown line type — tolerate silently.
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
    if (!isRecord(parsed)) return
    if (intended) {
      // SessionStart hooks can report progress before Claude publishes its inventory.
      if (parsed.type === 'system' && startupHookEvents.has(parsed.subtype)) return
      if (parsed.type === 'system' && parsed.subtype === 'init') {
        const extras = unexpectedClaudeInventory(parsed, intended)
        if (extras.length) {
          refusal = `Unexpected Claude init inventory: ${extras.join(', ')}`
          return
        }
        initPassed = true
      } else if (!initPassed) {
        refusal = 'Claude emitted a stream event before a validated init'
        return
      }
    }
    try {
      handleLine(parsed)
    } catch {
      // A malformed-but-valid-JSON line shouldn't take down the parser.
    }
  }

  const feed = (chunk: string) => {
    buffer += chunk
    let newlineIndex: number
    while (!refusal && (newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      feedLine(line)
    }
    return refusal === null
  }

  const finish = (): ParsedClaudeResult | null => {
    if (buffer.length > 0 && !refusal) {
      feedLine(buffer)
      buffer = ''
    }
    return result
  }

  /** The session id even when no `result` line arrived (timeout/crash). */
  const sessionId = (): string | null => result?.sessionId ?? initSessionId

  return {feed, finish, sessionId, refusal: () => refusal}
}

export type { SpawnImpl }

export const runClaude = async (
  options: AgentRunOptions,
  spawnImpl?: SpawnImpl,
): Promise<AgentRunResult> => {
  const args = buildClaudeArgs(options)
  const parser = createStreamJsonParser(options.onEvent, {
    builtIns: builtInToolsAllowed(options.allowedTools),
    serverNames: options.mcpConfig?.serverNames ?? [],
  })
  const env = envForBilling(options.env ?? process.env, options.billing)
  // Convenience for daemons launched inside a desktop session. The init
  // check also covers plugin sources that this process does not know about.
  delete env.CLAUDE_CODE_PLUGIN_DIRS

  const {exitCode, timedOut, stderr} = await runJsonlProcess({
    bin: options.claudeBin,
    args,
    prompt: options.prompt,
    cwd: options.cwd,
    env,
    timeoutMs: options.timeoutMs,
    onStdoutText: text => parser.feed(text),
    signal: options.signal,
    spawnImpl,
  })

  const parsed = parser.finish()
  const refusal = parser.refusal()
  if (refusal) {
    return {
      ok: false, resultText: '', sessionId: null, exitCode, timedOut, raw: null, usage: null,
      stderr: `Use a runner host without Claude plugins and start the daemon outside a desktop session. ${refusal}`,
    }
  }
  const ok = !timedOut && exitCode === 0 && parsed !== null && !parsed.isError

  return {
    ok,
    resultText: parsed?.resultText ?? '',
    sessionId: parser.sessionId(),
    exitCode,
    timedOut,
    stderr,
    raw: parsed?.raw ?? null,
    usage: claudeUsageFrom(parsed?.raw ?? null),
  }
}
