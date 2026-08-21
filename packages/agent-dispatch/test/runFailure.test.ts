import {describe, expect, it} from 'vitest'
import {channelFailureFor, classifyRunFailure, classifyThrown, RETRY_BACKOFF_MS, retryBackoffMs, withRunFailure, type RunFailureSignals} from '../src/runFailure'

const signals = (overrides: Partial<RunFailureSignals> = {}): RunFailureSignals => ({
  stderr: '',
  failureText: '',
  exitCode: 1,
  timedOut: false,
  ...overrides,
})

describe('classifyRunFailure', () => {
  it.each([
    ['a spent subscription', 'Claude AI usage limit reached|1800003600', 'credits'],
    ['spent API credits', 'API Error: 400 Your credit balance is too low to access the Anthropic API', 'credits'],
    ['a spent codex plan', "You've hit your usage limit. Try again later.", 'credits'],
    ['a rate limit', 'API Error: rate_limit_error — please retry', 'rate-limit'],
    ['an overloaded upstream', 'Error: Overloaded', 'rate-limit'],
    ['a 429', 'request failed with status code 429', 'rate-limit'],
    ['an expired login', 'OAuth token has expired. Please run /login', 'auth'],
    ['a missing key', 'authentication_error: invalid api key', 'auth'],
    ['DNS failure', 'FetchError: getaddrinfo ENOTFOUND api.anthropic.com', 'network'],
    ['a dropped connection', 'Error: socket hang up', 'network'],
    ['a bad gateway', 'upstream error: 502 Bad Gateway', 'network'],
    ['a missing executor binary', 'Error: spawn claude ENOENT', 'executor'],
  ])('treats %s as retryable (%s → %s)', (_name, stderr, kind) => {
    expect(classifyRunFailure(signals({stderr}))).toMatchObject({kind, retryable: true})
  })

  it('reads the structured failure message, not just stderr', () => {
    // codex writes its cause to stdout (turn.failed) and its stderr is
    // often unrelated update noise; claude puts it on the result line.
    expect(classifyRunFailure(signals({
      stderr: 'note: a new version of codex is available\n',
      failureText: 'stream error: You have hit your usage limit.',
    }))).toMatchObject({kind: 'credits', retryable: true})
  })

  it('is a TASK failure when the executor ran and the task itself went wrong', () => {
    expect(classifyRunFailure(signals({
      failureText: 'Error: the file you asked me to read does not exist',
    }))).toEqual({kind: 'task', retryable: false, label: 'run failed'})
  })

  it('is a TASK failure when the run produced nothing to go on', () => {
    expect(classifyRunFailure(signals({exitCode: 2}))).toMatchObject({kind: 'task', retryable: false})
  })

  it('keeps a timeout terminal — the run WAS attempted, it just overran', () => {
    // Even when the (partial) output mentions a rate limit: retrying only
    // burns the same timeoutMs again, so this must not become a defer loop.
    expect(classifyRunFailure(signals({stderr: 'rate limit hit mid-run', timedOut: true})))
      .toMatchObject({kind: 'task', retryable: false})
  })

  it('never reads the assistant\'s own words — only CLI-produced text', () => {
    // The guard is structural: `failureText` is empty for a successful run
    // (runner.ts / codexRunner.ts gate it on !ok), so a reply ABOUT rate
    // limits cannot reach the classifier. This pins the contract that the
    // classifier is given no other text channel to be fooled through.
    expect(Object.keys(signals()).sort()).toEqual(['exitCode', 'failureText', 'stderr', 'timedOut'])
  })

  it('does not read a bare ENOENT as a missing executor', () => {
    // A codex run with shell access can print ENOENT for its own reasons;
    // only the spawn-error SHAPE means "the CLI itself isn't there".
    expect(classifyRunFailure(signals({stderr: "cat: notes.md: ENOENT, no such file or directory"})))
      .toMatchObject({kind: 'task', retryable: false})
  })

  it('does not fire on a bare number that merely looks like a status code', () => {
    expect(classifyRunFailure(signals({failureText: 'processed 429 rows, then crashed'})))
      .toMatchObject({kind: 'task', retryable: false})
  })

  it('reads the channel wrapper\'s "replied <code>" wording', () => {
    // A listener that is DOWN says ECONNREFUSED, but one that ANSWERS 429 or
    // 503 phrases it only as `channel listener replied 503` — which matched
    // none of the other patterns, so a transient upstream blip parked the
    // task terminal instead of deferring it.
    expect(classifyRunFailure(signals({stderr: 'channel listener replied 503 — is the ambient session running?'})))
      .toMatchObject({kind: 'network', retryable: true})
    expect(classifyRunFailure(signals({stderr: 'channel listener replied 429'})))
      .toMatchObject({kind: 'rate-limit', retryable: true})
  })

  it('lets the structured cause overrule unrelated stderr noise', () => {
    // codexRunner folds its real message in FRONT of a stderr it documents
    // as carrying update notices. Classifying the concatenation let an
    // updater's "network error" upgrade a permanent task failure to
    // retryable — and a task that can only ever fail then re-ran forever.
    expect(classifyRunFailure(signals({
      failureText: 'file does not exist: /tmp/nope',
      stderr: 'file does not exist: /tmp/nope\nupdate check failed: network error',
    }))).toMatchObject({kind: 'task', retryable: false})
  })

  it('still falls back to stderr when the run produced no structured message', () => {
    // A process that dies before emitting one, and the spawn-error throws.
    expect(classifyRunFailure(signals({failureText: '', stderr: 'spawn claude ENOENT'})))
      .toMatchObject({kind: 'executor', retryable: true})
  })

  it('reads the bridge\'s disconnected-client wording', () => {
    // The bridge answers 503 with this body when the paired app tab drops,
    // and the client throws the body alone — the status is gone by the time
    // the text reaches the classifier, so the wording is the only handle.
    expect(classifyRunFailure(signals({stderr: 'Target client is not currently connected.'})))
      .toMatchObject({kind: 'network', retryable: true})
  })

  it('keeps a channel 404 terminal — a wrong port is not an outage', () => {
    expect(classifyRunFailure(signals({stderr: 'channel listener replied 404'})))
      .toMatchObject({kind: 'task', retryable: false})
  })
})

describe('a thrower that states its own cause', () => {
  it('is believed over its rendered message', () => {
    // The whole point: the daemon knows it got a 503 or an abort, so the
    // engine reads a value instead of matching a sentence. Three review
    // findings were phrasings this classifier had not been taught.
    const stated = withRunFailure('anything at all', {kind: 'auth', retryable: true, label: 'nope'})
    expect(classifyThrown(stated, 'anything at all')).toMatchObject({kind: 'auth', retryable: true})
  })

  it('falls back to the message when nothing was stated', () => {
    expect(classifyThrown(new Error('spawn claude ENOENT'), 'spawn claude ENOENT'))
      .toMatchObject({kind: 'executor', retryable: true})
  })

  it('ignores a malformed marker rather than trusting it', () => {
    // A value crossing a serialization boundary can arrive half-shaped;
    // reading it blind would invent a classification out of junk.
    const bogus = Object.assign(new Error('spawn claude ENOENT'), {__agentDispatchRunFailure: {kind: 'auth'}})
    expect(classifyThrown(bogus, 'spawn claude ENOENT')).toMatchObject({kind: 'executor', retryable: true})
  })
})

describe('channelFailureFor', () => {
  it('reads a status the listener chose, without a regex', () => {
    expect(channelFailureFor(503, null)).toMatchObject({kind: 'network', retryable: true})
    expect(channelFailureFor(429, null)).toMatchObject({kind: 'rate-limit', retryable: true})
    expect(channelFailureFor(401, null)).toMatchObject({kind: 'auth', retryable: true})
  })

  it('keeps a 404 terminal — a wrong port is not an outage', () => {
    expect(channelFailureFor(404, null)).toMatchObject({kind: 'task', retryable: false})
  })

  it('treats our own 10s timeout as transport, not as the task failing', () => {
    // AbortSignal.timeout rejects with a TimeoutError whose MESSAGE the
    // string matcher never recognised, so a slow delivery parked the task.
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {name: 'TimeoutError'})
    expect(channelFailureFor(null, timeout)).toMatchObject({kind: 'network', retryable: true})
  })
})

describe('retryBackoffMs', () => {
  it('grows with consecutive failures and then holds at the cap', () => {
    expect([1, 2, 3, 4, 5, 50].map(retryBackoffMs))
      .toEqual([30_000, 60_000, 120_000, 300_000, 300_000, 300_000])
  })

  it('clamps a nonsense count to the first step instead of returning undefined', () => {
    expect(retryBackoffMs(0)).toBe(RETRY_BACKOFF_MS[0])
  })

  it('caps low enough that a user who tops up credits is not left waiting', () => {
    // The ceiling is the worst-case wait for a task nobody asks about; an
    // explicit Retry bypasses the cooldown (engine.ts), so this bounds the
    // AUTOMATIC recovery rather than the user-driven one.
    expect(Math.max(...RETRY_BACKOFF_MS)).toBeLessThanOrEqual(5 * 60_000)
  })
})
