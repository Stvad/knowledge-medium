/**
 * Spawn one `claude -p` run for a task and parse its JSON result.
 *
 * Billing invariant: runs must hit the user's Claude subscription, not
 * the API. `claude` prefers ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
 * over subscription OAuth when they're present, so both are scrubbed
 * from the child env — the machine's `claude login` state then wins.
 *
 * Permissions: no permission-mode bypass. Print mode fails closed —
 * anything outside --allowedTools is denied. Graph access comes from
 * the km MCP tools; per-watcher config can add more (e.g. Bash for a
 * repo-scoped watcher), which is a deliberate opt-in.
 */
import { spawn as nodeSpawn } from 'node:child_process'

export interface ClaudeRunOptions {
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
}

export interface ClaudeRunResult {
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

/** Env vars that would silently flip billing away from the
 *  subscription (API key beats OAuth in claude's credential order). */
export const BILLING_ENV_DENYLIST = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const

export const scrubEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const scrubbed = {...env}
  for (const key of BILLING_ENV_DENYLIST) delete scrubbed[key]
  return scrubbed
}

export const buildClaudeArgs = (options: ClaudeRunOptions): string[] => {
  const args = ['-p', options.prompt, '--output-format', 'json']
  if (options.resumeSessionId) args.push('--resume', options.resumeSessionId)
  if (options.model) args.push('--model', options.model)
  if (options.mcpConfigPath) args.push('--mcp-config', options.mcpConfigPath)
  if (options.allowedTools.length > 0) {
    args.push('--allowedTools', options.allowedTools.join(','))
  }
  return args
}

export const parseClaudeJson = (stdout: string): {resultText: string, sessionId: string | null, isError: boolean, raw: Record<string, unknown>} | null => {
  // --output-format json prints a single JSON object; tolerate stray
  // non-JSON lines around it by scanning for the outermost object.
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start < 0 || end <= start) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const raw = parsed as Record<string, unknown>
  return {
    resultText: typeof raw.result === 'string' ? raw.result : '',
    sessionId: typeof raw.session_id === 'string' ? raw.session_id : null,
    isError: raw.is_error === true,
    raw,
  }
}

export type SpawnImpl = typeof nodeSpawn

export const runClaude = async (
  options: ClaudeRunOptions,
  spawnImpl: SpawnImpl = nodeSpawn,
): Promise<ClaudeRunResult> => {
  const args = buildClaudeArgs(options)
  const child = spawnImpl(options.claudeBin, args, {
    cwd: options.cwd,
    env: scrubEnv(options.env ?? process.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 5_000).unref()
  }, options.timeoutMs)

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', code => resolve(code))
  }).finally(() => clearTimeout(timer))

  const parsed = parseClaudeJson(stdout)
  const ok = !timedOut && exitCode === 0 && parsed !== null && !parsed.isError

  return {
    ok,
    resultText: parsed?.resultText ?? '',
    sessionId: parsed?.sessionId ?? null,
    exitCode,
    timedOut,
    stderr,
    raw: parsed?.raw ?? null,
  }
}
