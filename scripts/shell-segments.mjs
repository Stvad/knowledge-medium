/**
 * Split a shell command string into segments of unquoted tokens, for
 * PreToolUse(Bash) hooks that must act on VERB POSITION rather than substring
 * matches (a command that merely *mentions* a guarded git command or a uuid
 * inside a quoted -m string must not trip a guard).
 *
 * A segment is one simple-command position. Boundaries: unquoted `;` `&` `|`
 * newline, subshell parens, and command substitutions — $(…) and backticks
 * open a new segment even inside double quotes, because they execute there.
 * Quoted spans stay inside their token (quotes stripped, backslash-escapes
 * honored outside single quotes). Each segment carries its subshell DEPTH so a
 * caller can scope state (a cd inside parens or a substitution) to the scope
 * it actually affects.
 *
 * Deliberately not a full shell parser: no expansions, no here-docs, and a
 * close-paren inside a double-quoted string nested in a substitution closes
 * early. Guards built on this defend against accidents, not adversaries.
 */
export const shellSegmentsWithDepth = cmd => {
  const segments = []
  let tokens = []
  let cur = ''
  let started = false // distinguishes '' (a real empty token) from no token
  let quote = null // ' or " while inside a quoted span
  let escaped = false
  const scopes = [] // open subshell scopes; length IS the current depth

  const pushToken = () => {
    if (started) tokens.push(cur)
    cur = ''
    started = false
  }
  // Every scope change closes the segment first, so a segment's tokens all
  // live at one depth — scopes.length at push time.
  const pushSegment = () => {
    pushToken()
    if (tokens.length) segments.push({ tokens, depth: scopes.length })
    tokens = []
  }

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (escaped) {
      escaped = false
      if (ch === '\n') continue // \<newline> is a continuation — bash drops it
      cur += ch
      started = true
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
      pushSegment()
      scopes.push({ kind: 'subst', quote })
      quote = null
      i++
      continue
    }
    if (ch === '`') {
      pushSegment()
      if (scopes.at(-1)?.kind === 'backtick') quote = scopes.pop().quote
      else {
        scopes.push({ kind: 'backtick', quote })
        quote = null
      }
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
      scopes.push({ kind: 'paren', quote: null })
      continue
    }
    if (ch === ')') {
      pushSegment()
      const top = scopes.at(-1)
      if (top?.kind === 'subst') quote = scopes.pop().quote
      else if (top?.kind === 'paren') scopes.pop()
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

export const shellSegments = cmd => shellSegmentsWithDepth(cmd).map(s => s.tokens)
