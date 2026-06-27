#!/usr/bin/env node
/**
 * Secret-file read guard (wired as a Claude Code PreToolUse(Bash) hook).
 *
 * Blocks a Bash command that READS a local secret env file (`.env`,
 * `.env.local`, `.env.production`, …) so its contents can't be auto-dumped into
 * the transcript with no human in the loop. The repo's secret-handling policy
 * (AGENTS.md) is "don't read .env unless the user explicitly asks" — this
 * enforces the default-deny half; an explicit, user-authorized read is allowed
 * by prefixing the command with `READ_ENV_OK=1`.
 *
 * Why a hook and not permission globs: `Read(.env*)` / `Bash(... .env*)` rules
 * are fragile — per the Claude Code docs the Read→Bash bridge applies to `deny`
 * only (not `ask`), so `cat`/`head`/`tail` of `.env` slip an ask-rule; and arg
 * globs miss `./.env`, `config/.env`, and abs paths. Inspecting the raw command
 * catches cat/head/tail/grep/rg/sed/… uniformly.
 *
 * Precision: only a reading/dumping command verb (cat, head, grep, …) with a
 * `.env` path argument trips it — so `git commit -m "fix .env loading"` or
 * `echo .env` (which merely mention the string) are NOT blocked. Non-secret
 * templates (`.env.example` / `.sample` / `.template` / `.dist` / `.defaults`)
 * are allowed. It cannot catch a recursive read that never names .env (e.g.
 * `grep -rn X .` traversing into .env) — no command-string guard can.
 *
 * Reads the hook payload (JSON) on stdin. Exit 2 → block; exit 0 → allow.
 */

import { readFileSync } from 'node:fs'

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
  'fgrep', 'rg', 'ripgrep', 'sed', 'awk', 'source', '.',
])
// Search verbs take a PATTERN as their first non-flag arg (not a file), so a
// `.env` *pattern* (`grep ".env" src/`) must not be read as a `.env` file.
const SEARCH = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ripgrep', 'sed', 'awk'])

// A `.env` secret file as a path token: preceded by a boundary (start /
// whitespace / quote / = ( : / slash), then `.env` + an optional single dotted
// suffix, then a non-word char. m[1] is the suffix (".local", ".example", "").
const ENV_REF = /(?:^|[\s='"(:;|&`/\\])\.env(\.[A-Za-z0-9_-]+)?(?![\w-])/g
const TEMPLATE = /^\.(example|sample|template|dist|defaults|md)$/i

const envHitIn = seg => {
  for (const m of seg.matchAll(ENV_REF)) {
    if (!TEMPLATE.test(m[1] ?? '')) return `.env${m[1] ?? ''}`
  }
  return null
}

// Split into shell segments so a reader anywhere in a pipe/chain is caught.
// (Limitation: a reader nested in a command substitution — `echo $(cat .env)`
// — isn't caught; scanning substitution bodies false-positives on quoted/literal
// `$(…)`. This is a guard against accidental/naive reads, not an adversarial
// sandbox, so the precise first-verb check is the better trade-off.)
const segments = cmd.split(/[;\n]|\|\|?|&&|&/)
let hit = null
for (const seg of segments) {
  const tokens = seg.trim().split(/\s+/)
  let i = 0
  // skip leading `VAR=val` assignments and common command prefixes
  while (
    i < tokens.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) ||
      ['sudo', 'command', 'time', 'env', 'nice', 'nohup', 'xargs'].includes(tokens[i]))
  ) {
    i++
  }
  const verb = (tokens[i] || '').replace(/.*\//, '') // basename, strip any path
  if (!READERS.has(verb)) continue
  // Scan only the file ARGUMENTS, not the verb. For a search verb, drop the
  // first non-flag arg (its pattern) so `grep ".env" src/` isn't mistaken for
  // reading a `.env` file — but `grep KEY .env.local` (a real read) still trips.
  const argv = tokens.slice(i + 1)
  if (SEARCH.has(verb)) {
    let p = 0
    while (p < argv.length && argv[p].startsWith('-')) p++
    if (p < argv.length) argv.splice(p, 1)
  }
  hit = envHitIn(argv.join(' '))
  if (hit) break
}
if (!hit) allow()

process.stderr.write(
  `BLOCKED: this command reads a local secret file (${hit}). Repo policy is to ` +
    `not read .env files unless the user explicitly asks (AGENTS.md secret-handling); ` +
    `the contents would land in the transcript.\n` +
    `If the user explicitly asked for this, re-run with READ_ENV_OK=1 prefixed.\n`,
)
process.exit(2)
