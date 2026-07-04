/**
 * Shared child-process skeleton for the executor runners (runner.ts's
 * `claude`, codexRunner.ts's `codex`): spawn, stdin prompt, StringDecoder
 * stdout/stderr, timeout kill, close/error handling. Each executor
 * supplies its own argv builder and its own line parser (the JSONL
 * *shapes* differ) — this only owns the process plumbing they share.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

export type SpawnImpl = typeof nodeSpawn

export interface RunJsonlProcessOptions {
  bin: string
  args: string[]
  /** Delivered over stdin, not argv (see runner.ts's buildClaudeArgs for
   *  why: argv is `ps`-visible and ARG_MAX-capped). */
  prompt: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  /** Called with decoded stdout text as it arrives (StringDecoder-fed,
   *  so a multibyte char split across chunks never decodes as U+FFFD
   *  garbage). Feed this straight into the caller's line parser. */
  onStdoutText: (text: string) => void
  /** Abort the run on demand (the UI Stop action, via the engine): kills
   *  the child the same way the timeout does. Independent of `timedOut` —
   *  the caller reads `signal.aborted` to tell a cancel from a timeout. */
  signal?: AbortSignal
  spawnImpl?: SpawnImpl
}

export interface RunJsonlProcessResult {
  exitCode: number | null
  timedOut: boolean
  stderr: string
}

export const runJsonlProcess = async (options: RunJsonlProcessOptions): Promise<RunJsonlProcessResult> => {
  const spawnImpl = options.spawnImpl ?? nodeSpawn
  const child = spawnImpl(options.bin, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // Prompt over stdin. EPIPE just means the child died first — the exit
  // path reports that better than a write error.
  child.stdin?.on('error', () => {})
  child.stdin?.end(options.prompt)

  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => options.onStdoutText(stdoutDecoder.write(chunk)))
  child.stderr?.on('data', (chunk: Buffer) => { stderr += stderrDecoder.write(chunk) })

  // SIGTERM, then SIGKILL after a grace period if it's still alive —
  // shared by the timeout and the abort (Stop) paths.
  const killChild = () => {
    child.kill('SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 5_000).unref()
  }

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killChild()
  }, options.timeoutMs)

  // Abort (UI Stop): kill immediately. `once` + removal on close so a
  // reused signal can't fire against a dead child. If already aborted
  // before spawn, kill straight away.
  const onAbort = () => killChild()
  if (options.signal) {
    if (options.signal.aborted) killChild()
    else options.signal.addEventListener('abort', onAbort, {once: true})
  }

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', code => resolve(code))
  }).finally(() => {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  })

  options.onStdoutText(stdoutDecoder.end())
  stderr += stderrDecoder.end()

  return {exitCode, timedOut, stderr}
}
