#!/usr/bin/env node
/**
 * Commit-guard for graph PII (wired as a Claude Code PreToolUse(Bash) hook).
 *
 * Blocks `git commit` when the staged diff or the commit message contains
 * uuid-shaped ids — the reliable mechanical signal for this repo's private graph
 * data (block ids, workspace ids). See the `feedback_no_pii_in_commits` memory:
 * scripts / runbooks / commit messages must describe targets generically, not by
 * id / name / content.
 *
 * It reads the hook payload (JSON) on stdin, so it only acts on git-commit Bash
 * calls and is a no-op for everything else. Exit 2 → block (PreToolUse contract);
 * exit 0 → allow.
 *
 * Limits: it catches uuids, NOT free-text page titles / note content — those
 * aren't mechanically detectable, so manual scrubbing still matters. Legitimate
 * uuids (rare) can be allowed by prefixing the command with `PII_OK=1`.
 */

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { shellSegments } from './shell-segments.mjs'

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

// Paths where uuids are legitimate (generated / vendored / migrations / snapshots).
const ALLOW_PATHS = [
  /^supabase\/migrations\//,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/,
  /(^|\/)dist\//,
  /\.snap$/,
]

const allow = () => process.exit(0)

let payload = {}
try {
  payload = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  allow() // not a parseable hook payload — don't get in the way
}

const cmd = payload?.tool_input?.command ?? ''
// Only guard an actual `git … commit` invocation: git and commit in the SAME
// shell segment (no ; && || | newline between), so a compound command that
// merely mentions "commit" elsewhere (e.g. `git add x; echo "…commit…"`) is not
// treated as a commit.
if (!/\bgit\b[^\n;&|]*\bcommit\b/.test(cmd)) allow()
if (/\bPII_OK=1\b/.test(cmd)) allow() // explicit opt-out for a legitimate uuid

let diff = ''
try {
  // --no-ext-diff / --no-textconv / --no-color: force plain unified diff even if
  // the user has an external diff driver (difftastic, delta) configured, so the
  // `+`-line parser below works regardless of local git config.
  diff = execFileSync(
    'git',
    ['--no-pager', 'diff', '--cached', '-U0', '--no-ext-diff', '--no-textconv', '--no-color'],
    { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  )
} catch {
  allow() // no repo / nothing staged — let git itself handle it
}

const hits = []
let file = null
for (const line of diff.split('\n')) {
  const m = line.match(/^\+\+\+ b\/(.*)$/)
  if (m) {
    file = m[1]
    continue
  }
  if (file && ALLOW_PATHS.some(rx => rx.test(file))) continue
  if (line.startsWith('+') && !line.startsWith('+++') && UUID.test(line)) {
    hits.push(`  ${file}: ${line.slice(1).trim().slice(0, 140)}`)
  }
}
// The commit message rides in the command itself, but ONLY in the -m/--message
// arguments — a uuid elsewhere on the command line (a scratchpad path in a
// redirect, a branch name) is not commit content and must not block.
const messageArgs = []
for (const tokens of shellSegments(cmd)) {
  const verb = tokens.findIndex(t => t.replace(/.*\//, '') === 'git')
  if (verb === -1 || !tokens.includes('commit', verb)) continue
  for (let i = verb; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--message' || /^-[a-zA-Z]*m$/.test(t)) {
      if (tokens[i + 1] !== undefined) messageArgs.push(tokens[i + 1])
    } else if (t.startsWith('--message=')) {
      messageArgs.push(t.slice('--message='.length))
    } else if (/^-m./.test(t)) {
      messageArgs.push(t.slice(2)) // attached form (-mfix…)
    }
  }
}
if (messageArgs.some(text => UUID.test(text))) {
  hits.push('  (commit message): contains a uuid')
}

if (hits.length === 0) allow()

const shown = hits.slice(0, 20).join('\n')
const more = hits.length > 20 ? `\n  …and ${hits.length - 20} more` : ''
process.stderr.write(
  'BLOCKED: staged commit contains uuid-shaped data — likely private graph PII.\n' +
    'Scrub it / describe targets generically (memory: feedback_no_pii_in_commits).\n' +
    `${shown}${more}\n` +
    'If a uuid here is genuinely safe, re-run with PII_OK=1 prefixed to the command.\n',
)
process.exit(2)
