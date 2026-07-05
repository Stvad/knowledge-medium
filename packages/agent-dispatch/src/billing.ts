/**
 * Billing posture — what a spawned run's tokens bill to, and how loudly
 * the daemon says so at startup.
 *
 * The guard we care about is "don't SILENTLY bill usage-based API on an
 * unattended daemon by accident". Two vectors:
 *  - Ambient env credentials (ANTHROPIC_API_KEY, OPENAI_API_KEY, …): the
 *    common accident — a key exported for something else leaks into the
 *    child. Handled by scrubbing in `billing: 'subscription'` mode
 *    (runner.ts / codexRunner.ts), and reported here by NAME so the log
 *    confirms the scrub is doing something. (Never the value — these are
 *    secrets.)
 *  - A key stored via the CLI's own login (`claude` / `codex`
 *    `--with-api-key`, or an `apiKeyHelper`): lives in auth.json, OUTSIDE
 *    the env, so scrubbing can't reach it. We can't safely mutate the
 *    login, so we don't detect the value — we just warn that the vector
 *    exists and to verify the login. Turning a silent gap into a visible
 *    one is the honest version of the guard.
 */
import { BILLING_ENV_DENYLIST } from './runner.js'
import { CODEX_BILLING_ENV_DENYLIST } from './codexRunner.js'
import type { DaemonConfig } from './config.js'

const denylistFor = (executor: 'claude' | 'codex'): readonly string[] =>
  executor === 'codex' ? CODEX_BILLING_ENV_DENYLIST : BILLING_ENV_DENYLIST

/** The billing-redirecting env vars relevant to the executors this
 *  config actually uses (a codex-free config need not mention OPENAI_*). */
export const relevantBillingEnvVars = (config: DaemonConfig): string[] => {
  const executors = new Set(config.watchers.map(watcher => watcher.executor))
  // A config with no watchers still runs claude by default if any are
  // added at runtime; include claude so the report is never empty-by-omission.
  if (executors.size === 0) executors.add('claude')
  const vars = new Set<string>()
  for (const executor of executors) for (const key of denylistFor(executor)) vars.add(key)
  return [...vars]
}

export interface BillingReport {
  mode: 'subscription' | 'api'
  /** Denylist vars actually present in the env (names only). */
  present: string[]
  /** Human-readable lines for the startup log. */
  lines: string[]
}

/** Describe the effective billing posture for the startup log. Pure —
 *  takes the env explicitly so it's testable and never reads process.env
 *  implicitly. */
export const reportBillingPosture = (config: DaemonConfig, env: NodeJS.ProcessEnv): BillingReport => {
  const relevant = relevantBillingEnvVars(config)
  const present = relevant.filter(key => env[key] != null && env[key] !== '')

  const lines: string[] = []
  if (config.billing === 'api') {
    lines.push('billing=api — credential env is NOT scrubbed; spawned runs may bill usage-based API/credits')
    if (present.length > 0) lines.push(`  usage-based credentials in env: ${present.join(', ')}`)
  } else {
    lines.push('billing=subscription — spawned runs bill your CLI plan login (OAuth)')
    if (present.length > 0) lines.push(`  scrubbing from run env: ${present.join(', ')}`)
    lines.push('  note: a key stored via `claude`/`codex` login (auth.json / apiKeyHelper) is NOT env-scrubbable — verify your login if unsure')
  }
  return {mode: config.billing, present, lines}
}
