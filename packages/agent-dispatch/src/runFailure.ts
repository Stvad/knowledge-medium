/**
 * Classify a FAILED executor run: did the task fail, or did we fail to
 * attempt it?
 *
 * The distinction is load-bearing. A run that never reached the model —
 * out of credits, subscription usage limit hit, expired login, rate
 * limited, network down — is not "this task failed", it's "we couldn't
 * try". Parking it as `error` turns one credit outage into a whole queue
 * of dead tasks, because the daemon keeps picking work up and chews each
 * item into the same terminal state. Retryable failures instead leave the
 * task pending (`status: queued` + `agent:retry-after`) and put the daemon
 * into a cooldown so the rest of the queue isn't burned behind it.
 *
 * Conservative by construction: only text the CLI ITSELF produced is
 * matched — its stderr, and the structured error message a failed
 * transcript carried — never the assistant's answer, so a run whose reply
 * happens to discuss rate limits can't fake an infrastructure failure.
 * Anything unrecognized stays a task failure, i.e. a misread degrades to
 * exactly the behaviour that existed before this module.
 */

export type RunFailureKind = 'credits' | 'rate-limit' | 'auth' | 'network' | 'executor' | 'task'

export interface RunFailureSignals {
  /** The failed run's stderr (codexRunner folds its structured error in). */
  stderr: string
  /** The executor's OWN error message for this run, when the transcript
   *  carried one. MUST be empty for a successful run — the runners only
   *  populate it on failure, precisely so the assistant's words are never
   *  read as a CLI error. */
  failureText: string
  exitCode: number | null
  timedOut: boolean
}

export interface RunFailureClass {
  kind: RunFailureKind
  /** True when nothing was actually attempted: keep the task pending and
   *  back the daemon off rather than parking the task as failed. */
  retryable: boolean
  /** Short human label for the daemon log and the block's `agent:error`. */
  label: string
}

export const RUN_FAILURE_LABELS: Record<RunFailureKind, string> = {
  credits: 'out of credits / usage limit reached',
  'rate-limit': 'rate limited',
  auth: 'executor is not authenticated',
  network: 'network or upstream failure',
  executor: 'executor CLI could not be started',
  task: 'run failed',
}

/** A bare `429` shows up in plenty of unrelated error text, so an HTTP-ish
 *  status only counts when something nearby says it IS a status code.
 *  `replied` is in the list for the channel transport, whose wrapper throws
 *  `channel listener replied 503` — a listener that is DOWN says ECONNREFUSED
 *  and matches `network`, but one that ANSWERS 429/503 said nothing the
 *  other patterns recognise, so the task parked terminal on a transient
 *  upstream blip. (404 stays terminal: that is a misconfigured port, not an
 *  outage, and no amount of retrying fixes it.) */
const statusCode = (codes: string) =>
  new RegExp(String.raw`(?:status|code|http|error|replied)\D{0,12}\b(?:${codes})\b`, 'i')

/** Ordered: the first match wins, so the most specific/actionable cause
 *  (which account ran out) is reported ahead of the generic transport
 *  ones a provider often mentions in the same breath. */
const RETRYABLE_SIGNALS: ReadonlyArray<{kind: Exclude<RunFailureKind, 'task'>, pattern: RegExp}> = [
  {
    // `claude -p` reports a spent subscription as "Claude AI usage limit
    // reached|<epoch>" and spent API credits as "Credit balance is too
    // low"; codex says "You've hit your usage limit".
    kind: 'credits',
    pattern: /usage limit reached|hit your usage limit|credit balance is too low|out of credits|insufficient[_ ]quota|quota exceeded|billing[_ ]?hard[_ ]?limit/i,
  },
  {
    kind: 'rate-limit',
    pattern: /rate[_ -]?limit|too many requests|overloaded/i,
  },
  {
    kind: 'rate-limit',
    pattern: statusCode('429|529'),
  },
  {
    kind: 'auth',
    pattern: /authentication[_ ]error|invalid api key|unauthorized|oauth token (?:has )?expired|please run \/login|(?:not|must be) logged in|credentials? (?:have )?expired|refresh token/i,
  },
  {
    kind: 'auth',
    pattern: statusCode('401|403'),
  },
  {
    kind: 'network',
    // `target client is not currently connected` is the BRIDGE's 503 body
    // for "the paired app tab dropped". The HTTP status is discarded before
    // the text reaches us (the client throws the body alone), so the wording
    // is the only handle — and a dropped tab is precisely the transient
    // outage this path defers rather than a task that failed.
    pattern: /\b(?:ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)\b|socket hang up|fetch failed|getaddrinfo|network (?:error|is unreachable)|connection (?:error|refused|reset|timed out)|bad gateway|service unavailable|gateway time-?out|upstream connect error|target client is not currently connected/i,
  },
  {
    kind: 'network',
    pattern: statusCode('500|502|503|504'),
  },
  {
    // `claudeBin`/`codexBin` isn't on the daemon's PATH — the classic
    // launchd-has-a-different-PATH failure, which otherwise marks every
    // task in the queue failed. Matched in the SPAWN-error shape node
    // produces (`spawn claude ENOENT`) rather than on a bare ENOENT: a
    // codex run with shell access can print "ENOENT" for its own reasons,
    // and that is a genuine task failure.
    kind: 'executor',
    pattern: /spawn\S* \S+ ENOENT|command not found|is not recognized as an internal or external command/i,
  },
]

export const classifyRunFailure = (signals: RunFailureSignals): RunFailureClass => {
  // A timeout means the run WAS attempted and took too long — terminal, as
  // it always has been. Retrying would just burn the same timeoutMs again.
  if (signals.timedOut) return {kind: 'task', retryable: false, label: RUN_FAILURE_LABELS.task}

  // The STRUCTURED cause wins outright when there is one. Concatenating
  // stderr gave unrelated noise equal authority, and codexRunner PUTS noise
  // there on purpose — it folds the real message in front of a stderr that
  // "often carries unrelated warnings/update notices". So a genuine task
  // failure ("file does not exist") arriving beside an update-check's
  // "network error" classified as retryable, and a task that can only ever
  // fail then deferred, refunded and re-ran forever. stderr is the fallback
  // for runs that produce no structured message at all: a process that dies
  // before emitting one, and the spawn-error throws.
  const text = signals.failureText.trim() || signals.stderr
  for (const {kind, pattern} of RETRYABLE_SIGNALS) {
    if (pattern.test(text)) return {kind, retryable: true, label: RUN_FAILURE_LABELS[kind]}
  }
  return {kind: 'task', retryable: false, label: RUN_FAILURE_LABELS.task}
}

/** Backoff before the daemon attempts anything again after a retryable
 *  infrastructure failure, by consecutive-failure count (1-based).
 *
 *  Capped at 5 minutes ON PURPOSE. Each probe is a spawn that fails
 *  immediately without billing a token, so a long ceiling buys nothing —
 *  while a short one bounds how long the user waits after topping up
 *  credits or re-running `claude login` (the daemon's cooldown lives in
 *  memory, so an app-side "retry" gesture cannot clear it). */
export const RETRY_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000] as const

export const retryBackoffMs = (consecutiveFailures: number): number =>
  RETRY_BACKOFF_MS[Math.min(Math.max(consecutiveFailures, 1), RETRY_BACKOFF_MS.length) - 1]

/** A failure whose cause the THROWER already knew.
 *
 *  The daemon generates some failures itself — channel delivery, bridge
 *  calls — and it knows structurally what happened: an HTTP status, an
 *  abort, a refused connection. Rendering that to a sentence for
 *  `classifyRunFailure` to re-parse throws the knowledge away, and the
 *  classifier then has to recognise every phrasing anyone might produce.
 *  Three separate review findings were exactly that gap — a `503` reply, a
 *  dropped bridge client, and a fetch timeout, each arriving as an
 *  unrecognised string in turn. So say it instead of spelling it.
 *
 *  Carried as a plain property rather than checked with `instanceof`:
 *  errors that cross a worker or serialization boundary lose their
 *  prototype, and a silently-false `instanceof` here would degrade to the
 *  string matching this exists to replace. */
const RUN_FAILURE_KEY = '__agentDispatchRunFailure'

export const withRunFailure = (message: string, failure: RunFailureClass): Error =>
  Object.assign(new Error(message), {[RUN_FAILURE_KEY]: failure})

/** The thrower's own classification, or null when it did not state one. */
export const statedRunFailure = (error: unknown): RunFailureClass | null => {
  const stated = (error as Record<string, unknown> | null)?.[RUN_FAILURE_KEY]
  if (!stated || typeof stated !== 'object') return null
  const {kind, retryable, label} = stated as Partial<RunFailureClass>
  return typeof kind === 'string' && typeof retryable === 'boolean' && typeof label === 'string'
    ? {kind, retryable, label}
    : null
}

/** Classify a thrown error: what the thrower stated, else its message. */
export const classifyThrown = (error: unknown, message: string): RunFailureClass =>
  statedRunFailure(error)
  ?? classifyRunFailure({stderr: message, failureText: '', exitCode: null, timedOut: false})

/** The cause of a failed channel POST, from the transport rather than from
 *  its rendered message. A status the listener CHOSE is authoritative; a
 *  rejected fetch never got one, and an abort is our own 10s timeout. */
export const channelFailureFor = (status: number | null, error: unknown): RunFailureClass => {
  if (status !== null) {
    if (status === 429 || status === 529) return {kind: 'rate-limit', retryable: true, label: RUN_FAILURE_LABELS['rate-limit']}
    if (status === 401 || status === 403) return {kind: 'auth', retryable: true, label: RUN_FAILURE_LABELS.auth}
    if (status >= 500) return {kind: 'network', retryable: true, label: RUN_FAILURE_LABELS.network}
    // 404/400: the port is wrong or the payload is rejected. Retrying never
    // fixes either, so this stays a task failure.
    return {kind: 'task', retryable: false, label: RUN_FAILURE_LABELS.task}
  }
  // A timeout is ours (AbortSignal.timeout) and a refused/unreachable
  // connection is the OS's; both mean the transport, not the task.
  const name = (error as {name?: unknown} | null)?.name
  if (name === 'TimeoutError' || name === 'AbortError') {
    return {kind: 'network', retryable: true, label: RUN_FAILURE_LABELS.network}
  }
  return {kind: 'network', retryable: true, label: RUN_FAILURE_LABELS.network}
}

/** The cause of a failed BRIDGE command, from the boundary rather than from
 *  its rendered message.
 *
 *  Everything the daemon does between claiming a block and running it goes
 *  through the bridge, and every one of those failures means the app tab is
 *  slow, gone, or reconnecting — never that the task is bad. Left to the
 *  string matcher they arrived as unrecognised prose and parked claimed
 *  blocks as dead tasks: first the disconnected-client body, then the
 *  60-second command timeout. Classifying at the boundary retires the whole
 *  family instead of teaching the matcher one more sentence. */
export const bridgeFailure = (): RunFailureClass =>
  ({kind: 'network', retryable: true, label: RUN_FAILURE_LABELS.network})

