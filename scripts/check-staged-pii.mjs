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
 * A uuid is not reported when:
 * - it is synthetic (`isSyntheticUuid`) — a shape no id generator mints, and
 *   an accepted exemption rather than proof: a real block can be given such
 *   an id by hand;
 * - it is listed in HEAD's `scripts/check-staged-pii.allowlist` (named code
 *   constants), so a new entry takes one PII_OK=1 commit, and later touches
 *   of the constant none;
 * - on the command line, it sits in a path: any token containing '/', or,
 *   inside a VAR= value, a Claude Code session temp dir (`SESSION_TEMP_DIR`).
 *   The rest of a VAR= value is scanned, since an expanded message
 *   (MSG="fix page/<id>") lives there.
 * During a merge, a uuid on an added line is not reported when HEAD's or a
 * merge head's copy of the same file already holds it: that parent committed
 * it, and the merge only carries it in, whatever the resolution did to the
 * text around it.
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
// A match at every start, overlapping ones included, so an exempt uuid glued
// onto a longer hex run cannot hide one that begins inside it.
const UUID_AT_EVERY_START = new RegExp(`(?=(${UUID_SOURCE}))`, 'gi')
const uuidsIn = text => [...text.matchAll(UUID_AT_EVERY_START)].map(m => m[1])

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
const ALLOWLIST_ENTRY = new RegExp(`^\\s*(${UUID_SOURCE})\\s+\\S`, 'i')
export const parseAllowlist = text =>
  new Set(
    text.split('\n').flatMap(line => {
      const m = line.match(ALLOWLIST_ENTRY)
      return m ? [m[1].toLowerCase()] : []
    }),
  )

export const ALLOWLIST_PATH = 'scripts/check-staged-pii.allowlist'

// git's stdout, or null when git fails. Its stderr never reaches the hook's
// output, which states only what the hook found.
const gitOut = args => {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

// HEAD's copy of the repo being committed: an entry the commit itself adds is
// no exemption yet. Absent or unreadable, it is empty and the guard reports more.
const committedAllowlist = () => parseAllowlist(gitOut(['show', `HEAD:${ALLOWLIST_PATH}`]) ?? '')

// Claude Code keeps each session's scratchpad and task output under
// <tmp>/claude-<uid>/<project>/<session-uuid>/; that uuid names a session.
const SESSION_TEMP_DIR = new RegExp(`^((?:/private)?/tmp/claude-\\d+/[^/]+/)${UUID_SOURCE}(?=/|$)`, 'i')

// The part of a command-line token that can carry commit content: nothing of
// a path, and all of a VAR= value but a session temp dir's uuid.
const scannedText = token => {
  const assignment = token.match(/^[A-Za-z_][A-Za-z0-9_]*=([\s\S]*)$/)
  if (assignment) return assignment[1].replace(SESSION_TEMP_DIR, '$1')
  return token.includes('/') ? '' : token
}

// Every option that shapes the diff text is pinned, so no local git config
// (external drivers, colour, path prefixes, path quoting, relative paths)
// changes what `addedLines` reads.
const stagedDiff = () =>
  gitOut([
    '-c',
    'core.quotePath=false',
    '--no-pager',
    'diff',
    '--cached',
    '-U0',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--no-relative',
    '--dst-prefix=b/',
  ])

// `+++ b/<path>`, quoted with C escapes when git still quotes the name (kept
// escaped: it is a key and a printed fact), and tab-terminated when it holds a space.
const headerPath = rest => {
  const quoted = rest.match(/^"b\/(.*)"$/)
  if (quoted) return quoted[1]
  const plain = rest.replace(/\t$/, '')
  return plain.startsWith('b/') ? plain.slice(2) : plain
}

/**
 * Added lines of a unified diff, with their line numbers in the new file.
 * A hunk's header counts say how many body lines follow, so a content line
 * that begins with `+++` is never read as a file header, and context lines
 * advance the line number.
 */
const addedLines = diff => {
  const out = []
  let file = null
  let oldLeft = 0
  let newLeft = 0
  let lineNo = 0
  for (const line of diff.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('+')) {
        out.push({ file, lineNo: lineNo++, text: line.slice(1) })
        newLeft--
      } else if (line.startsWith('-')) {
        oldLeft--
      } else if (!line.startsWith('\\')) {
        lineNo++ // context: ' ', or '' under diff.suppressBlankEmpty
        oldLeft--
        newLeft--
      }
      continue
    }
    if (line.startsWith('+++ ')) {
      file = headerPath(line.slice(4))
      continue
    }
    const hunk = line.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1])
      lineNo = Number(hunk[2])
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3])
    }
  }
  return out
}

// The heads `git commit` will record as parents besides HEAD: the lines of
// $GIT_DIR/MERGE_HEAD, which no branch or tag of that name can stand in for.
const mergeHeads = () => {
  const path = gitOut(['rev-parse', '--git-path', 'MERGE_HEAD'])?.trim()
  if (!path) return []
  try {
    return readFileSync(path, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
  } catch {
    return []
  }
}

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

  const headDiff = stagedDiff()
  if (headDiff === null) allow() // no repo / nothing staged — let git itself handle it
  const heads = mergeHeads()
  const parentCopies = new Map()
  const parentCopy = (rev, file) => {
    const key = `${rev}\0${file}`
    if (!parentCopies.has(key)) parentCopies.set(key, gitOut(['show', `${rev}:${file}`]) ?? '')
    return parentCopies.get(key)
  }
  const carriedIn = (file, uuid) =>
    heads.length > 0 && ['HEAD', ...heads].some(rev => parentCopy(rev, file).includes(uuid))

  const allowlist = committedAllowlist()
  const reportedUuids = text => uuidsIn(text).filter(u => !isSyntheticUuid(u) && !allowlist.has(u.toLowerCase()))
  const hits = []
  for (const l of addedLines(headDiff)) {
    if (ALLOW_PATHS.some(rx => rx.test(l.file))) continue
    for (const uuid of reportedUuids(l.text)) {
      if (!carriedIn(l.file, uuid)) hits.push(`  ${l.file}:${l.lineNo}: ${uuid}`)
    }
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
  const messageUuids = messageArgs.flatMap(reportedUuids)
  if (messageUuids.length) {
    for (const uuid of messageUuids) hits.push(`  (commit message): ${uuid}`)
  } else {
    // Expansions hide the message from the -m scan (MSG=…; git commit -m "$MSG",
    // heredoc bodies inside $(cat <<EOF…)), so also net a uuid in ANY token of
    // this (already commit-gated) command — except inside paths.
    for (const tokens of shellSegments(cmd)) {
      for (const t of tokens) {
        for (const uuid of reportedUuids(scannedText(t))) hits.push(`  (command line): ${uuid}`)
      }
    }
  }

  if (hits.length === 0) allow()

  const shown = hits.slice(0, 20).join('\n')
  const more = hits.length > 20 ? `\n  …and ${hits.length - 20} more` : ''
  const mergeNote =
    heads.length > 0
      ? "A merge is in progress: uuids that HEAD's or a merge head's copy of the same file holds were not reported.\n"
      : ''
  process.stderr.write(
    `BLOCKED: this commit adds uuid-shaped strings that are neither synthetic nor in HEAD's ${ALLOWLIST_PATH}:\n` +
      `${shown}${more}\n` +
      mergeNote +
      'Rule: memory feedback_no_pii_in_commits. PII_OK=1 prefixed to the command skips this check.\n',
  )
  process.exit(2)
}

if (isMainModule(import.meta.url)) main()
