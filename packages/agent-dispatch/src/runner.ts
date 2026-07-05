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
 * Permissions: no permission-mode bypass. Print mode fails closed —
 * anything outside --allowedTools is denied. Graph access comes from
 * the km MCP tools; per-watcher config can add more (e.g. Bash for a
 * repo-scoped watcher), which is a deliberate opt-in.
 */
import { runJsonlProcess, type SpawnImpl } from './execProcess.js'

/** Progress observed while a run is in flight — fed to `onEvent` as the
 *  stream-json transcript arrives. `text` is CUMULATIVE: each event
 *  carries the full in-progress reply text so far, not a delta, which
 *  keeps consumers (graph writes, UI) idempotent no matter which event
 *  they last saw. */
export type RunEvent =
  | {kind: 'session', sessionId: string}
  | {kind: 'activity', label: string}
  | {kind: 'text', text: string}

export interface AgentRunOptions {
  claudeBin: string
  prompt: string
  cwd?: string
  allowedTools: string[]
  mcpConfigPath?: string
  model?: string
  /** Resume an existing session (thread follow-up). */
  resumeSessionId?: string
  timeoutMs: number
  env?: NodeJS.ProcessEnv
  /** Called for each parsed progress event as the run streams. Errors
   *  thrown by the handler are caught and logged — a broken consumer
   *  must never kill the run. */
  onEvent?: (event: RunEvent) => void
  /** Which CLI the engine should dispatch this run to (daemon.ts's
   *  runTask wiring); the engine itself stays executor-agnostic — this
   *  field just rides along with the rest of the run options. */
  executor?: 'claude' | 'codex'
  /** Billing mode (config.ts). 'api' skips the env scrub so the run can
   *  use usage-based credentials; anything else (incl. undefined) scrubs
   *  — the safe default, so a missing value never accidentally bills the
   *  API. */
  billing?: 'subscription' | 'api'
  /** Abort the in-flight run (UI Stop). The engine holds the controller
   *  and reads `signal.aborted` after the run to tell a cancel apart from
   *  a timeout/crash. */
  signal?: AbortSignal
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
}

/** Env vars that would redirect billing away from the subscription
 *  (API key / bearer token beat OAuth in claude's credential order;
 *  the cloud-provider switches and a proxy base URL reroute entirely).
 *  NOT airtight: a user-level settings.json apiKeyHelper can still
 *  flip billing outside env reach — the README says to check that. */
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

/** The prompt is deliberately NOT an argv element — it goes via stdin
 *  (claude -p reads stdin when no prompt argument is given). Argv is
 *  visible to every local process in `ps` and capped by ARG_MAX; note
 *  content belongs in neither failure mode. */
export const buildClaudeArgs = (options: AgentRunOptions): string[] => {
  // stream-json in print mode requires --verbose; --include-partial-
  // messages turns on the incremental stream_event lines (below) so
  // activity/text can be reported before the run finishes.
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']
  if (options.resumeSessionId) args.push('--resume', options.resumeSessionId)
  if (options.model) args.push('--model', options.model)
  if (options.mcpConfigPath) {
    // strict: spawned runs get OUR mcp config only, not the user's
    // globally-registered servers.
    args.push('--mcp-config', options.mcpConfigPath, '--strict-mcp-config')
  }
  if (options.allowedTools.length > 0) {
    args.push('--allowedTools', options.allowedTools.join(','))
  }
  return args
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
export const createStreamJsonParser = (onEvent?: (event: RunEvent) => void) => {
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
    const name = typeof toolUse.name === 'string' ? toolUse.name : null
    if (!name) return
    emit({kind: 'activity', label: humanizeToolName(name)})
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

    if (type === 'assistant') {
      const message = line.message as {content?: unknown} | undefined
      const content = Array.isArray(message?.content) ? message?.content : []
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
      // already built the full running text, so re-emitting per-block here
      // used to SHRINK it (the last block superseding the whole). Adopt the
      // summary only when it's longer than what the deltas produced — that
      // covers the (rare) case where deltas didn't fire, without ever
      // losing streamed text on a multi-text-block message.
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
      if (eventType === 'content_block_start') {
        const contentBlock = streamEvent.content_block as Record<string, unknown> | undefined
        if (contentBlock?.type === 'tool_use') activityForToolUse(contentBlock)
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
    if (!parsed || typeof parsed !== 'object') return
    try {
      handleLine(parsed as Record<string, unknown>)
    } catch {
      // A malformed-but-valid-JSON line shouldn't take down the parser.
    }
  }

  const feed = (chunk: string) => {
    buffer += chunk
    let newlineIndex: number
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      feedLine(line)
    }
  }

  const finish = (): ParsedClaudeResult | null => {
    if (buffer.length > 0) {
      feedLine(buffer)
      buffer = ''
    }
    return result
  }

  /** The session id even when no `result` line arrived (timeout/crash). */
  const sessionId = (): string | null => result?.sessionId ?? initSessionId

  return {feed, finish, sessionId}
}

export type { SpawnImpl }

export const runClaude = async (
  options: AgentRunOptions,
  spawnImpl?: SpawnImpl,
): Promise<AgentRunResult> => {
  const args = buildClaudeArgs(options)
  const parser = createStreamJsonParser(options.onEvent)

  const {exitCode, timedOut, stderr} = await runJsonlProcess({
    bin: options.claudeBin,
    args,
    prompt: options.prompt,
    cwd: options.cwd,
    env: envForBilling(options.env ?? process.env, options.billing),
    timeoutMs: options.timeoutMs,
    onStdoutText: text => parser.feed(text),
    signal: options.signal,
    spawnImpl,
  })

  const parsed = parser.finish()
  const ok = !timedOut && exitCode === 0 && parsed !== null && !parsed.isError

  return {
    ok,
    resultText: parsed?.resultText ?? '',
    sessionId: parser.sessionId(),
    exitCode,
    timedOut,
    stderr,
    raw: parsed?.raw ?? null,
  }
}
