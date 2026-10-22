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
 * The same segments, read for one command's ARGUMENTS rather than its verb:
 *  - each simple command stays whole. A command or process substitution
 *    (`$(…)`, `<(…)`, `>(…)`) leaves SUBSTITUTED in the word it sits in, and
 *    its own commands come back as segments ahead of that command. The `&` or
 *    `|` of a redirection (`2>&1`, `&>`, `>|`) is part of its word. Under
 *    shellSegmentsWithDepth both end the segment, and the arguments after
 *    them come back as a command of their own;
 *  - a `#` comment is skipped, and a `$'…'` string is one quoted span, so an
 *    apostrophe in either cannot open a quote that swallows what follows;
 *  - heredoc data comes back line by line (`\`-continued lines joined), so a
 *    call in it ends with its line. A line is read as the commands it would
 *    be when a shell reads it (`bash <<'EOF'`) or its substitutions run (an
 *    unquoted delimiter); the text of a quoted heredoc nothing runs is only
 *    split into words.
 */
export const shellCommandsWithDepth = cmd => segment(cmd, true)

/**
 * The command with each quoted-delimiter heredoc's data (`<<'EOF'`) cut out,
 * when what reads it is no shell: text nothing runs or expands. An unquoted
 * heredoc's data stays, since its `$(…)` and backticks run, and so does data
 * fed to a shell (`bash <<'EOF'`), which runs it as a script.
 */
export const withoutLiteralHeredocs = cmd => {
  const literal = []
  segment(cmd, true, literal)
  let out = ''
  let at = 0
  for (const [start, end] of literal) {
    out += cmd.slice(at, start)
    at = end
  }
  return out + cmd.slice(at)
}

// `literal`, when given, collects the [start, end) of each quoted-delimiter
// heredoc's data that nothing on its line can run, its closing delimiter line
// included. Decided by an ALLOWLIST of commands that never run what they
// read: a shell, a wrapper, an expanded or unknown command word anywhere on
// the line keeps the data runnable, so a reader this list misses fails closed.
const TEXT_READERS = new Set(['cat', 'tee', 'cd', 'git', 'gh', 'bd', 'python', 'python3', 'node', 'printf', 'echo', 'wc', 'grep', 'head', 'tail', 'sort', 'uniq', 'jq', 'mkdir'])
// A command's own word: past its leading assignments and redirections, path dropped.
const commandWord = words => {
  for (let i = 0; i < words.length; i++) {
    if (/^[A-Za-z_]\w*=/.test(words[i])) continue
    if (/^(?:\d*|&)[<>]/.test(words[i])) {
      if (/^(?:\d*|&)[<>]+[&|]?$/.test(words[i])) i++
      continue
    }
    return words[i].replace(/^.*\//, '')
  }
}
const segment = (cmd, wholeCommands, literal = null) => {
  const segments = []
  let tokens = []
  let cur = ''
  let started = false // distinguishes '' (a real empty token) from no token
  let quote = null // ' or " while inside a quoted span
  let escaped = false
  let redirectAt = -1 // where the last `<`/`>` the shell reads as an operator sits
  const scopes = [] // open subshell scopes; length IS the current depth
  let lineStart = 0 // index of the first segment of the current line
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
    if (quote === "$'") {
      if (ch === '\\') cur += cmd[++i] ?? ''
      else if (ch === "'") quote = null
      else cur += ch
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
    if (wholeCommands && !quote && ch === '$' && cmd[i + 1] === "'") {
      quote = "$'"
      started = true
      i++
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
    if (wholeCommands && ch === '#' && !started) {
      const eol = cmd.indexOf('\n', i)
      i = (eol === -1 ? cmd.length : eol) - 1
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
      let quoted = false // any quoting in the delimiter turns expansion off in the data
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
          quoted = true
          j++
          continue
        }
        if (/[\s;&|()<>`]/.test(c)) break
        if (c === '\\' && j + 1 < cmd.length) {
          delim += cmd[j + 1]
          quoted = true
          j += 2
          continue
        }
        delim += c
        j++
      }
      if (delim) {
        heredocs.push({ delim, dash, quoted })
        i = j - 1
        continue
      }
      cur += ch
      started = true
      redirectAt = i
      continue
    }
    if (ch === '\n' && heredocs.length) {
      pushSegment()
      // what reads the data is anywhere on the line (`cat <<'EOF' | bash` runs
      // it), read in its words as the shell builds them, a command held open
      // around a substitution included
      const lineCommands = [...segments.slice(lineStart).map(s => s.tokens), ...scopes.flatMap(s => (s.outer ? [s.outer.tokens] : []))]
      const onlyTextReaders = lineCommands.every(words => TEXT_READERS.has(commandWord(words)))
      let j = i + 1
      while (heredocs.length) {
        const { delim, dash, quoted } = heredocs.shift()
        const text = quoted && onlyTextReaders
        const dataStart = j
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
        if (wholeCommands) {
          // a line a shell reads, or whose substitutions run, is read as the
          // commands it would be; text nothing runs is only split into words
          for (const line of body.join('\n').replace(/\\\n/g, ' ').split('\n')) {
            if (!text) for (const s of segment(line, true)) segments.push({ tokens: s.tokens, depth: scopes.length + s.depth, heredoc: true })
            else if (line.trim()) segments.push({ tokens: line.split(/\s+/).filter(Boolean), depth: scopes.length, heredoc: true })
          }
        } else {
          const words = body.join('\n').split(/\s+/).filter(Boolean)
          if (words.length) segments.push({ tokens: words, depth: scopes.length, heredoc: true })
        }
        if (text) literal?.push([dataStart, Math.min(j, cmd.length)])
      }
      i = Math.min(j, cmd.length + 1) - 1
      lineStart = segments.length
      continue
    }
    // bash's redirections spelled with `&` or `|` — `>&`, `<&`, `&>`, `>|` —
    // joined only to a `<`/`>` the shell reads as an operator: after an
    // escaped or quoted one, `|` is a pipe.
    if (wholeCommands && ((ch === '&' && (redirectAt === i - 1 || cmd[i + 1] === '>')) || (ch === '|' && redirectAt === i - 1 && cmd[i - 1] === '>'))) {
      cur += ch
      started = true
      continue
    }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '\n') {
      pushSegment()
      if (ch === '\n') lineStart = segments.length
      continue
    }
    if (/\s/.test(ch)) {
      pushToken()
      continue
    }
    cur += ch
    started = true
    if (ch === '<' || ch === '>') redirectAt = i
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
