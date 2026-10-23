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
 *  - a reader verb (cat, head, grep, …) has a secret path operand. A list of
 *    readers rather than "any command naming the file", because many commands
 *    that name one only list, test, copy or mention it (`ls`, `test -f`, `cp`,
 *    `node --env-file`, a commit message);
 *  - its input is redirected from a secret path (`< .env`, `$(<.env)`);
 *  - it is a recursive grep, or an `rg` told to read hidden AND ignored files,
 *    over a directory holding a secret file at its top level (where a checkout
 *    keeps them) that grep's `--include`/`--exclude` globs admit. Refusing every
 *    `grep -r` would block every search of `src/`; a search root above that
 *    directory (`grep -r X ..` from a subdirectory) is not checked.
 * Where a command runs follows its own cd and pushd as the stash guard reads
 * them (commandsInContext). Non-secret templates (`.env.example` / `.sample` /
 * `.template` / `.dist` / `.defaults`) are not secret files.
 *
 * Reads the hook payload (JSON) on stdin. Exit 2 → block; exit 0 → allow.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { commandsInContext, effectiveCwd, expandTilde } from './check-stash-worktree.mjs'
import { readHookPayload } from './hook-context.mjs'
import { isMainModule } from './is-main-module.mjs'
import { inputRedirectTargets, shellCommandsWithDepth } from './shell-segments.mjs'

// Commands that read/dump file contents (or, for source/`.`, load+expose them).
const READERS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'nl', 'tac', 'od', 'xxd', 'hexdump',
  'strings', 'sort', 'base64', 'cut', 'dd', 'bat', 'view', 'grep', 'egrep',
  'fgrep', 'rg', 'ripgrep', 'sed', 'awk', 'source', '.', 'diff', 'sdiff',
  'comm', 'paste', 'column', 'uniq', 'rev', 'fold',
])
// Search verbs take a PATTERN as their first operand (not a file), so a `.env`
// *pattern* (`grep ".env" src/`) must not be read as a `.env` file — unless a
// flag supplies the pattern or program (`-e K`, `--regexp=K`, `sed -f s.sed`).
const SEARCH = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ripgrep', 'sed', 'awk'])
const GREPS = new Set(['grep', 'egrep', 'fgrep'])
// An operand the shell expands (a glob, a brace list, a variable, a
// substitution) names paths this cannot see.
const EXPANDS = /[*?[{$]/
// Options whose value is a name glob rather than a file, per reader.
const NAME_FILTERS = { grep: ['--include', '--exclude', '--exclude-dir'], diff: ['--exclude', '-x'] }
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash'])

// A secret env file as a path token: preceded by a boundary (start / whitespace
// / quote / = ( : / slash / a brace list's `{` or `,`), then either `.envrc`
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

// A search's pattern or program given by a flag, as { file, value }: -e,
// --regexp and --expression supply it, -f and --file name a file it is read
// from. `value` is undefined when it is the next word.
const patternFlag = a => {
  const long = /^--(regexp|expression|file)(?:=(.*))?$/s.exec(a)
  if (long) return { file: long[1] === 'file', value: long[2] }
  const short = /^-[a-zA-Z]*?([ef])(.*)$/s.exec(a)
  return short ? { file: short[1] === 'f', value: short[2] || undefined } : null
}

/**
 * A reader's words sorted for the checks: `paths` may name a file it reads
 * (every word but a search's pattern and a name filter's value, flags and
 * their attached values included), `roots` are its operands, which a
 * recursive search walks, and `filters` are its --include/--exclude globs
 * in order.
 */
const readerWords = (verb, args) => {
  const filterOptions = NAME_FILTERS[GREPS.has(verb) ? 'grep' : verb] ?? []
  const search = SEARCH.has(verb)
  const paths = []
  const roots = []
  const filters = []
  let patternGiven = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') {
      paths.push(...args.slice(i + 1))
      roots.push(...args.slice(i + 1))
      break
    }
    const filter = filterOptions.find(o => a === o || a.startsWith(o.startsWith('--') ? `${o}=` : o))
    if (filter) {
      const glob = a === filter ? (args[++i] ?? '') : a.slice(filter.length + (filter.startsWith('--') ? 1 : 0))
      if (filter !== '--exclude-dir') filters.push({ include: filter === '--include', glob })
      continue
    }
    const pattern = search ? patternFlag(a) : null
    if (pattern) {
      patternGiven = true
      const value = pattern.value ?? args[++i] ?? ''
      if (pattern.file) paths.push(value)
      continue
    }
    paths.push(a)
    if (!a.startsWith('-')) roots.push(a)
  }
  if (search && !patternGiven && roots.length) paths.splice(paths.indexOf(roots.shift()), 1)
  return { paths, roots, filters }
}

// The letters of each short-flag cluster, up to any attached value (`-rnA3` → rnA).
const shortFlags = args => args.map(a => /^-([a-zA-Z.]+)/.exec(a)?.[1] ?? '').join('')

// grep's globs match a leading dot with `*` and `?` (fnmatch without FNM_PERIOD).
const globMatches = (glob, name) =>
  new RegExp('^' + glob.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(name)

// Whether grep reads `name`: the last filter that matches it wins, and with
// none matching it is read unless the first filter is an --include. A glob
// using more than `*` and `?` (a class, an escape, ugrep's `!` or braces) is
// not modelled, so its presence lets every name through.
const grepAdmits = filters => name => {
  if (filters.some(f => /[[\]\\{}!]/.test(f.glob))) return true
  const last = filters.findLast(f => globMatches(f.glob, name))
  return last ? last.include : !filters[0]?.include
}

/** Which top-level names a recursive search reads, as a predicate, or null when it is not one. */
const walkedNames = (verb, args, filters) => {
  const short = shortFlags(args)
  if (GREPS.has(verb)) {
    const recursive =
      /[rR]/.test(short) ||
      args.some(a => a === '--recursive' || a === '--dereference-recursive' || a === '--directories=recurse') ||
      args.some((a, i) => a === '-d' && args[i + 1] === 'recurse')
    return recursive ? grepAdmits(filters) : null
  }
  if (verb === 'rg' || verb === 'ripgrep') {
    // rg skips hidden and gitignored files by default; a checkout gitignores its
    // env files, so it reads them only with both turned off. Any --no-ignore*
    // counts: which one drops the rule hiding a secret depends on where that
    // rule lives (--no-ignore-parent drops a .gitignore above the search root).
    const u = (short.match(/u/g)?.length ?? 0) + args.filter(a => a === '--unrestricted').length
    const hidden = u >= 2 || short.includes('.') || args.includes('--hidden')
    const noIgnore = u >= 1 || args.some(a => a.startsWith('--no-ignore'))
    return hidden && noIgnore ? () => true : null
  }
  return null
}

// The script of `bash -c '…'` (any flag cluster holding c), or undefined.
const shellScriptOf = args => {
  const c = args.findIndex(a => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
  return c < 0 ? undefined : args[c + 1]
}

/** The secret file `script` reads when run in `cwd`, as `{ file, walked }`, or null. */
export const secretRead = (script, cwd) => {
  for (const target of inputRedirectTargets(script)) {
    const file = secretPathIn(target)
    if (file) return { file, walked: false }
  }
  for (const { words, cdPath, text } of commandsInContext(shellCommandsWithDepth(script))) {
    if (text) continue // heredoc data nothing runs
    const verb = (words[0] ?? '').replace(/.*\//, '') // basename, strip any path
    const args = words.slice(1)
    const here = effectiveCwd(cwd, cdPath).cwd

    const nested = verb === 'eval' ? args.join(' ') : SHELLS.has(verb) ? shellScriptOf(args) : undefined
    const inner = nested && secretRead(nested, here)
    if (inner) return inner

    if (!READERS.has(verb)) continue
    const { paths, roots, filters } = readerWords(verb, args)
    for (const word of paths) {
      const file = secretPathIn(word)
      if (file) return { file, walked: false }
    }
    const admits = walkedNames(verb, args, filters)
    if (!admits) continue
    // An operand naming no path is the value of an option not modelled here
    // (`-A 3`), so with none naming one the search runs where grep would: at `.`.
    const named = roots.filter(r => EXPANDS.test(r) || existsSync(resolve(here, expandTilde(r))))
    for (const root of named.length ? named : ['.']) {
      const file = secretFileIn(resolve(here, expandTilde(root)), admits)
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
