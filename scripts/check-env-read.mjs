#!/usr/bin/env node
/**
 * Secret-file read guard (a PreToolUse(Bash) hook, wired in
 * `.claude/settings.json` and `.codex/hooks.json`).
 *
 * Scope: a backstop against an agent ACCIDENTALLY reading a secret file into
 * the transcript, not a sandbox against a determined one — `node -e`, python,
 * a glob, a variable or a `find -exec` that never names the file all pass.
 *
 * Blocks a Bash command that READS a local secret env file (`.env`,
 * `.env.local`, `.env.production`, `.envrc`, …) so its contents can't be
 * auto-dumped into the transcript with no human in the loop. The repo's
 * secret-handling policy (AGENTS.md) is "don't read .env unless the user
 * explicitly asks" — this enforces the default-deny half; an explicit,
 * user-authorized read is allowed by prefixing the command with `READ_ENV_OK=1`.
 *
 * Why a hook and not permission globs: `Read(.env*)` / `Bash(... .env*)` rules
 * are fragile — per the Claude Code docs the Read→Bash bridge applies to `deny`
 * only (not `ask`), so `cat`/`head`/`tail` of `.env` slip an ask-rule; and arg
 * globs miss `./.env`, `config/.env`, and abs paths.
 *
 * A command reads a secret file when, in any command the shared tokenizer finds
 * in it (inside `$(…)`, backticks, `<(…)`, `bash -c '…'` and `eval` included;
 * a `;` inside a quoted awk program is text):
 *  - a reader verb (cat, head, grep, …) has a secret path argument. A list of
 *    readers rather than "any command naming the file", because many commands
 *    that name one only list, test, copy or mention it (`ls`, `test -f`, `cp`,
 *    `node --env-file`, a commit message);
 *  - its input is redirected from a secret path (`< .env`, `$(<.env)`);
 *  - it is a recursive grep, or an `rg` told to read hidden AND ignored files,
 *    over a directory that holds a secret file at its top level, where a
 *    checkout keeps them. Refusing every `grep -r` would block every search of
 *    `src/`; a search root above that directory (`grep -r X ..` from a
 *    subdirectory) is not checked, nor is an `--exclude` that would skip it.
 * Non-secret templates (`.env.example` / `.sample` / `.template` / `.dist` /
 * `.defaults`) are not secret files.
 *
 * Reads the hook payload (JSON) on stdin. Exit 2 → block; exit 0 → allow.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { inputRedirectTargets, shellCommandsWithDepth, withoutLiteralHeredocs } from './shell-segments.mjs'

const allow = () => process.exit(0)

let payload = {}
try {
  payload = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  allow() // not a parseable hook payload — don't get in the way
}

const cmd = payload?.tool_input?.command ?? ''
if (!cmd) allow()
if (/\bREAD_ENV_OK=1\b/.test(cmd)) allow() // explicit, user-authorized read

// Commands that read/dump file contents (or, for source/`.`, load+expose them).
const READERS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'nl', 'tac', 'od', 'xxd', 'hexdump',
  'strings', 'sort', 'base64', 'cut', 'dd', 'bat', 'view', 'grep', 'egrep',
  'fgrep', 'rg', 'ripgrep', 'sed', 'awk', 'source', '.', 'diff', 'sdiff',
  'comm', 'paste', 'column', 'uniq', 'rev', 'fold',
])
// Search verbs take a PATTERN as their first non-flag arg (not a file), so a
// `.env` *pattern* (`grep ".env" src/`) must not be read as a `.env` file.
const SEARCH = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ripgrep', 'sed', 'awk'])
const GREPS = new Set(['grep', 'egrep', 'fgrep'])
// Words that run the command after them: assignments, wrappers, and the shell
// reserved words a command can follow (`if grep …`, `do cat …`).
const PREFIXES = new Set([
  'sudo', 'command', 'time', 'env', 'nice', 'nohup', 'xargs', 'exec', 'builtin',
  'if', 'then', 'elif', 'else', 'do', 'while', 'until', '!', '{',
])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash'])

// A secret env file as a path token: preceded by a boundary (start / whitespace
// / quote / = ( : / slash), then either `.envrc` (direnv) or `.env` + a CHAIN of
// dotted suffixes (`.env.local`, `.env.production.local`), then a non-word char.
// CASE-INSENSITIVE: the dev FS is case-insensitive, so `.ENV.LOCAL` reads the
// same bytes as `.env.local` and must block too. m[1] = the full file token;
// m[2] = the `.env` suffix chain (undefined for `.envrc`, "" for bare `.env`).
const ENV_REF = /(?:^|[\s='"(:;|&`/\\])(\.envrc|\.env((?:\.[a-z0-9_-]+)*))(?![\w-])/gi
// A suffix that is EXACTLY one non-secret template token. A COMPOUND suffix like
// `.example.local` is a real local override, NOT a template, so it still blocks.
const TEMPLATE = /^\.(example|sample|template|dist|defaults)$/i

/** The secret env file a word names, or null. */
const secretPathIn = word => {
  for (const m of word.matchAll(ENV_REF)) {
    const suffix = m[2] // undefined for `.envrc`; "" / ".local" / ".example.local" for `.env…`
    if (suffix !== undefined && TEMPLATE.test(suffix)) continue // exact-template → not a secret
    return m[1]
  }
  return null
}

/** A secret file directly inside `dir`, or null (also when `dir` is no directory). */
const secretFileIn = dir => {
  try {
    return readdirSync(dir, { withFileTypes: true }).find(e => !e.isDirectory() && secretPathIn(e.name))?.name ?? null
  } catch {
    return null
  }
}

// For a search verb, the first non-flag arg is its pattern or program, not a file.
const withoutPattern = args => {
  const p = args.findIndex(a => !a.startsWith('-'))
  return p < 0 ? args : args.toSpliced(p, 1)
}

const shortFlags = args => args.filter(a => /^-[a-zA-Z.]+$/.test(a)).join('')

const recursesIntoDotfiles = (verb, args) => {
  if (GREPS.has(verb)) {
    return (
      /[rR]/.test(shortFlags(args)) ||
      args.some(a => a === '--recursive' || a === '--dereference-recursive' || a === '--directories=recurse') ||
      args.some((a, i) => a === '-d' && args[i + 1] === 'recurse')
    )
  }
  if (verb === 'rg' || verb === 'ripgrep') {
    // rg skips hidden and gitignored files by default; a checkout gitignores its
    // env files, so it reads them only with both turned off.
    const u = (shortFlags(args).match(/u/g)?.length ?? 0) + args.filter(a => a === '--unrestricted').length
    const hidden = u >= 2 || shortFlags(args).includes('.') || args.includes('--hidden')
    const noIgnore = u >= 1 || args.some(a => a.startsWith('--no-ignore'))
    return hidden && noIgnore
  }
  return false
}

// The script of `bash -c '…'` (any flag cluster holding c), or undefined.
const shellScriptOf = args => {
  const c = args.findIndex(a => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
  return c < 0 ? undefined : args[c + 1]
}

const cdTarget = (cwd, args) => {
  const dir = args.find(a => !a.startsWith('-'))
  if (dir === undefined) return homedir()
  if (dir.includes('$')) return cwd // unexpanded: judge from where we were
  return resolve(cwd, dir.replace(/^~(?=\/|$)/, homedir()))
}

/** The secret file `script` reads when run in `cwd`, as `{ file, walked }`, or null. */
const secretRead = (script, cwd) => {
  const live = withoutLiteralHeredocs(script)
  for (const target of inputRedirectTargets(live)) {
    const file = secretPathIn(target)
    if (file) return { file, walked: false }
  }
  for (const { tokens, depth } of shellCommandsWithDepth(live)) {
    let i = 0
    while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || PREFIXES.has(tokens[i]))) i++
    const verb = (tokens[i] ?? '').replace(/.*\//, '') // basename, strip any path
    const args = tokens.slice(i + 1)

    if (verb === 'cd' && depth === 0) cwd = cdTarget(cwd, args)

    const nested = verb === 'eval' ? args.join(' ') : SHELLS.has(verb) ? shellScriptOf(args) : undefined
    const inner = nested && secretRead(nested, cwd)
    if (inner) return inner

    if (!READERS.has(verb)) continue
    const files = SEARCH.has(verb) ? withoutPattern(args) : args
    for (const word of files) {
      const file = secretPathIn(word)
      if (file) return { file, walked: false }
    }
    if (!recursesIntoDotfiles(verb, args)) continue
    const roots = files.filter(a => !a.startsWith('-'))
    for (const root of roots.length ? roots : ['.']) {
      const file = secretFileIn(resolve(cwd, root))
      if (file) return { file: join(root, file), walked: true }
    }
  }
  return null
}

const hit = secretRead(cmd, payload?.cwd || process.cwd())
if (!hit) allow()

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
