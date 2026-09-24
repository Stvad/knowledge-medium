#!/usr/bin/env node
/**
 * Commit-guard for graph PII (wired as a Claude Code PreToolUse(Bash) hook).
 *
 * Blocks `git commit` when an added line of the staged diff, the commit
 * message, or the command line carries a uuid-shaped id — the mechanical
 * signal for this repo's private graph data (block ids, workspace ids). The
 * rule is the `feedback_no_pii_in_commits` memory; this narrows only what the
 * detector reports, never the rule.
 *
 * A uuid is not reported when it cannot be graph data:
 * - it is synthetic (`isSyntheticUuid`);
 * - it is listed in `scripts/check-staged-pii.allowlist` as STAGED (named code
 *   constants), so an exemption counts only when it is part of the commit;
 * - on the command line, it sits in a path: any token containing '/', or,
 *   inside a VAR= value, the session directory of the Claude Code temp root
 *   (<tmp>/claude-<uid>/<project>/<session-uuid>/, which holds the
 *   scratchpad). The rest of a VAR= value is scanned, since an expanded
 *   message (MSG="fix page/<id>") lives there.
 * During a merge, a diff line is reported only when the same line of the
 * staged file is added relative to HEAD and to MERGE_HEAD: a line either
 * parent holds is already committed there. Both diffs share the index as
 * their new side, so the staged line number identifies the line. An octopus
 * merge compares against its first merge head only.
 *
 * Limits: it catches uuids, NOT free-text page titles / note content. A uuid
 * inside a slashed word of a heredoc body slips, since that token reads as a
 * path. A hand-typed high-entropy fixture is indistinguishable from a real id
 * and is reported. Exit 2 → block (PreToolUse contract); exit 0 → allow. `PII_OK=1`
 * prefixed to the command skips the check.
 */

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { gitInvocations } from './check-stash-worktree.mjs'
import { isMainModule } from './is-main-module.mjs'
import { shellSegments } from './shell-segments.mjs'

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const uuidMatches = text => [...text.matchAll(new RegExp(UUID_SOURCE, 'gi'))]

// Paths where uuids are legitimate (generated / vendored / migrations / snapshots).
const ALLOW_PATHS = [
  /^supabase\/migrations\//,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/,
  /(^|\/)dist\//,
  /\.snap$/,
]

// uuids copied from specs and docs; fixtures vary everything after the prefix.
const DOCUMENTATION_EXAMPLE_PREFIXES = ['550e8400-e29b-', '123e4567-e89b-']
// Real ids have random nibbles (v4 random bits, v5 hash output, v7 random
// tail), so a stretch where each nibble is the one `stride` back plus a fixed
// step is hand-typed: a repeated digit, a counting run, an interleaved run, a
// repeated word. Nine equal steps take eight one-in-sixteen coincidences in a
// row, which a random id meets under once in 10^7.
const MAX_STRIDE = 8
const MIN_EQUAL_STEPS = 9

const longestEqualStepRun = hex => {
  const nibbles = [...hex].map(c => parseInt(c, 16))
  let longest = 0
  for (let stride = 1; stride <= MAX_STRIDE; stride++) {
    let run = 0
    let prevStep = null
    for (let i = 0; i + stride < nibbles.length; i++) {
      const step = (nibbles[i + stride] - nibbles[i] + 16) % 16
      run = step === prevStep ? run + 1 : 1
      prevStep = step
      longest = Math.max(longest, run)
    }
  }
  return longest
}

/**
 * A uuid no random or hash-derived generator would produce. Accepted: a real
 * block given such an id by hand (explicit ids are allowed) is exempt too.
 */
export const isSyntheticUuid = uuid => {
  const lower = uuid.toLowerCase()
  if (DOCUMENTATION_EXAMPLE_PREFIXES.some(prefix => lower.startsWith(prefix))) return true
  return longestEqualStepRun(lower.replaceAll('-', '')) >= MIN_EQUAL_STEPS
}

/** One entry per line: a uuid, whitespace, then why it is not graph data. */
export const parseAllowlist = text =>
  new Set(
    text.split('\n').flatMap(line => {
      const m = line.match(new RegExp(`^\\s*(${UUID_SOURCE})\\s+\\S`, 'i'))
      return m ? [m[1].toLowerCase()] : []
    }),
  )

const ALLOWLIST_PATH = 'scripts/check-staged-pii.allowlist'

// Read from the index of the repo being committed. Absent or unreadable, it is
// empty: the guard then reports more, never less.
const stagedAllowlist = () => {
  try {
    return parseAllowlist(
      execFileSync('git', ['show', `:${ALLOWLIST_PATH}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
    )
  } catch {
    return new Set()
  }
}

const reportedUuids = (text, allowlist, skipMatch = () => false) =>
  uuidMatches(text)
    .filter(m => !skipMatch(m))
    .map(m => m[0])
    .filter(uuid => !isSyntheticUuid(uuid) && !allowlist.has(uuid.toLowerCase()))

// Claude Code keeps each session's scratchpad and task output under
// <tmp>/claude-<uid>/<project>/<session-uuid>/; that uuid names a session.
const SESSION_TEMP_DIR = new RegExp(`^(?:/private)?/tmp/claude-\\d+/[^/]+/(${UUID_SOURCE})(?:/|$)`, 'id')
const isSessionTempDir = (value, m) => value.match(SESSION_TEMP_DIR)?.indices[1][0] === m.index

const stagedDiff = base =>
  // --no-ext-diff / --no-textconv / --no-color: force plain unified diff even if
  // the user has an external diff driver (difftastic, delta) configured, so the
  // `+`-line parser below works regardless of local git config.
  execFileSync(
    'git',
    ['--no-pager', 'diff', '--cached', '-U0', '--no-ext-diff', '--no-textconv', '--no-color', ...(base ? [base] : [])],
    { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  )

/** Added lines of a -U0 unified diff, with their line numbers in the new file. */
const addedLines = diff => {
  const out = []
  let file = null
  let lineNo = 0
  for (const line of diff.split('\n')) {
    const header = line.match(/^\+\+\+ b\/(.*)$/)
    if (header) {
      file = header[1]
      continue
    }
    const hunk = line.match(/^@@ -\S+ \+(\d+)/)
    if (hunk) {
      lineNo = Number(hunk[1])
      continue
    }
    if (file && line.startsWith('+') && !line.startsWith('+++')) out.push({ file, lineNo: lineNo++, text: line.slice(1) })
  }
  return out
}

const mergeHead = () => {
  try {
    return execFileSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

const lineKey = l => `${l.file}\0${l.lineNo}`

const main = () => {
  const allow = () => process.exit(0)

  let payload = {}
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    allow() // not a parseable hook payload — don't get in the way
  }

  const cmd = payload?.tool_input?.command ?? ''
  if (!/\bgit\b[^\n;&|]*\bcommit\b/.test(cmd)) allow() // cheap prefilter
  if (/\bPII_OK=1\b/.test(cmd)) allow() // explicit opt-out for a legitimate uuid
  // Only guard an actual commit invocation — git in verb position (after
  // assignments/wrappers/reserved words) with commit as its subcommand. Prose
  // that merely mentions the words (an echo, a printf) is not one.
  const commits = gitInvocations(cmd).filter(g => g.word === 'commit')
  if (commits.length === 0) allow()

  let lines
  try {
    lines = addedLines(stagedDiff())
  } catch {
    allow() // no repo / nothing staged — let git itself handle it
  }
  const merging = mergeHead()
  if (merging) {
    try {
      const newToMergeHead = new Set(addedLines(stagedDiff(merging)).map(lineKey))
      lines = lines.filter(l => newToMergeHead.has(lineKey(l)))
    } catch {
      // MERGE_HEAD unreadable: every line added relative to HEAD stays scanned.
    }
  }

  const allowlist = stagedAllowlist()
  const hits = []
  for (const l of lines) {
    if (ALLOW_PATHS.some(rx => rx.test(l.file))) continue
    for (const uuid of reportedUuids(l.text, allowlist)) hits.push(`  ${l.file}:${l.lineNo}: ${uuid}`)
  }
  // The commit message rides in the command itself, but ONLY in the -m/--message
  // arguments — a uuid elsewhere on the command line (a scratchpad path in a
  // redirect, a branch name) is not commit content and must not block.
  const messageArgs = []
  for (const g of commits) {
    const tokens = g.rest
    for (let i = 0; i < tokens.length; i++) {
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
  const messageUuids = messageArgs.flatMap(text => reportedUuids(text, allowlist))
  if (messageUuids.length) {
    for (const uuid of messageUuids) hits.push(`  (commit message): ${uuid}`)
  } else {
    // Expansions hide the message from the -m scan (MSG=…; git commit -m "$MSG",
    // heredoc bodies inside $(cat <<EOF…)), so also net a uuid in ANY token of
    // this (already commit-gated) command — except inside paths.
    for (const tokens of shellSegments(cmd)) {
      for (const t of tokens) {
        const assignment = t.match(/^[A-Za-z_][A-Za-z0-9_]*=([\s\S]*)$/)
        const uuids = assignment
          ? reportedUuids(assignment[1], allowlist, m => isSessionTempDir(assignment[1], m))
          : t.includes('/')
            ? []
            : reportedUuids(t, allowlist)
        for (const uuid of uuids) hits.push(`  (command line): ${uuid}`)
      }
    }
  }

  if (hits.length === 0) allow()

  const shown = hits.slice(0, 20).join('\n')
  const more = hits.length > 20 ? `\n  …and ${hits.length - 20} more` : ''
  const mergeNote = merging
    ? 'A merge is in progress: diff lines were scanned only where new relative to both HEAD and MERGE_HEAD.\n'
    : ''
  process.stderr.write(
    `BLOCKED: this commit adds uuid-shaped strings that are neither synthetic nor in the staged ${ALLOWLIST_PATH}:\n` +
      `${shown}${more}\n` +
      mergeNote +
      'Rule: memory feedback_no_pii_in_commits. PII_OK=1 prefixed to the command skips this check.\n',
  )
  process.exit(2)
}

if (isMainModule(import.meta.url)) main()
