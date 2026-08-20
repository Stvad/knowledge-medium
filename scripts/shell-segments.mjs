/**
 * Split a shell command string into segments of unquoted tokens, for
 * PreToolUse(Bash) hooks that must act on VERB POSITION rather than substring
 * matches (a command that merely *mentions* `git stash pop` or a uuid inside a
 * quoted -m string must not trip a guard).
 *
 * A segment is one simple-command position. Boundaries: unquoted `;` `&` `|`
 * newline, subshell parens, and command substitutions — `$(…)` and backticks
 * open a new segment even inside double quotes, because they execute there.
 * Quoted spans stay inside their token (quotes stripped, backslash-escapes
 * honored outside single quotes).
 *
 * Deliberately not a full shell parser: no expansions, no here-docs, and a `)`
 * inside a double-quoted string nested in a substitution closes early. Guards
 * built on this defend against accidents, not adversaries.
 */
export const shellSegments = cmd => {
  const segments = []
  let tokens = []
  let cur = ''
  let started = false // distinguishes '' (a real empty token) from no token
  let quote = null // ' or " while inside a quoted span
  let escaped = false
  const saved = [] // quote context to restore when a substitution closes

  const pushToken = () => {
    if (started) tokens.push(cur)
    cur = ''
    started = false
  }
  const pushSegment = () => {
    pushToken()
    if (tokens.length) segments.push(tokens)
    tokens = []
  }

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (escaped) {
      cur += ch
      started = true
      escaped = false
      continue
    }
    if (quote === "'") {
      if (ch === "'") quote = null
      else {
        cur += ch
        started = true
      }
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '$' && cmd[i + 1] === '(') {
      saved.push({ kind: 'subst', quote })
      quote = null
      pushSegment()
      i++
      continue
    }
    if (ch === '`') {
      const top = saved.at(-1)
      if (top?.kind === 'backtick') quote = saved.pop().quote
      else {
        saved.push({ kind: 'backtick', quote })
        quote = null
      }
      pushSegment()
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      else {
        cur += ch
        started = true
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      started = true
      continue
    }
    if (ch === '(') {
      pushSegment()
      continue
    }
    if (ch === ')') {
      if (saved.at(-1)?.kind === 'subst') quote = saved.pop().quote
      pushSegment()
      continue
    }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '\n') {
      pushSegment()
      continue
    }
    if (/\s/.test(ch)) {
      pushToken()
      continue
    }
    cur += ch
    started = true
  }
  pushSegment()
  return segments
}
