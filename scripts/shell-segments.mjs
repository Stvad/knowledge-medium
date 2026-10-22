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
 * Here-docs (<<WORD, <<'WORD', <<-WORD) are handled best-effort: their body
 * lines come back as segments flagged `heredoc: true` — data for scanners,
 * never command positions.
 *
 * Deliberately not a full shell parser: no expansions, and a close-paren
 * inside a double-quoted string nested in a substitution closes early. Guards
 * built on this defend against accidents, not adversaries.
 */
export const shellSegmentsWithDepth = cmd => segment(cmd, false)

export const shellSegments = cmd => shellSegmentsWithDepth(cmd).map(s => s.tokens)

/** The word a substitution leaves in its command under shellCommandsWithDepth. */
export const SUBSTITUTED = '$(…)'

/**
 * The same segments, except that each simple command stays WHOLE: a command
 * or process substitution (`$(…)`, `<(…)`, `>(…)`) leaves SUBSTITUTED in the
 * word it sits in (its own commands come back as segments ahead of that
 * command), and the `&` of an fd redirect
 * (`2>&1`, `&>`) is part of its word. Under shellSegmentsWithDepth both end the
 * segment, so the arguments after them come back as a command of their own —
 * fine for finding a verb, wrong for a caller reading one command's flags.
 */
export const shellCommandsWithDepth = cmd => segment(cmd, true)

const segment = (cmd, wholeCommands) => {
  const segments = []
  let tokens = []
  let cur = ''
  let started = false // distinguishes '' (a real empty token) from no token
  let quote = null // ' or " while inside a quoted span
  let escaped = false
  const scopes = [] // open subshell scopes; length IS the current depth
  const heredocs = [] // delimiters announced on this line, awaiting their bodies

  const pushToken = () => {
    if (started) tokens.push(cur)
    cur = ''
    started = false
  }
  // Every scope change closes the segment first, so a segment's tokens all
  // live at one depth — scopes.length at push time. A whole command is not
  // closed by a substitution: it is set aside on the substitution's scope and
  // picked up again when that closes.
  const pushSegment = () => {
    pushToken()
    if (tokens.length) segments.push({ tokens, depth: scopes.length })
    tokens = []
  }
  const openSubstitution = kind => {
    if (wholeCommands) {
      scopes.push({ kind, quote, outer: { tokens, cur } })
      tokens = []
      cur = ''
      started = false
    } else {
      pushSegment()
      scopes.push({ kind, quote })
    }
    quote = null
  }
  const closeSubstitution = () => {
    pushSegment()
    const { quote: outerQuote, outer } = scopes.pop()
    quote = outerQuote
    if (outer) {
      tokens = outer.tokens
      cur = outer.cur + SUBSTITUTED
      started = true
    }
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
      // Inside double quotes bash lets a backslash escape only $ ` " \ and a
      // newline; before any other character the backslash stays in the word.
      const next = cmd[i + 1]
      if (quote === '"' && (next === undefined || !'$`"\\\n'.includes(next))) {
        cur += ch
        started = true
        continue
      }
      escaped = true
      continue
    }
    if (ch === '$' && cmd[i + 1] === '(') {
      openSubstitution('subst')
      i++
      continue
    }
    if (ch === '`') {
      if (scopes.at(-1)?.kind === 'backtick') closeSubstitution()
      else openSubstitution('backtick')
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
    if (ch === '(' && wholeCommands && /[<>]$/.test(cur)) {
      openSubstitution('subst')
      continue
    }
    if (ch === '(') {
      pushSegment()
      scopes.push({ kind: 'paren', quote: null })
      continue
    }
    if (ch === ')') {
      const top = scopes.at(-1)
      if (top?.kind === 'subst') closeSubstitution()
      else {
        pushSegment()
        if (top?.kind === 'paren') scopes.pop()
      }
      continue
    }
    if (ch === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<' && cmd[i - 1] !== '<') {
      pushToken()
      let j = i + 2
      let dash = false
      if (cmd[j] === '-') {
        dash = true
        j++
      }
      while (j < cmd.length && (cmd[j] === ' ' || cmd[j] === '\t')) j++
      let delim = ''
      let dq = null
      while (j < cmd.length) {
        const c = cmd[j]
        if (dq) {
          if (c === dq) dq = null
          else delim += c
          j++
          continue
        }
        if (c === "'" || c === '"') {
          dq = c
          j++
          continue
        }
        if (/[\s;&|()<>`]/.test(c)) break
        if (c === '\\' && j + 1 < cmd.length) {
          delim += cmd[j + 1]
          j += 2
          continue
        }
        delim += c
        j++
      }
      if (delim) {
        heredocs.push({ delim, dash })
        i = j - 1
        continue
      }
      cur += ch
      started = true
      continue
    }
    if (ch === '\n' && heredocs.length) {
      pushSegment()
      let j = i + 1
      while (heredocs.length) {
        const { delim, dash } = heredocs.shift()
        const body = []
        while (j <= cmd.length) {
          const eol = cmd.indexOf('\n', j)
          const end = eol === -1 ? cmd.length : eol
          const line = cmd.slice(j, end)
          j = eol === -1 ? cmd.length + 1 : eol + 1
          if ((dash ? line.replace(/^\t+/, '') : line) === delim) break
          body.push(line)
          if (eol === -1) break
        }
        const words = body.join('\n').split(/\s+/).filter(Boolean)
        if (words.length) segments.push({ tokens: words, depth: scopes.length, heredoc: true })
      }
      i = Math.min(j, cmd.length + 1) - 1
      continue
    }
    if (wholeCommands && ch === '&' && (cmd[i - 1] === '>' || cmd[i - 1] === '<' || cmd[i + 1] === '>')) {
      cur += ch
      started = true
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
  // An unclosed substitution still hands back the command it sat in.
  while (wholeCommands && scopes.length) {
    if (scopes.at(-1).outer) closeSubstitution()
    else {
      pushSegment()
      scopes.pop()
    }
  }
  pushSegment()
  return segments
}
