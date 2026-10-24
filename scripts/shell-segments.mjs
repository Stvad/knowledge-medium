/**
 * Split a shell command string into segments of unquoted tokens, for
 * Bash hooks that must act on VERB POSITION rather than substring
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
 * Redirections (`2>&1`, `> f`, `&> f`, `2>/dev/null`, `<<< w`) are neither
 * segment boundaries nor arguments: the operator and its target are dropped,
 * so `git push origin 2>&1 | tail` yields ['git', 'push', 'origin']. As in
 * bash, an unquoted `<` or `>` ends the word before it (`f>/dev/null` is `f`
 * and a redirection); a quoted or escaped one is text.
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
 *    its own commands come back as segments ahead of that command. Under
 *    shellSegmentsWithDepth a substitution ends the segment, and the
 *    arguments after it come back as a command of their own;
 *  - a `#` comment is skipped, and a `$'…'` string is one quoted span, so an
 *    apostrophe in either cannot open a quote that swallows what follows;
 *  - heredoc data a shell reads (`bash <<'EOF'`) comes back as the commands
 *    of the script it is, read whole. Data a text reader takes comes back
 *    line by line (`\`-continued lines joined), so a call in it ends with its
 *    line: read as commands when its substitutions run (an unquoted
 *    delimiter), and otherwise only split into words, with its segments
 *    flagged `text: true`.
 */
export const shellCommandsWithDepth = cmd => segment(cmd, true)

/**
 * The file each input redirection reads (`< f`, `0<f`, `$(<f)`), read as
 * shellCommandsWithDepth reads the command, so a heredoc line a shell runs
 * counts and a quoted `<` does not. A here-string (`<<<`), a here-doc and an
 * fd dup (`<&3`) read no file and are not listed.
 */
export const inputRedirectTargets = cmd => {
  const targets = []
  segment(cmd, true, { inputRedirects: targets })
  return targets
}

/**
 * The command with each quoted-delimiter heredoc's data (`<<'EOF'`) cut out,
 * when what reads it is no shell: text nothing runs or expands. An unquoted
 * heredoc's data stays, since its `$(…)` and backticks run, and so does data
 * fed to a shell (`bash <<'EOF'`), which runs it as a script.
 */
export const withoutLiteralHeredocs = cmd => {
  const spans = []
  segment(cmd, true, { literalHeredocs: spans })
  let out = ''
  let at = 0
  for (const [start, end] of spans) {
    out += cmd.slice(at, start)
    at = end
  }
  return out + cmd.slice(at)
}

// A quoted-delimiter heredoc's data is literal when nothing on its line can
// run it. Decided by an ALLOWLIST of commands that never run what they read:
// a shell, a wrapper, an expanded or unknown command word anywhere on the
// line keeps the data runnable, so a reader this list misses fails closed. A
// bare assignment (`S=x;`) runs nothing.
// python and node run their stdin as their own language; a gh call from that
// code sits in quoted strings no reader here sees, counted or not, so listing
// them only keeps their heredocs that mention a call from blocking.
const TEXT_READERS = new Set(['cat', 'tee', 'cd', 'git', 'gh', 'bd', 'python', 'python3', 'node', 'printf', 'echo', 'wc', 'grep', 'head', 'tail', 'sort', 'uniq', 'jq', 'mkdir'])
// A command's own word: past its leading assignments, path dropped.
const commandWord = words => words.find(w => !/^[A-Za-z_]\w*=/.test(w))?.replace(/^.*\//, '')
// Assignments alone, none of them substituting: a value that substitutes can
// capture the data and run it later (`S=$(cat <<'EOF' …)`, then `eval "$S"`).
const runsNothing = words => commandWord(words) === undefined && !words.some(w => w.includes(SUBSTITUTED))
// An unquoted word that is a redirection operator (first group), with its
// target attached (second group) or empty when the target is the next word.
const REDIRECT = /^(?:\d+|&)?(<<<|<>|>>|>\||>&|>|<)(.*)$/s
// the redirection operators that open their target for reading
const READS = new Set(['<', '<>'])

// `sinks.literalHeredocs`, when given, collects the [start, end) of each
// literal heredoc's data, its closing delimiter line included;
// `sinks.inputRedirects` collects each input redirection's target word;
// `sinks.substitutions` collects the segments inside a `$(…)` or backticks.
// `expanding` reads cmd as unquoted heredoc data its supplying shell
// expands: text, quotes and `#` included, but for substitutions and `\`.
const segment = (cmd, wholeCommands, sinks = {}, expanding = false) => {
  const segments = []
  let tokens = []
  let cur = ''
  let started = false // distinguishes '' (a real empty token) from no token
  let literal = expanding // the current token holds a quoted or escaped character
  let dropNext = false // the operator whose target is the next token, or false
  let quote = expanding ? '<<' : null // ', ", $' inside a quoted span; << through expanded heredoc data
  let escaped = false
  const scopes = [] // open subshell scopes; length IS the current depth
  let lineStart = 0 // index of the first segment of the current line
  let pipeOpen = false // a `|`, `|&`, `&&` or `||` with no command after it yet
  let freshFrom = Infinity // the shallowest scope opened since the last segment
  let listStart = 0 // index of the first segment of the and-or list being read, which goes on while pipeOpen
  let pipeStart = 0 // the same for the command of a pipeline being read
  const heredocs = [] // delimiters announced on this line, awaiting their bodies

  const pushToken = () => {
    if (started) {
      pipeOpen = false
      const redirect = !literal && cur.match(REDIRECT)
      if (dropNext) {
        if (READS.has(dropNext)) sinks.inputRedirects?.push(cur)
        dropNext = false
      } else if (redirect) {
        const [, op, target] = redirect
        if (target === '') dropNext = op
        else if (READS.has(op) && !target.startsWith('&')) sinks.inputRedirects?.push(target)
      } else tokens.push(cur)
    }
    cur = ''
    started = false
    literal = false
  }
  // A redirect operator glued to a quoted or escaped target (`<".env"`,
  // `<\.env`, `<$'.env'`) ends before it, so the target is read as its word.
  // A here-string's word is text, not a target: it stays a word, so the
  // scanners that read words still see it.
  const endBareOperator = () => {
    const [, op, target] = (!literal && cur.match(REDIRECT)) || []
    if (target === '' && op !== '<<<') pushToken()
  }
  // Every scope change closes the segment first, so a segment's tokens all
  // live at one depth — scopes.length at push time. A whole command is not
  // closed by a substitution: it is set aside on the substitution's scope and
  // picked up again when that closes.
  const pushSegment = () => {
    pushToken()
    dropNext = false
    if (tokens.length) {
      const pushed = { tokens, depth: scopes.length, ...(freshFrom <= scopes.length && { fresh: freshFrom }) }
      segments.push(pushed)
      if (scopes.some(s => s.expands)) sinks.substitutions?.add(pushed)
      freshFrom = Infinity
    }
    tokens = []
  }
  // a scope keeps the list and pipeline command it opened in, which go on when it closes
  const openScope = scope => {
    scopes.push({ ...scope, listStart, pipeStart })
    listStart = pipeStart = segments.length
    freshFrom = Math.min(freshFrom, scopes.length)
  }
  const closeScope = () => {
    const scope = scopes.pop()
    ;({ listStart, pipeStart } = scope)
    return scope
  }
  // A list a lone `&` ends, and each command of a pipeline but its last, runs
  // in a subshell: the segments from `start` move into a scope of their own,
  // one deeper. The last command of a pipeline is read as zsh runs it, in the
  // shell itself; bash runs it in a subshell too.
  const subshell = start => {
    const moved = segments.slice(start)
    for (const s of moved) {
      s.depth++
      if (s.fresh) s.fresh++
    }
    if (moved.length) moved[0].fresh = scopes.length + 1
  }
  // `expands`: the shell supplying unquoted heredoc data expands it, as it
  // does not a process substitution
  const openSubstitution = (kind, expands = true) => {
    if (wholeCommands) {
      openScope({ kind, quote, expands, outer: { tokens, cur, literal, dropNext } })
      tokens = []
      cur = ''
      started = false
      literal = false
      dropNext = false
    } else {
      pushSegment()
      openScope({ kind, quote, expands })
    }
    quote = null
  }
  const closeSubstitution = () => {
    pushSegment()
    const { quote: outerQuote, outer } = closeScope()
    quote = outerQuote
    if (outer) {
      tokens = outer.tokens
      cur = outer.cur + SUBSTITUTED
      started = true
      literal = outer.literal
      dropNext = outer.dropNext
    }
  }

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (escaped) {
      escaped = false
      if (ch === '\n') continue // \<newline> is a continuation — bash drops it
      cur += ch
      started = true
      literal = true
      continue
    }
    if (quote === "$'") {
      // an escape decodes to a character this reader does not reproduce
      // (`\x2d` is `-`), so it leaves a `$`: the word reads as an expansion
      if (ch === '\\') cur += `$${cmd[++i] ?? ''}`
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
      endBareOperator()
      escaped = true
      continue
    }
    if (wholeCommands && !quote && ch === '$' && cmd[i + 1] === "'") {
      endBareOperator()
      quote = "$'"
      started = true
      literal = true
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
    if (quote === '"' || quote === '<<') {
      if (quote === '"' && ch === '"') quote = null
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
      endBareOperator()
      quote = ch
      started = true
      literal = true
      continue
    }
    if (ch === '(' && wholeCommands && /[<>]$/.test(cur)) {
      // a process substitution is a word (a /dev/fd path), not a redirection
      literal = true
      openSubstitution('subst', false)
      continue
    }
    if (ch === '(') {
      pushSegment()
      openScope({ kind: 'paren', quote: null })
      continue
    }
    if (ch === ')') {
      const top = scopes.at(-1)
      if (top?.kind === 'subst') closeSubstitution()
      else {
        pushSegment()
        if (top?.kind === 'paren') closeScope()
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
    }
    if (ch === '\n' && heredocs.length) {
      pushSegment()
      // what reads the data is anywhere on the line (`cat <<'EOF' | bash` runs
      // it), read in its words as the shell builds them, a command held open
      // around a substitution included with the word that substitution sits in
      const lineCommands = [
        ...segments.slice(lineStart).map(s => s.tokens),
        ...scopes.flatMap(s => (s.outer ? [[...s.outer.tokens, s.outer.cur + SUBSTITUTED]] : [])),
      ]
      // a pipe or list left open at the newline, or a subshell, goes on past
      // the data to a reader not read yet
      const readerPending = scopes.some(s => s.kind === 'paren') || pipeOpen
      const onlyTextReaders = !readerPending && lineCommands.every(words => runsNothing(words) || TEXT_READERS.has(commandWord(words)))
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
          // Data something may run comes back read both ways when they
          // differ: whole, as a shell reading it as its script does, so a
          // subshell or a quote spans its lines; and a line at a time, as the
          // quote-blind expansion of unquoted data or a reader of another
          // language sees it, so an apostrophe on one line cannot hide the
          // next. Unquoted data's substitutions come first, as a reading of
          // their own: the shell supplying the data runs them before its
          // reader runs any of it, its quotes and comments being text to that
          // shell. Which command reads the data is not
          // settled here, so a consumer can see a command more than once;
          // each later reading's first segment is flagged `reread`. Text
          // nothing runs is only split into words.
          const byLine = body.join('\n').replace(/\\\n/g, ' ').split('\n')
          if (text) {
            for (const line of byLine) if (line.trim()) segments.push({ tokens: line.split(/\s+/).filter(Boolean), depth: scopes.length, heredoc: true, text: true })
          } else {
            const read = (parts, expanding = false) => {
              const redirects = []
              const substitutions = new Set()
              const read = parts
                .flatMap(part => segment(part, true, { inputRedirects: redirects, substitutions }, expanding))
                .filter(s => !expanding || substitutions.has(s))
              // a heredoc nested in the data keeps its text and reread flags,
              // and `nested` counts the data it sits in: it runs, if at all,
              // in a child of the shell reading this data
              const segments = read.map(s => ({
                tokens: s.tokens,
                depth: scopes.length + s.depth,
                heredoc: true,
                ...(s.text && { text: true }),
                ...(s.reread && { reread: true }),
                ...(s.heredoc && { nested: 1 + (s.nested ?? 0) }),
                ...(s.fresh && { fresh: scopes.length + s.fresh }),
              }))
              return { segments, redirects }
            }
            const lines = read(byLine)
            const whole = read([body.join('\n')])
            const same = JSON.stringify(whole.segments) === JSON.stringify(lines.segments)
            const readings = [...(quoted ? [] : [read([body.join('\n')], true)]), ...(same ? [lines] : [whole, lines])]
            for (const [n, { segments: view }] of readings.filter(r => r.segments.length).entries()) {
              // a later reading starts from the scope the heredoc began in
              if (n > 0) view[0].reread = true
              segments.push(...view)
            }
            for (const { redirects } of readings) sinks.inputRedirects?.push(...redirects)
          }
        } else {
          const words = body.join('\n').split(/\s+/).filter(Boolean)
          if (words.length) segments.push({ tokens: words, depth: scopes.length, heredoc: true })
        }
        if (text) sinks.literalHeredocs?.push([dataStart, Math.min(j, cmd.length)])
      }
      i = Math.min(j, cmd.length + 1) - 1
      lineStart = pipeStart = segments.length
      if (!pipeOpen) listStart = segments.length
      continue
    }
    // `2>&1`, `>&2`, `>|`: the & or | belongs to the redirection before it.
    if ((ch === '&' || ch === '|') && !literal && /^\d*[<>]$/.test(cur)) {
      cur += ch
      continue
    }
    // `&>` and `&>>` redirect both streams; anywhere in a command, even
    // between `git` and its verb, they must not end the segment.
    if (ch === '&' && cmd[i + 1] === '>') {
      pushToken()
      cur = ch
      started = true
      continue
    }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '\n') {
      pushSegment()
      // the next command word closes it, so a newline or a comment in between does not
      const joins = ch === '|' || (ch === '&' && (cmd[i - 1] === '&' || cmd[i - 1] === '|' || cmd[i + 1] === '&'))
      // a | that is not the first of a || ends a pipeline's command (only where
      // comments are skipped, so a | or & in one is not taken for an operator)
      if (wholeCommands && ch === '|' && cmd[i + 1] !== '|') subshell(pipeStart)
      if (joins) pipeOpen = true
      else if (!pipeOpen) {
        if (ch === '&' && wholeCommands) subshell(listStart)
        listStart = segments.length
      }
      pipeStart = segments.length
      if (ch === '\n') lineStart = segments.length
      continue
    }
    if (/\s/.test(ch)) {
      pushToken()
      continue
    }
    // bash ends a word at an unquoted `<` or `>`; digits or a `&` before it
    // are the operator's own (`2>`, `&>`), and `<(` opens a process
    // substitution, which stays in its word.
    if ((ch === '<' || ch === '>') && cmd[i + 1] !== '(' && (literal || !/^(?:\d*|&)[<>]*$/.test(cur))) pushToken()
    cur += ch
    started = true
  }
  // An unclosed substitution still hands back the command it sat in.
  while (wholeCommands && scopes.length) {
    if (scopes.at(-1).outer) closeSubstitution()
    else {
      pushSegment()
      closeScope()
    }
  }
  pushSegment()
  return segments
}
