/**
 * Shared plumbing for the fact-printing PreToolUse(Bash) hooks
 * (backup-before-restore, push-scope): reading the payload, running git, and
 * emitting additionalContext. Claude Code inlines one hook command's context
 * only up to ~10K characters and shows a 2K preview past that, so a note lists
 * its lines only while they fit a budget and then says how many it left out.
 * The emitted JSON carries no permissionDecision: the permission flow applies
 * unchanged.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

export const NOTE_BUDGET = 8_000
const CONTEXT_MAX = 9_500

/**
 * The hook payload on stdin as {payload, cmd, cwd}, or null when it is not one
 * or its command fails `prefilter` (a fast path; the caller's parse decides).
 */
export const readHookPayload = prefilter => {
  let payload
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return null
  }
  const cmd = payload?.tool_input?.command ?? ''
  return prefilter.test(cmd) ? { payload, cmd, cwd: payload.cwd || process.cwd() } : null
}

export const git = (cwd, cArgs, args, input) =>
  execFileSync('git', [...cArgs, ...args], {
    cwd,
    encoding: 'utf8',
    input,
    stdio: 'pipe',
    maxBuffer: 64 * 1024 * 1024,
  }).trimEnd()

export const firstLine = e => String(e?.stderr || e?.message || e).trim().split('\n')[0]

/** head, then as many lines as fit the budget, then more(n) for the n left out. */
export const fitLines = (head, lines, more, budget = NOTE_BUDGET) => {
  const out = [...head]
  let size = out.join('\n').length
  let shown = 0
  while (shown < lines.length && size + 1 + lines[shown].length <= budget) {
    size += 1 + lines[shown].length
    out.push(lines[shown])
    shown++
  }
  if (shown < lines.length) out.push(more(lines.length - shown))
  return out
}

export const emitPreToolUseContext = notes => {
  if (!notes.length) return
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        // Defence in depth: each note already fits NOTE_BUDGET; this binds
        // only when one command yields notes for several repositories.
        additionalContext: notes.join('\n\n').slice(0, CONTEXT_MAX),
      },
    }) + '\n',
  )
}
