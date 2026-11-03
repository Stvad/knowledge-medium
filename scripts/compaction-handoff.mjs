#!/usr/bin/env node
// SessionStart hook (matcher `compact`): puts the handoff an agent wrote before
// a compaction back into the context that follows it. The compaction-handoff
// skill writes it as `handoff.md` in the session's scratchpad. Once injected it
// is renamed to `handoff.consumed.md`, so a later compaction the agent did not
// prepare for cannot replay stale next steps.
//
// Contract: never break session start. Any failure prints nothing on stdout and exits 0.
import { readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { emitContext, fitLines } from './hook-context.mjs'
import { isMainModule } from './is-main-module.mjs'

const HANDOFF_FILE = 'handoff.md'
const CONSUMED_FILE = 'handoff.consumed.md'

const render = (text, path, minutes) =>
  fitLines(
    [
      '# Compaction handoff',
      `You wrote this ${minutes} min before the compaction; anything after that is in the summary, not here. It now lives at ${path}, so a later compaction will not replay it. Follow the \`compaction-handoff\` skill's "After compaction" steps.`,
      '',
    ],
    text.split('\n'),
    n => `…${n} more lines not shown: read them at ${path}`,
  ).join('\n')

/**
 * The SessionStart payload → the handoff as context ('' when none was prepared), consuming the file.
 * `scratchpad_dir` is the scratchpad the session's system prompt names; Claude Code omits it when the session
 * has none. Its contents are trusted as Claude Code trusts them: it opens the claude-<uid> root with O_NOFOLLOW,
 * refuses one another uid owns, and keeps it 0700.
 */
export const injectHandoff = (payload, now = Date.now()) => {
  const dir = payload.scratchpad_dir
  if (!dir) return ''
  const from = join(dir, HANDOFF_FILE)
  let text, mtimeMs
  try {
    text = readFileSync(from, 'utf8')
    mtimeMs = statSync(from).mtimeMs
  } catch {
    return ''
  }
  const to = join(dir, CONSUMED_FILE)
  renameSync(from, to)
  return render(text, to, Math.round((now - mtimeMs) / 60_000))
}

if (isMainModule(import.meta.url)) {
  try {
    const context = injectHandoff(JSON.parse(readFileSync(0, 'utf8')))
    if (context) emitContext('SessionStart', [context])
  } catch (e) {
    console.error(`[compaction-handoff] ${e?.message ?? e}`)
  }
}
