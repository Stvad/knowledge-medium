#!/usr/bin/env node
// SessionStart hook: `bd prime --hook-json --mcp`, re-rendered to FIT the host.
//
// Claude Code inlines a hook's additionalContext only up to 10,000 chars
// (measured 2026-08-19, CC 2.1.226: 9,999 inline, 10,500 persisted); anything
// larger is written to a file and the model sees a 2KB preview — about ten
// memory keys of the index. bd prime's --mcp output is ~27K and grows with
// every memory, so raw it NEVER arrives (issue #643). This wrapper keeps the
// memory index (every key, previews clipped just enough to fit) and drops the
// close-protocol/commands boilerplate, which AGENTS.md already injects into
// every session via the managed Beads block.
//
// Contract: never break session start. Any failure — bd missing, DB absent,
// unparseable output — exits 0; a DB-less clone must not spawn bd at all
// (the first bd command would create an empty DB that then refuses to pull).
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { initializedDbRoot, readSyncSlownessNotice } from './bd-github-sync.mjs'
import { isMainModule } from './is-main-module.mjs'

// Just under the measured 10,000-char inline limit; the margin absorbs a
// wrapper-side format tweak without re-measuring the host.
export const MAX_CONTEXT_CHARS = 9_800
const MAX_BD_OUTPUT_BYTES = 16 * 1024 * 1024

const PREVIEW_LADDER = [150, 120, 100, 80, 60, 50, 40, 30, 25, 20, 15, 10]

const BULLET = /^- \*\*([\w][\w.-]*)\*\*: ?(.*)$/

export const parsePrimeContext = ctx => {
  const memories = []
  let inSection = false
  for (const line of String(ctx ?? '').split('\n')) {
    if (/^#{1,6} /.test(line)) {
      inSection = /^## Memories\b/.test(line)
      continue
    }
    if (!inSection) continue
    const m = BULLET.exec(line)
    if (m) memories.push({ key: m[1], preview: m[2] })
    else if (line.trim() && memories.length) memories[memories.length - 1].preview += ` ${line.trim()}`
  }
  return { memories, parseOk: memories.length > 0 }
}

const clip = (s, n) => {
  if (s.length <= n) return s
  let cut = s.slice(0, Math.max(0, n - 1))
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return `${cut}…`
}

// `notice` is a one-line alarm (the sync's slowness, readSyncSlownessNotice)
// that must reach the session whatever the index costs, so it sits above it
// and inside the same fit.
const render = (memories, previewLen, droppedNote = '', notice = '') => {
  const clipNote = previewLen > 0 && memories.some(m => m.preview.length > previewLen)
    ? ` · previews clipped to ${previewLen} chars`
    : previewLen === 0
      ? ' · previews omitted to fit'
      : ''
  const lines = [
    '# Beads Issue Tracker Active',
    '',
    ...(notice ? [notice, ''] : []),
    `## Memories (${memories.length}) — full text: \`bd recall <key>\` · search: \`bd memories <keyword>\`${clipNote}`,
    ...memories.map(m => (previewLen > 0 ? `- **${m.key}**: ${clip(m.preview, previewLen)}` : `- **${m.key}**`)),
  ]
  if (droppedNote) lines.push(droppedNote)
  return lines.join('\n')
}

export const buildAdditionalContext = (ctx, notice = '') => {
  const { memories, parseOk } = parsePrimeContext(ctx)
  if (!parseOk) {
    const head = `${notice ? `${notice}\n\n` : ''}[bd-prime-hook] could not parse \`bd prime\` output; raw output clipped to fit the host inline limit:\n\n`
    return head + clip(String(ctx ?? ''), MAX_CONTEXT_CHARS - head.length)
  }
  for (const n of PREVIEW_LADDER) {
    const text = render(memories, n, '', notice)
    if (text.length <= MAX_CONTEXT_CHARS) return text
  }
  const keysOnly = render(memories, 0, '', notice)
  if (keysOnly.length <= MAX_CONTEXT_CHARS) return keysOnly
  // Last resort: keep a contiguous prefix of bd's ordering and say what fell off.
  for (let keep = memories.length - 1; keep > 0; keep--) {
    const kept = memories.slice(0, keep)
    const note = `…and ${memories.length - keep} more — run \`bd memories\` for the full index`
    const text = render(kept, 0, note, notice)
    if (text.length <= MAX_CONTEXT_CHARS) return text
  }
  return render([], 0, `…and ${memories.length} more — run \`bd memories\` for the full index`, notice)
}

export const transformHookStdout = (raw, notice = '') => {
  if (!raw) return null
  // Defence in depth: bd's `Error…`-with-exit-0 stdout is not valid JSON, so
  // the parse below already rejects it; this names the failure instead of
  // relying on that. The load-bearing Error check is main()'s stderr one.
  if (/^Error/m.test(raw)) return null
  let ctx
  try {
    ctx = JSON.parse(raw)?.hookSpecificOutput?.additionalContext
  } catch {
    return null
  }
  if (typeof ctx !== 'string' || !ctx.trim()) return null
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: buildAdditionalContext(ctx, notice) },
  })
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

/** Compact a native lifecycle envelope without changing its event or other fields. */
export const transformCodexHookStdout = (raw, primeRaw, notice = '') => {
  const native = parseHookEnvelope(raw)
  if (!native) return raw
  const context = parseHookEnvelope(primeRaw)?.context ?? native.context
  native.envelope.hookSpecificOutput = {
    ...native.envelope.hookSpecificOutput,
    additionalContext: buildAdditionalContext(context, notice),
  }
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
  try {
    envelope = JSON.parse(raw)
  } catch {}
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) envelope = {}
  const hookOutput = envelope.hookSpecificOutput ?? {}
  const context = typeof hookOutput.additionalContext === 'string' ? hookOutput.additionalContext : ''
  if (context.includes(notice)) return raw
  envelope.hookSpecificOutput = {
    hookEventName: 'SessionStart',
    ...hookOutput,
    additionalContext: context ? `${notice}\n\n${context}` : notice,
  }
  return JSON.stringify(envelope)
}

const runBd = (args, input = undefined) => spawnSync('bd', args, {
  encoding: 'utf8',
  input,
  maxBuffer: MAX_BD_OUTPUT_BYTES,
  stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
})

const runClaudeSessionStart = notice => {
  const r = runBd(['prime', '--hook-json', '--mcp'])
  return r.status === 0 && !/^Error/m.test(r.stderr ?? '') ? transformHookStdout(r.stdout, notice) : null
}

const runCodexHook = (event, notice) => {
  let input = ''
  try {
    input = readFileSync(0, 'utf8')
  } catch {
    // Hooks should remain best-effort when their host closes stdin early.
  }

  const native = runBd(['codex-hook', event], input)
  const nativeRaw = native.stdout ?? ''
  if (!parseHookEnvelope(nativeRaw)) return nativeRaw

  // Native SessionStart currently includes the full prime output. Read a
  // fresh prime so the existing compact renderer remains the one source of
  // context formatting, regardless of the lifecycle event being handled.
  const prime = native.status === 0 && !/^Error/m.test(native.stderr ?? '')
    ? runBd(['prime', '--hook-json', '--mcp'])
    : null
  return transformCodexHookStdout(
    nativeRaw,
    prime?.status === 0 && !/^Error/m.test(prime.stderr ?? '') ? prime.stdout : null,
    notice,
  )
}

if (isMainModule(import.meta.url)) {
  try {
    const root = initializedDbRoot()
    if (root) {
      const codexEvent = process.argv[2] === '--codex' ? (process.argv[3] ?? '') : null
      // The alarm opens a session. The other lifecycle events re-inject context
      // mid-session (UserPromptSubmit, compaction), where it would repeat.
      const notice = codexEvent === null || codexEvent === 'SessionStart' ? readSyncSlownessNotice(root) : ''
      const out = withNotice(codexEvent === null ? runClaudeSessionStart(notice) : runCodexHook(codexEvent, notice), notice)
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
