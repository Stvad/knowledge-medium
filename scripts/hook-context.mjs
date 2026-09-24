/**
 * additionalContext output for the fact-printing PreToolUse(Bash) hooks
 * (backup-before-restore, push-scope). Claude Code inlines one hook command's
 * context only up to ~10K characters and shows a 2K preview past that, so a
 * note lists its lines only while they fit a budget and then says how many it
 * left out. The emitted JSON carries no permissionDecision: the normal
 * permission flow applies unchanged.
 */

export const NOTE_BUDGET = 8_000
export const CONTEXT_MAX = 9_500

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
  const text = notes.join('\n\n')
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        // Defence in depth: each note already fits NOTE_BUDGET; this binds
        // only when one command yields notes for several repositories.
        additionalContext: text.length > CONTEXT_MAX ? text.slice(0, CONTEXT_MAX) : text,
      },
    }) + '\n',
  )
}
