#!/usr/bin/env node
// SessionStart hook: the beads memory index, rendered to FIT the host.
//
// Claude Code inlines a hook's additionalContext only up to 10,000 chars
// (measured 2026-08-19, CC 2.1.226: 9,999 inline, 10,500 persisted); anything
// larger is written to a file and the model sees a 2KB preview (issue #643).
// So the index is keys only, grouped by prefix so each prefix is written once.
// Keys come from `bd memories --json`, not `bd prime`: prime's listing is
// capped by the `prime.max-memory-chars` config and reports the cap only in
// a banner. Keys that still do not fit are counted in the output; none is
// dropped silently. bd prime's close protocol and command reference are not
// carried — AGENTS.md's managed Beads block already injects them.
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
const MAX_BD_OUTPUT_BYTES = 16 * 1024 * 1024

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

const firstLine = s => clip(String(s ?? '').trim().split('\n')[0], 160)

/** `bd memories --json` stdout → `{ keys }`, or `{ error }` saying why there are none. */
export const parseMemoryKeys = stdout => {
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    // bd reports some failures as `Error…` on stdout, with exit 0.
    return { error: firstLine(stdout) || 'empty output' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'output is not a JSON object' }
  // A memory's value is its text; bd puts a numeric `schema_version` in the same object.
  return { keys: Object.keys(parsed).filter(key => typeof parsed[key] === 'string') }
}

/** A `bd memories --json` spawnSync result → the index, or why it could not be read. */
export const readMemoryIndex = result => {
  // ENOBUFS truncates stdout at the buffer cap — the whole index lost to a cap.
  if (result.error) return { error: result.error.code ?? result.error.message }
  // bd's own `Error…` line names the cause; a failing exit often carries one.
  const stderrError = /^Error.*$/m.exec(result.stderr ?? '')
  if (stderrError) return { error: firstLine(stderrError[0]) }
  if (result.status !== 0) return { error: `bd memories exited ${result.status ?? result.signal}` }
  return parseMemoryKeys(result.stdout)
}

// A key is `<prefix>_<name>`, split at its first underscore. One that does
// not split into two non-empty parts is listed whole.
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
  const hidden = names.length - Math.min(names.length, cap)
  const items = names.slice(0, cap)
  return `${label} ${(hidden ? [...items, `…(+${hidden} more)`] : items).join(KEY_SEPARATOR)}`
}

// `cap` is how many names each group shows; null shows no group lines at all.
// `notice` is a one-line alarm (a failing or slowing sync, readSyncAlarm)
// that must reach the session whatever the index costs, so it sits above it
// and inside the same fit.
const renderIndex = (groups, cap, notice) => {
  const total = groups.reduce((n, g) => n + g.names.length, 0)
  const shown = cap === null ? 0 : groups.reduce((n, g) => n + Math.min(g.names.length, cap), 0)
  const hidden = total - shown
  return [
    TITLE,
    '',
    ...(notice ? [notice, ''] : []),
    `## Memories (${total}) — \`<prefix>: <name>\` is the key \`<prefix>_<name>\` · full text: \`bd recall <key>\` · search: \`bd memories <keyword>\``,
    ...(hidden ? [`${hidden} of ${total} keys not shown (see "+N more" per group) — ${FULL_INDEX_HINT}`] : []),
    '',
    ...(cap === null ? [] : groups.map(g => groupLine(g, cap))),
  ].join('\n')
}

/** `index` is readMemoryIndex's result. */
export const buildAdditionalContext = (index, notice = '') => {
  if (index.error) {
    const lines = [TITLE, '', ...(notice ? [notice, ''] : []), `## Memories — index unavailable (${index.error}); ${FULL_INDEX_HINT}`]
    return clip(lines.join('\n'), MAX_CONTEXT_CHARS)
  }
  const groups = groupKeys(index.keys)
  const fits = cap => renderIndex(groups, cap, notice).length <= MAX_CONTEXT_CHARS
  if (fits(Infinity)) return renderIndex(groups, Infinity, notice)
  if (!fits(0)) return renderIndex(groups, null, notice)
  // The largest per-group cap that fits, so the largest groups give up their
  // tails first and a small group stays whole. `lo` always fits.
  let lo = 0
  let hi = Math.max(...groups.map(g => g.names.length))
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (fits(mid)) lo = mid
    else hi = mid
  }
  return renderIndex(groups, lo, notice)
}

const parseHookEnvelope = raw => {
  if (!raw) return null
  try {
    const envelope = JSON.parse(raw)
    const context = envelope?.hookSpecificOutput?.additionalContext
    return typeof context === 'string' && context.trim() ? { envelope, context } : null
  } catch {
    return null
  }
}

/** Replace a native lifecycle envelope's context without changing its event or other fields. */
export const transformCodexHookStdout = (raw, context) => {
  const native = parseHookEnvelope(raw)
  if (!native) return raw
  native.envelope.hookSpecificOutput = { ...native.envelope.hookSpecificOutput, additionalContext: context }
  return JSON.stringify(native.envelope)
}

/**
 * The hook's output, guaranteed to carry the sync alarm. The alarm does not
 * come from the index, so nothing the index path produced — no output, a
 * malformed or foreign envelope, one without context — may drop it. The
 * renderers above already put it inside the fit; this is the one place that
 * covers every path they do not reach.
 */
export const withNotice = (raw, notice) => {
  if (!notice) return raw
  let envelope = null
  // Output that is not JSON is plain-text context in its own right, and kept.
  let text = ''
  try {
    envelope = JSON.parse(raw)
  } catch {
    text = raw ?? ''
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) envelope = {}
  const hookOutput = envelope.hookSpecificOutput ?? {}
  const context = typeof hookOutput.additionalContext === 'string' ? hookOutput.additionalContext : text
  // The notice goes out only at session start, so the event is forced after
  // the envelope's own fields: a foreign or malformed one cannot misroute it.
  envelope.hookSpecificOutput = {
    ...hookOutput,
    hookEventName: 'SessionStart',
    additionalContext: context.includes(notice) ? context : clip(context ? `${notice}\n\n${context}` : notice, MAX_CONTEXT_CHARS),
  }
  return JSON.stringify(envelope)
}

const runBd = (args, input = undefined) => spawnSync('bd', args, {
  encoding: 'utf8',
  input,
  maxBuffer: MAX_BD_OUTPUT_BYTES,
  stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
})

const indexContext = notice => buildAdditionalContext(readMemoryIndex(runBd(['memories', '--json'])), notice)

const runClaudeSessionStart = notice => JSON.stringify({
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: indexContext(notice) },
})

const runCodexHook = (event, notice) => {
  let input = ''
  try {
    input = readFileSync(0, 'utf8')
  } catch {
    // Hooks should remain best-effort when their host closes stdin early.
  }
  const nativeRaw = runBd(['codex-hook', event], input).stdout ?? ''
  // A lifecycle result with no context gets none added.
  if (!parseHookEnvelope(nativeRaw)) return nativeRaw
  return transformCodexHookStdout(nativeRaw, indexContext(notice))
}

if (isMainModule(import.meta.url)) {
  try {
    const root = beadsDbRoot()
    if (root) {
      const codexEvent = process.argv[2] === '--codex' ? (process.argv[3] ?? '') : null
      // The alarm opens a session. The other lifecycle events re-inject context
      // mid-session (UserPromptSubmit, compaction), where it would repeat.
      const notice = codexEvent === null || codexEvent === 'SessionStart' ? readSyncAlarm(root) : ''
      // The alarm reads only the log, so it still goes out when bd itself is
      // what is broken.
      const index = !bdRunnable() ? null : codexEvent === null ? runClaudeSessionStart(notice) : runCodexHook(codexEvent, notice)
      const out = withNotice(index, notice)
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
