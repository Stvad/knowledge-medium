#!/usr/bin/env node
// SessionStart hook: the beads memory index, rendered to FIT the host.
//
// Claude Code inlines a hook's additionalContext only up to 10,000 chars
// (measured 2026-08-19, CC 2.1.226: 9,999 inline, 10,500 persisted); anything
// larger is written to a file and the model sees a 2KB preview (issue #643).
// So the index is keys only, grouped by prefix so each prefix is written once.
// Keys come from `bd memories --json`, not `bd prime`: prime's listing is
// capped by the `prime.max-memory-chars` config and reports the cap only in
// a banner. Keys that still do not fit are counted in the output, and an
// index that cannot be read says why; none is dropped silently. bd prime's
// close protocol and command reference are not carried — AGENTS.md's managed
// Beads block already injects them.
//
// Contract: never break session start. Any failure — bd missing, DB absent,
// unparseable output — exits 0; a DB-less clone must not spawn bd at all
// (the first bd command would create an empty DB that then refuses to pull).
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { bdRunnable, beadsDbRoot, readSyncAlarm } from './bd-github-sync.mjs'
import { isMainModule } from './is-main-module.mjs'

// Just under the measured 10,000-char inline limit; the margin absorbs a
// wrapper-side format tweak without re-measuring the host.
export const MAX_CONTEXT_CHARS = 9_800
// `bd memories --json` carries every memory's full text (bd has no keys-only
// listing), so this holds about 4,000 memories at bd's 65,535-byte cap; past
// it the index reports ENOBUFS.
const MAX_BD_OUTPUT_BYTES = 256 * 1024 * 1024
// Bounds that keep the index header inside the budget whatever the alarm or
// a failure reason says.
const MAX_NOTICE_CHARS = 1_500
const MAX_REASON_CHARS = 300
const BD_JSON_SCHEMA_VERSION = 1

const TITLE = '# Beads Issue Tracker Active'
const FULL_INDEX_HINT = '`bd memories` lists every key'
const KEY_SEPARATOR = ', '
const UNPREFIXED_LABEL = 'unprefixed (full keys):'

const clip = (s, n) => {
  if (s.length <= n) return s
  let cut = s.slice(0, Math.max(0, n - 1))
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return `${cut}…`
}

const tryJson = s => {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

const errorLine = s => /^Error.*$/m.exec(s ?? '')?.[0]

/** `bd memories --json` stdout → `{ keys }`, or `{ error }` saying why there are none. */
export const parseMemoryKeys = stdout => {
  const parsed = tryJson(stdout)
  if (parsed === undefined) {
    // bd reports some failures as `Error…` on stdout, with exit 0.
    return { error: errorLine(stdout) ?? (String(stdout ?? '').trim() ? 'output is not JSON' : 'empty output') }
  }
  if (!isPlainObject(parsed)) return { error: 'output is not a JSON object' }
  const { schema_version: version, ...rest } = parsed
  if (version !== BD_JSON_SCHEMA_VERSION) return { error: `unrecognized bd memories schema_version ${JSON.stringify(version)}` }
  // bd's v2 format (opt-in today via BD_JSON_ENVELOPE=1) moves the same map under `data`.
  const entries = Object.keys(rest).length === 1 && isPlainObject(rest.data) ? rest.data : rest
  // A value that is not a memory's text means the format moved; reading past it would hide keys.
  const odd = Object.keys(entries).filter(key => typeof entries[key] !== 'string')
  if (odd.length) return { error: `unrecognized bd memories format: ${odd.length} entries are not memory text` }
  return { keys: Object.keys(entries) }
}

/** A `bd memories --json` spawnSync result → the index, or why it could not be read. */
export const readMemoryIndex = result => {
  // ENOBUFS truncates stdout at the buffer cap — the whole index lost to a cap.
  if (result.error) return { error: result.error.code ?? result.error.message }
  // bd's own `Error…` line names the cause; a failing exit often carries one.
  const reported = errorLine(result.stderr)
  if (reported) return { error: reported }
  if (result.status !== 0) {
    // In --json mode bd reports a command's failure as `{"error": …}` on stdout instead.
    const jsonError = tryJson(result.stdout)?.error
    return { error: typeof jsonError === 'string' ? jsonError : `bd memories exited ${result.status ?? result.signal}` }
  }
  return parseMemoryKeys(result.stdout)
}

// A key is `<prefix>_<name>`, split at its first underscore. One that does
// not split into two non-empty parts is listed whole. Keys are taken to be
// slugs: one holding `, ` or a newline renders ambiguously, which is accepted.
const groupKeys = keys => {
  const byPrefix = new Map()
  const whole = []
  for (const key of [...keys].sort()) {
    const at = key.indexOf('_')
    if (at <= 0 || at === key.length - 1) {
      whole.push(key)
      continue
    }
    const prefix = key.slice(0, at)
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, [])
    byPrefix.get(prefix).push(key.slice(at + 1))
  }
  const groups = [...byPrefix].map(([prefix, names]) => ({ label: `${prefix}:`, names }))
  return whole.length ? [...groups, { label: UNPREFIXED_LABEL, names: whole }] : groups
}

const groupLine = ({ label, names }, cap) => {
  const items = names.slice(0, cap)
  const hidden = names.length - items.length
  return `${label} ${(hidden ? [...items, `…(+${hidden} more)`] : items).join(KEY_SEPARATOR)}`
}

// `cap` is how many names each group shows; at 0 no group has a line.
const renderIndex = (head, groups, cap) => {
  const total = groups.reduce((n, g) => n + g.names.length, 0)
  const hidden = total - groups.reduce((n, g) => n + Math.min(g.names.length, cap), 0)
  return [
    ...head,
    `## Memories (${total}) — \`<prefix>: <name>\` is the key \`<prefix>_<name>\` · full text: \`bd recall <key>\` · search: \`bd memories <keyword>\``,
    ...(hidden ? [`${hidden} of ${total} keys not shown — ${FULL_INDEX_HINT}`] : []),
    '',
    ...(cap > 0 ? groups.map(g => groupLine(g, cap)) : []),
  ].join('\n')
}

/**
 * `index` is readMemoryIndex's result. `notice` is a one-line alarm (a failing
 * or slowing sync, readSyncAlarm) that opens the session above the index and
 * inside the same fit.
 */
export const buildAdditionalContext = (index, notice = '') => {
  const head = [TITLE, '', ...(notice ? [clip(notice, MAX_NOTICE_CHARS), ''] : [])]
  if (index.error) {
    return [...head, `## Memories — index unavailable (${clip(index.error, MAX_REASON_CHARS)}); ${FULL_INDEX_HINT}`].join('\n')
  }
  const groups = groupKeys(index.keys)
  const render = cap => renderIndex(head, groups, cap)
  const fits = cap => render(cap).length <= MAX_CONTEXT_CHARS
  if (fits(Infinity)) return render(Infinity)
  // The largest cap that fits, so the largest groups give up their tails first
  // and a small group stays whole. Between two group sizes the output grows
  // with the cap; reaching a size completes that group and drops its
  // "+N more" marker, so a larger cap can fit where a smaller one did not.
  // Hence: the highest interval whose first cap fits, then the largest cap
  // inside it. Cap 0 is the bare header, which the bounds above always fit.
  const starts = [...new Set([0, ...groups.map(g => g.names.length)])].sort((a, b) => a - b)
  for (let i = starts.length - 1; i >= 0; i--) {
    let lo = starts[i]
    if (!fits(lo)) continue
    // The top start renders every key, which failed above, so a fitting start always has a next one.
    let hi = starts[i + 1]
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2)
      if (fits(mid)) lo = mid
      else hi = mid
    }
    return render(lo)
  }
}

/**
 * A session start's output: `context` in bd's native envelope when there is
 * one, keeping its other fields. The event is forced, so a malformed or
 * foreign envelope cannot route the index anywhere else.
 */
export const sessionStartOutput = (nativeRaw, context) => {
  const native = tryJson(nativeRaw)
  const envelope = isPlainObject(native) ? native : {}
  const hookOutput = isPlainObject(envelope.hookSpecificOutput) ? envelope.hookSpecificOutput : {}
  envelope.hookSpecificOutput = { ...hookOutput, hookEventName: 'SessionStart', additionalContext: context }
  return JSON.stringify(envelope)
}

const parseHookEnvelope = raw => {
  const envelope = tryJson(raw)
  const context = envelope?.hookSpecificOutput?.additionalContext
  return typeof context === 'string' && context.trim() ? envelope : null
}

/** A mid-session lifecycle result: its context, where bd's own result carries one, becomes the index. */
export const transformCodexHookStdout = (raw, readContext) => {
  const envelope = parseHookEnvelope(raw)
  if (!envelope) return raw
  envelope.hookSpecificOutput = { ...envelope.hookSpecificOutput, additionalContext: readContext() }
  return JSON.stringify(envelope)
}

const runBd = (args, input = undefined) => spawnSync('bd', args, {
  encoding: 'utf8',
  input,
  maxBuffer: MAX_BD_OUTPUT_BYTES,
  stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
})

const indexContext = notice => buildAdditionalContext(readMemoryIndex(runBd(['memories', '--json'])), notice)

const runCodexHook = (event, notice) => {
  let input = ''
  try {
    input = readFileSync(0, 'utf8')
  } catch {
    // Hooks should remain best-effort when their host closes stdin early.
  }
  const nativeRaw = runBd(['codex-hook', event], input).stdout ?? ''
  // bd decides when a mid-session event injects context. A session start always
  // carries the index: bd's native one prints nothing when its own prime fails.
  return event === 'SessionStart'
    ? sessionStartOutput(nativeRaw, indexContext(notice))
    : transformCodexHookStdout(nativeRaw, () => indexContext(notice))
}

if (isMainModule(import.meta.url)) {
  try {
    const root = beadsDbRoot()
    if (root) {
      const codexEvent = process.argv[2] === '--codex' ? (process.argv[3] ?? '') : null
      const sessionStart = codexEvent === null || codexEvent === 'SessionStart'
      // The alarm opens a session. The other lifecycle events re-inject context
      // mid-session (UserPromptSubmit, compaction), where it would repeat.
      const notice = sessionStart ? readSyncAlarm(root) : ''
      let out = ''
      if (!bdRunnable()) {
        // The alarm reads only the log, so it still goes out when bd itself is what is broken.
        if (sessionStart) out = sessionStartOutput('', buildAdditionalContext({ error: 'bd is not runnable' }, notice))
      } else {
        out = codexEvent === null ? sessionStartOutput('', indexContext(notice)) : runCodexHook(codexEvent, notice)
      }
      if (out) process.stdout.write(out)
    }
  } catch (e) {
    console.error(`[bd-prime-hook] ${e?.message ?? e}`)
  }
  // No `exit()`: the payload is up to 10K chars written to a piped stdout,
  // where `exit()` drops whatever is still queued — here that is memory keys
  // off the end of the index, lost silently. Nothing holds the loop open
  // (spawnSync adds no handles), so the hook still ends promptly.
}
