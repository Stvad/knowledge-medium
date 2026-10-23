#!/usr/bin/env node
/**
 * Secret-file read guard (a PreToolUse(Bash) hook, wired in
 * `.claude/settings.json` and `.codex/hooks.json`).
 *
 * Blocks a Bash command that READS a local secret env file (`.env`,
 * `.env.local`, `.env.production`, `.envrc`, …), so its contents can't be
 * auto-dumped into the transcript with no human in the loop. The repo's
 * secret-handling policy (AGENTS.md) is "don't read .env unless the user
 * explicitly asks" — this enforces the default-deny half; an explicit,
 * user-authorized read is allowed by prefixing the command with `READ_ENV_OK=1`.
 *
 * Scope: a backstop against ACCIDENTAL reads, not a sandbox against a
 * determined agent — `node -e`, python, a glob, a variable or a `find -exec`
 * that never names the file all pass.
 *
 * Why a hook and not permission globs: `Read(.env*)` / `Bash(... .env*)` rules
 * are fragile — per the Claude Code docs the Read→Bash bridge applies to `deny`
 * only (not `ask`), so `cat`/`head`/`tail` of `.env` slip an ask-rule; and arg
 * globs miss `./.env`, `config/.env`, and abs paths.
 *
 * A command reads a secret file when, in any command it runs (one inside
 * `$(…)`, backticks or `<(…)`, as the shared tokenizer reads them, or inside
 * `bash -c '…'` or `eval`):
 *  - a reader verb (cat, head, grep, …, or git's `diff`/`grep --no-index`) has
 *    a secret path operand. A list of readers rather than "any command naming
 *    the file", because many commands that name one only list, test, copy or
 *    mention it (`ls`, `test -f`, `cp`, `node --env-file`, a commit message);
 *  - its input is redirected from a secret path (`< .env`, `$(<.env)`);
 *  - it is a recursive grep, or an `rg` that reads hidden AND ignored files or
 *    has a glob admitting one, over a directory holding a secret file at its
 *    top level (where a checkout keeps them) that its name globs admit.
 *    Refusing every `grep -r` would block every search of `src/`; a search
 *    root above that directory (`grep -r X ..` from a subdirectory) is not
 *    checked. Claude Code's `grep` is a ugrep shim that skips ignored files,
 *    so a `grep -r` refused there would not have read the file: accepted, as
 *    `/usr/bin/grep` and the shim's fallbacks would.
 * Which words are patterns, files and roots comes from each reader family's
 * table of options that take a value (OPTIONS). Where a command runs follows
 * its own cd and pushd as the stash guard reads them (commandsInContext).
 * Non-secret templates (`.env.example` / `.sample` / `.template` / `.dist` /
 * `.defaults`) are not secret files.
 *
 * Reads the hook payload (JSON) on stdin. Exit 2 → block; exit 0 → allow.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { commandsInContext, effectiveCwd, expandTilde, gitCommand } from './check-stash-worktree.mjs'
import { readHookPayload } from './hook-context.mjs'
import { isMainModule } from './is-main-module.mjs'
import { inputRedirectTargets, shellCommandsWithDepth } from './shell-segments.mjs'

// The reader families that share an option table.
const GREPS = new Set(['grep', 'egrep', 'fgrep', 'zgrep', 'zegrep', 'zfgrep', 'ugrep', 'ug'])
const RGS = new Set(['rg', 'ripgrep'])
const AWKS = new Set(['awk', 'gawk', 'mawk', 'nawk'])
// Search verbs take a PATTERN or program as their first operand (not a file),
// so a `.env` *pattern* (`grep ".env" src/`) must not be read as a `.env` file
// — unless an option supplies it (`-e K`, `--regexp=K`, `sed -f s.sed`).
const SEARCH = new Set([...GREPS, ...RGS, ...AWKS, 'sed', 'jq', 'ag'])
// Commands that read/dump file contents (or, for source/`.`, load+expose them).
const READERS = new Set([
  ...SEARCH, 'cat', 'head', 'tail', 'less', 'more', 'nl', 'tac', 'od', 'xxd',
  'hexdump', 'strings', 'sort', 'base64', 'cut', 'dd', 'bat', 'view', 'source',
  '.', 'diff', 'sdiff', 'comm', 'paste', 'column', 'uniq', 'rev', 'fold', 'pr',
  'expand', 'unexpand',
])

// Each reader's options that take a value (attached, `=`-joined or the next
// word), by what the value is: the search's 'pattern', a 'script' file the
// pattern is read from, a 'file' it reads, grep's 'include' / 'exclude' name
// glob, rg's 'glob' / case-blind 'iglob' (a leading `!` excludes), grep's
// 'directories' action (`recurse` walks), or a 'value' that is none of these. A reader's option missing here leaves its
// value to be read as an operand, which only over-checks; so is an option
// whose value is optional or absent in some implementation (BSD grep's -C,
// BSD sed's -l), since taking the next word there would drop the file.
const values = names => Object.fromEntries(names.split(' ').map(n => [n, 'value']))
const GREP_OPTIONS = {
  e: 'pattern', regexp: 'pattern', f: 'script', file: 'script',
  include: 'include', exclude: 'exclude', 'exclude-from': 'file', d: 'directories', directories: 'directories',
  ...values('A B D m after-context before-context devices exclude-dir max-count label binary-files group-separator'),
}
const RG_OPTIONS = {
  e: 'pattern', regexp: 'pattern', f: 'script', file: 'script', 'ignore-file': 'file',
  g: 'glob', glob: 'glob', iglob: 'iglob',
  ...values('A B C E M T j m r t after-context before-context context encoding engine max-columns max-count max-depth max-filesize path-separator pre pre-glob replace sort sortr threads type type-add type-not'),
}
const OPTIONS = {
  ...Object.fromEntries([...GREPS].map(v => [v, GREP_OPTIONS])),
  ...Object.fromEntries([...RGS].map(v => [v, RG_OPTIONS])),
  ...Object.fromEntries([...AWKS].map(v => [v, { e: 'pattern', source: 'pattern', f: 'script', file: 'script', ...values('F v assign field-separator') }])),
  sed: { e: 'pattern', expression: 'pattern', f: 'script', file: 'script' },
  diff: {
    X: 'file', 'exclude-from': 'file', 'from-file': 'file', 'to-file': 'file',
    ...values('x I L S U C W exclude ignore-matching-lines label starting-file width tabsize'),
  },
}
// An operand the shell expands (a glob, a brace list, a variable, a
// substitution) names paths this cannot see.
const EXPANDS = /[*?[{$]/
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash'])

// A secret env file as a path token: preceded by a boundary (the word's start,
// or a character a path can follow inside one: whitespace, a quote, `=`, `(`,
// `:`, a slash, a brace list's `{` or `,`, or shell punctuation quoted into
// the word), then either `.envrc`
// (direnv) or `.env` + a CHAIN of dotted suffixes (`.env.local`,
// `.env.production.local`), then a non-word char. CASE-INSENSITIVE: the dev FS
// is case-insensitive, so `.ENV.LOCAL` reads the same bytes as `.env.local` and
// must block too. m[1] = the full file token; m[2] = the `.env` suffix chain
// (undefined for `.envrc`, "" for bare `.env`).
const ENV_REF = /(?:^|[\s='"(:;|&`/\\{,])(\.envrc|\.env((?:\.[a-z0-9_-]+)*))(?![\w-])/gi
// A suffix that is EXACTLY one non-secret template token. A COMPOUND suffix like
// `.example.local` is a real local override, NOT a template, so it still blocks.
const TEMPLATE = /^\.(example|sample|template|dist|defaults)$/i

/** The secret env file a word names, or null. */
const secretPathIn = word => {
  for (const m of word.matchAll(ENV_REF)) {
    const suffix = m[2] // undefined for `.envrc`; "" / ".local" / ".example.local" for `.env…`
    if (suffix !== undefined && TEMPLATE.test(suffix)) continue
    return m[1]
  }
  return null
}

/** A secret file directly inside `dir` that `admits` lets through, or null (also when `dir` is no directory). */
const secretFileIn = (dir, admits) => {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  return entries.find(e => !e.isDirectory() && secretPathIn(e.name) && admits(e.name))?.name ?? null
}

// An option word's boolean short-flag `letters`, and the `role` of the value
// it takes (null if none) with the `value` attached to it, if any.
const optionOf = (a, options) => {
  const long = /^--([^=]+)(?:=(.*))?$/s.exec(a)
  if (long) return { letters: '', role: Object.hasOwn(options, long[1]) ? options[long[1]] : null, value: long[2] }
  let k = 1
  while (/[a-zA-Z.]/.test(a[k] ?? '') && !Object.hasOwn(options, a[k])) k++
  const role = Object.hasOwn(options, a[k] ?? '') ? options[a[k]] : null
  return { letters: a.slice(1, k), role, value: role ? a.slice(k + 1) || undefined : undefined }
}

/**
 * A reader's words sorted for the checks: `paths` may name a file it reads
 * (every word but a search's pattern and an option value known to name no
 * file), `roots` are its operands, which a recursive search walks, `letters`
 * are its short flags, `filters` its name globs in order, and `directories`
 * grep's directory actions.
 */
const readerWords = (verb, args) => {
  const options = OPTIONS[verb] ?? {}
  const paths = []
  const roots = []
  const filters = []
  const directories = []
  let letters = ''
  let globCaseless = false // rg's --[no-]glob-case-insensitive, the last one read as an option
  let patternGiven = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') {
      paths.push(...args.slice(i + 1))
      roots.push(...args.slice(i + 1))
      break
    }
    if (a === '-' || !a.startsWith('-')) {
      paths.push(a)
      roots.push(a)
      continue
    }
    if (a === '--glob-case-insensitive' || a === '--no-glob-case-insensitive') globCaseless = a === '--glob-case-insensitive'
    const option = optionOf(a, options)
    letters += option.letters
    if (!option.role) {
      paths.push(a)
      continue
    }
    const { role } = option
    const value = option.value ?? args[++i] ?? ''
    if (role === 'pattern' || role === 'script') patternGiven = true
    if (role === 'directories') directories.push(value)
    if (role === 'script' || role === 'file') paths.push(value)
    if (role === 'include' || role === 'exclude') filters.push({ include: role === 'include', glob: value, dialect: 'grep' })
    if (role === 'glob' || role === 'iglob')
      filters.push({ include: !value.startsWith('!'), glob: value.replace(/^!/, ''), dialect: 'rg', caseless: role === 'iglob' })
  }
  if (SEARCH.has(verb) && !patternGiven && roots.length) paths.splice(paths.indexOf(roots.shift()), 1)
  // rg's --glob-case-insensitive makes every -g an --iglob
  if (globCaseless) for (const f of filters) if (f.dialect === 'rg') f.caseless = true
  return { paths, roots, letters, filters, directories }
}

// A name glob as a regex, `*` and `?` matching a leading dot too and rg's
// `{a,b}` either one; null for syntax not modelled here (a class, an escape,
// grep's braces or `!`), so the filter it is in admits every name. rg's globs
// are paths from the search root: a leading `/` anchors there and a `**/`
// opening the glob or a brace alternative may match no directory, while any
// other `/` (a trailing one included, which names directories) matches no
// top-level name.
const globRegex = ({ glob, dialect, caseless }) => {
  if (/[[\]\\]/.test(glob) || (dialect === 'grep' && /[{}!]/.test(glob))) return null
  const rg = dialect === 'rg'
  let source = ''
  let depth = 0
  const start = rg && glob.startsWith('/') ? 1 : 0
  for (let i = start; i < glob.length; i++) {
    const c = glob[i]
    if (rg && glob.startsWith('**/', i) && (i === start || (depth && '{,'.includes(glob[i - 1])))) {
      source += '(?:.*/)?'
      i += 2
    } else if (c === '*') source += '.*'
    else if (c === '?') source += '.'
    else if (c === '{') {
      source += '(?:'
      depth++
    } else if (c === '}' && depth) {
      source += ')'
      depth--
    } else if (c === ',' && depth) source += '|'
    else source += c.replace(/[.+^$(){}|]/, '\\$&')
  }
  return depth ? null : new RegExp(`^${source}$`, caseless ? 'i' : '')
}

// The last filter that matches `name`, or null; undefined when a filter is not modelled.
const lastMatch = filters => {
  const regexes = filters.map(globRegex)
  return regexes.includes(null) ? undefined : name => filters.findLast((f, i) => regexes[i].test(name)) ?? null
}

/** Which top-level names a recursive search reads, as a predicate, or null when it is not one. */
const walkedNames = (verb, args, { letters, filters, directories }) => {
  const last = lastMatch(filters)
  if (GREPS.has(verb)) {
    const recursive =
      /[rR]/.test(letters) ||
      directories.includes('recurse') ||
      args.some(a => a === '--recursive' || a === '--dereference-recursive')
    if (!recursive) return null
    // grep: the last filter that matches wins; with none, a name is read unless the first filter is an include
    return last ? name => last(name)?.include ?? !filters[0]?.include : () => true
  }
  if (RGS.has(verb)) {
    // rg skips hidden and gitignored files by default; a checkout gitignores its
    // env files, so it reads them only with both turned off. Any --no-ignore*
    // counts: which one drops the rule hiding a secret depends on where that
    // rule lives (--no-ignore-parent drops a .gitignore above the search root).
    const u = (letters.match(/u/g)?.length ?? 0) + args.filter(a => a === '--unrestricted').length
    const hidden = u >= 2 || letters.includes('.') || args.includes('--hidden')
    const noIgnore = u >= 1 || args.some(a => a.startsWith('--no-ignore'))
    // A glob decides past both rules: the last that matches wins, and a name
    // none matches is left out once any include glob is given.
    if (!filters.length) return hidden && noIgnore ? () => true : null
    return last ? name => last(name)?.include ?? (hidden && noIgnore && !filters.some(f => f.include)) : () => true
  }
  if (verb === 'ag') {
    // ag walks by default, skipping hidden and ignored files; its own filters are not modelled
    const unrestricted = letters.includes('u') || args.includes('--unrestricted')
    const ignoresVcs = letters.includes('U') || args.includes('--skip-vcs-ignores')
    return unrestricted || (args.includes('--hidden') && ignoresVcs) ? () => true : null
  }
  return null
}

// git's readers of files it does not track, as the reader each one is: a
// `diff` reads its path operands (a path outside the repo implies
// --no-index, so every one counts), and a `grep` that reads ignored files
// (--no-index unless --exclude-standard is the last of that pair, or
// --untracked when --no-exclude-standard is) searches the directory. `words`
// start at `git`; `assigns` are its leading assignments, as GIT_WORK_TREE
// can name the work tree. An abbreviated long option is not recognised.
const gitReader = (words, assigns) => {
  const git = gitCommand(words)
  if (!git) return null
  const { word, rest, cArgs } = git
  // each -C is relative to the one before; a grep of untracked files
  // searches the work tree, while --no-index searches the current directory
  const dirs = cArgs.flatMap((a, i) => (a === '-C' ? [cArgs[i + 1]] : []))
  const tree =
    cArgs.flatMap((a, i) => (a === '--work-tree' ? [cArgs[i + 1]] : a.startsWith('--work-tree=') ? [a.slice(12)] : [])).at(-1) ??
    assigns.findLast(a => a.startsWith('GIT_WORK_TREE='))?.slice('GIT_WORK_TREE='.length)
  const noIndex = rest.includes('--no-index')
  if (word === 'diff') return { verb: 'diff', args: rest.filter(a => a !== '--no-index'), dirs }
  const standard = rest.findLast(a => a === '--exclude-standard' || a === '--no-exclude-standard')
  const readsIgnored = noIndex ? standard !== '--exclude-standard' : rest.includes('--untracked') && standard === '--no-exclude-standard'
  if (word === 'grep' && readsIgnored) return { verb: 'grep', args: ['-r', ...rest], dirs: tree && !noIndex ? [...dirs, expandTilde(tree)] : dirs }
  return null
}

// The words `bash -c` (any flag cluster holding c) may run as its script:
// every word after that flag, since which one it is depends on options whose
// values are not modelled here (`-o pipefail`, `-O extglob`).
const shellScriptsOf = args => {
  const c = args.findIndex(a => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
  return c < 0 ? [] : args.slice(c + 1)
}

/** The secret file `script` reads when run in `cwd`, as `{ file, walked }`, or null. */
export const secretRead = (script, cwd) => {
  for (const target of inputRedirectTargets(script)) {
    const file = secretPathIn(target)
    if (file) return { file, walked: false }
  }
  for (const { words, assigns, cdPath, text } of commandsInContext(shellCommandsWithDepth(script))) {
    if (text) continue // heredoc data nothing runs
    let verb = (words[0] ?? '').replace(/.*\//, '') // basename, strip any path
    let args = words.slice(1)
    let here
    let at = () => (here ??= effectiveCwd(cwd, cdPath).cwd)

    const nested = verb === 'eval' ? [args.join(' ')] : SHELLS.has(verb) ? shellScriptsOf(args) : []
    for (const inner of nested) {
      const hit = secretRead(inner, at())
      if (hit) return hit
    }

    const git = verb === 'git' ? gitReader(words, assigns) : null
    if (git) {
      ;({ verb, args } = git)
      if (git.dirs.length) {
        const base = at()
        at = () => resolve(base, ...git.dirs)
      }
    }
    if (!READERS.has(verb)) continue
    const reader = readerWords(verb, args)
    const { paths, roots } = reader
    for (const word of paths) {
      const file = secretPathIn(word)
      if (file) return { file, walked: false }
    }
    const admits = walkedNames(verb, args, reader)
    if (!admits) continue
    // An operand naming no path is the value of an option not modelled here,
    // so with none naming one the search runs where grep would: at `.`.
    const located = roots.map(root => ({ root, dir: resolve(at(), expandTilde(root)) }))
    const named = located.filter(({ root, dir }) => EXPANDS.test(root) || existsSync(dir))
    for (const { root, dir } of named.length ? named : [{ root: '.', dir: at() }]) {
      const file = secretFileIn(dir, admits)
      if (file) return { file: join(root, file), walked: true }
    }
  }
  return null
}

const main = () => {
  const hook = readHookPayload(/\S/)
  // the opt-out counts only as the prefix: text that mentions it waives nothing
  if (!hook || /^\s*READ_ENV_OK=1\s/.test(hook.cmd)) return
  const hit = secretRead(hook.cmd, hook.cwd)
  if (!hit) return
  process.stderr.write(
    (hit.walked
      ? `BLOCKED: this recursive search reads a local secret file (${hit.file}). Search a ` +
        `narrower path, or use plain rg, which skips hidden and gitignored files.\n`
      : `BLOCKED: this command reads a local secret file (${hit.file}).\n`) +
      `Repo policy is to not read .env files unless the user explicitly asks (AGENTS.md ` +
      `secret-handling); the contents would land in the transcript.\n` +
      `If the user explicitly asked for this, re-run with READ_ENV_OK=1 prefixed.\n`,
  )
  process.exit(2)
}

if (isMainModule(import.meta.url)) main()
