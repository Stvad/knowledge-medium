#!/usr/bin/env node
/**
 * beads↔GitHub sync with the documented traps guarded (AGENTS.md beads
 * section; memory reference_bd_github_sync_close_ordering):
 *
 * 1. A GitHub-side close (hand-close or a merged "Fixes #N") is CLOBBERED by
 *    the next sync — the still-open bead pushes over it and re-opens the
 *    issue. So GitHub-side closes are adopted into beads BEFORE syncing, and
 *    a failure to read or adopt ABORTS the run: proceeding with a partial
 *    view is exactly the clobber this step exists to prevent.
 * 2. A pull flattens bead priority to P2 when the issue lacks a priority::*
 *    machine label. Flattening is detected by comparing each bead's priority
 *    BEFORE and AFTER the sync (≠2 → 2 means this run's pull did it) and
 *    restoring the pre-sync value — never by guessing from labels, which
 *    would fight a deliberate P2. Only beads NEW this run (no pre-sync row)
 *    fall back to label derivation, since for them the label is the only
 *    signal.
 * 3. A bead closed BEFORE its first sync stays closed locally but its issue is
 *    minted OPEN. So after syncing, closed beads whose issue is open get the
 *    issue closed via gh — NOT via a selective bd push, which applies the
 *    last_sync watermark and silently skips any bead updated before it
 *    (observed live: a day-old close never pushed). gh-closing is safe in
 *    exactly this direction because the bead is already closed: the states
 *    agree afterwards, so the next sync has nothing to revert.
 *    Note the deliberate asymmetry with (1): GitHub-side CLOSES are adopted
 *    (they come from PR merges), GitHub-side REOPENS do not stick (beads is
 *    the source of truth; reopen the bead instead).
 *
 * Accepted race: an issue closed on GitHub DURING the sync window can be
 * re-opened by the in-flight push, and because the reopen is then the state
 * every later fetch sees, no later run re-adopts the close. Inherent to a
 * push-based mirror; close the bead instead if it happens.
 *
 * Modes:
 *   node scripts/bd-github-sync.mjs               # full sync (manual / SessionEnd)
 *   node scripts/bd-github-sync.mjs --quiet       # only report when something changed
 *   node scripts/bd-github-sync.mjs --dry-run     # print plans, mutate nothing
 *   node scripts/bd-github-sync.mjs --hook-pre-pr # Claude Code PreToolUse(Bash) hook:
 *       fast-exits unless the command PUBLISHES text on GitHub (gh pr
 *       create/edit/comment/review/merge, gh issue create/edit/comment/close,
 *       gh release create/edit — matched only where gh is in command position,
 *       so a commit message MENTIONING these does not trip it) AND that text
 *       references bead ids (km-…). Then it mints GitHub issues for any
 *       referenced bead that lacks one (selective --issues push, seconds) and
 *       BLOCKS (exit 2) with the km→#N substitution table — public text must
 *       use issue numbers, which GitHub readers can resolve and bead ids are
 *       not. Escape hatch: prefix the command with KM_ALLOW_BEAD_IDS=1.
 *       The FULL sync does not run here: converged it still costs ~60s (a GET
 *       compare per issue), which is too slow to sit in front of every PR.
 *       SessionEnd and manual runs carry it.
 *
 * Every path no-ops silently when bd, the beads DB, or a gh token is missing
 * (cloud sessions) — and no bd command runs before the DB's existence is
 * confirmed, because the FIRST bd command in a fresh clone creates an empty
 * DB that then refuses to pull. The hook's bead-id block still fires without
 * a DB: an unmappable reference is worth blocking even where the sync can't
 * run.
 *
 * bd prints `Error:` and exits 0, sometimes on stderr — failure is detected
 * from both streams, never from the exit code alone.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const REPO = 'Stvad/knowledge-medium'

// ---------------------------------------------------------------------------
// Pure logic (unit-tested in bd-github-sync.test.ts)
// ---------------------------------------------------------------------------

const BEAD_ID = /(?<![\w-])km-[a-z0-9]+(?:-[a-z0-9]+)*(?![\w-])/g

/** Unique bead ids referenced in a blob of text, in first-seen order. */
export const extractBeadIds = text => [...new Set(text.match(BEAD_ID) ?? [])]

// gh must sit in COMMAND position (start of a shell segment, after optional
// VAR=val prefixes) — matching it anywhere in the text lets a commit message
// that merely mentions "gh pr comment" trip the gate and mint issues as a
// side effect of a local command.
const SEGMENT_START = String.raw`(?:^|[;&|(]\s*|\$\(\s*)`
const VAR_PREFIXES = String.raw`(?:[A-Za-z_]\w*=\S*\s+)*`
const GH_PUBLISH = new RegExp(
  SEGMENT_START +
    VAR_PREFIXES +
    String.raw`gh\s+(?:pr\s+(?:create|edit|comment|review|merge)|issue\s+(?:create|edit|comment|close)|release\s+(?:create|edit))\b`,
  'm',
)

/** Does this shell command publish PR/issue/release text on GitHub? */
export const matchesPrCommand = cmd => GH_PUBLISH.test(cmd)

// The escape hatch must also be in command-prefix position — matched anywhere,
// a PR body QUOTING it would both bypass the gate and publish the marker.
const ALLOW_MARKER = new RegExp(SEGMENT_START + VAR_PREFIXES + String.raw`KM_ALLOW_BEAD_IDS=1\s`, 'm')
export const allowsBeadIds = cmd => ALLOW_MARKER.test(cmd)

/**
 * Paths passed via --body-file/-F (the PR body often lives in a temp file, so
 * scanning the command string alone would miss its bead ids). `-` = stdin is
 * skipped. Handles plain, "double-" and 'single-'quoted paths; not full shell
 * parsing — this is a guard against the common shapes, not a sandbox.
 */
export const bodyFilePaths = cmd =>
  [...cmd.matchAll(/(?:--body-file|-F)(?:=|\s+)("[^"]*"|'[^']*'|[^\s'"]+)/g)]
    .map(m => m[1].replace(/^(["'])(.*)\1$/, '$2'))
    .filter(p => p !== '-')

/** Resolve a body-file path the way the shell would have: ~, then cwd. */
export const resolveBodyPath = (p, cwd, home) =>
  p === '~' || p.startsWith('~/') ? join(home, p.slice(1)) : isAbsolute(p) ? p : resolve(cwd, p)

/**
 * Priority 0–4 from GitHub label names. The machine label (`priority::high`,
 * upstream's PriorityMapping vocabulary) wins over the hand label (`P1`).
 * Only consulted for beads that did not exist before this run — see header.
 */
const PRIORITY_WORDS = { critical: 0, high: 1, medium: 2, low: 3, none: 4 }
export const deriveLabelPriority = labels => {
  for (const name of labels) {
    const m = name.match(/^priority::(\w+)$/i)
    if (m && m[1].toLowerCase() in PRIORITY_WORDS) return PRIORITY_WORDS[m[1].toLowerCase()]
  }
  for (const name of labels) {
    const m = name.match(/^[pP]([0-4])$/)
    if (m) return Number(m[1])
  }
  return null
}

// Pinned to THIS repo: an external_ref pointing anywhere else (another repo's
// issue, a PR URL) must never contribute an issue number here — a number
// collision would close the wrong public issue.
const ISSUE_REF = new RegExp(`^https://github\\.com/${REPO}/issues/(\\d+)$`)
export const issueNumberFromRef = ref => {
  const m = ISSUE_REF.exec(ref ?? '')
  return m ? Number(m[1]) : null
}

/** Non-closed beads (open/in_progress/blocked/deferred) whose issue is closed. */
export const planCloseReconciliation = (beads, issueByNumber) =>
  beads
    .filter(b => b.status !== 'closed')
    .map(b => ({ id: b.id, number: issueNumberFromRef(b.external_ref) }))
    .filter(({ number }) => number !== null && issueByNumber.get(number)?.state === 'CLOSED')

/**
 * Closed beads whose GitHub issue is still open. An issue absent from the map
 * counts as open only when its number is BEYOND the highest fetched one — the
 * map predates the sync, so the canonical case (an issue minted DURING this
 * run for an already-closed bead) is above that line; an absent number below
 * it means the issue was deleted or transferred and must not be gh-closed.
 */
export const planClosePushes = (beads, issueByNumber, maxKnownIssueNumber) =>
  beads
    .filter(b => b.status === 'closed')
    .map(b => ({ id: b.id, number: issueNumberFromRef(b.external_ref) }))
    .filter(({ number }) => {
      if (number === null) return false
      const known = issueByNumber.get(number)
      return known ? known.state === 'OPEN' : number > maxKnownIssueNumber
    })

/**
 * Beads to un-flatten after a sync. A bead that WAS ≠2 before this run and is
 * 2 after was flattened by this run's pull → restore its pre-sync value. A
 * bead new this run at 2 takes the label-derived value if one exists. A bead
 * already at 2 before the run is untouched — 2 may be deliberate.
 */
export const planPriorityFixes = (preById, postBeads, issueByNumber) =>
  postBeads
    .filter(b => b.status !== 'closed' && b.priority === 2)
    .map(b => {
      const pre = preById.get(b.id)
      if (pre) return { id: b.id, to: pre.priority !== 2 ? pre.priority : null }
      const issue = issueByNumber.get(issueNumberFromRef(b.external_ref))
      return { id: b.id, to: issue ? deriveLabelPriority(issue.labels) : null }
    })
    .filter(({ to }) => to !== null && to !== 2)

export const buildDenyMessage = (mapped, unmapped) => {
  const lines = [
    'BLOCKED: this text references bead ids (km-…), which GitHub readers cannot resolve.',
    'Reference the GitHub issue numbers instead:',
    ...mapped.map(({ id, number }) => `  ${id} → #${number} (https://github.com/${REPO}/issues/${number})`),
    ...(unmapped.length
      ? [
          `No GitHub issue found for: ${unmapped.join(', ')} — check \`bd show <id>\`; if the sync could not run here, find the issue via \`gh issue list --search\`.`,
        ]
      : []),
    'Rewrite the references as #N and re-run.',
    'Close keywords ("Fixes #N") are the right pattern: when the PR merges and GitHub closes #N, the next sync\'s reconcile step closes the bead to match. Do not hand-close either side before the merge.',
    'If the bead id mention is deliberate (not an issue reference), re-run with KM_ALLOW_BEAD_IDS=1 prefixed.',
  ]
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Process plumbing
// ---------------------------------------------------------------------------

const run = (file, args, opts = {}) => {
  const r = spawnSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
  if (r.error) throw r.error
  const combined = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  if (r.status !== 0) throw new Error(`${file} ${args[0]} exited ${r.status}: ${combined.trim().slice(0, 500)}`)
  // bd reports failures as `Error…` with exit 0 — on either stream.
  if (file === 'bd' && /^Error/m.test(combined)) throw new Error(`bd ${args[0]}: ${combined.trim().slice(0, 500)}`)
  return r.stdout ?? ''
}

const tryRun = (file, args, opts) => {
  try {
    return run(file, args, opts)
  } catch {
    return null
  }
}

const mainRepoRoot = () => {
  const commonDir = tryRun('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  return commonDir ? dirname(commonDir.trim()) : null
}

// The DB's PRIOR existence gates every bd invocation — see header.
const initializedDbRoot = () => {
  const root = mainRepoRoot()
  return root && existsSync(join(root, '.beads', 'embeddeddolt')) && tryRun('bd', ['--version']) ? root : null
}

const preconditions = () => {
  const root = initializedDbRoot()
  if (!root) return { ok: false, reason: 'no initialized beads DB (or bd not on PATH)' }
  const token = tryRun('gh', ['auth', 'token'])?.trim()
  if (!token) return { ok: false, reason: 'no gh token' }
  return { ok: true, root, env: { ...process.env, GITHUB_TOKEN: token, BD_NO_REMOTE_ADOPT: '1' } }
}

/**
 * One sync at a time across sessions/worktrees (they share the one DB). The
 * lock only serializes THIS script; bd itself may still run concurrently
 * elsewhere — which is why listBeads failures abort instead of soft-failing.
 * Steal is by atomic rename: of two stealers only one rename succeeds, so a
 * fresh lock can never be swept away by the loser.
 */
const withLock = (root, fn) => {
  const lock = join(root, '.beads', 'github-sync.lock')
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch {
      const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now())
      if (age > 10 * 60_000) {
        try {
          const grave = `${lock}.stale-${process.pid}`
          renameSync(lock, grave)
          rmdirSync(grave)
        } catch {}
        continue
      }
      if (Date.now() > deadline) return { skipped: 'another sync is running' }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    }
  }
  const unlock = () => {
    try {
      rmdirSync(lock)
    } catch {}
  }
  // SessionEnd kills on timeout — without this the lock leaks for 10 minutes.
  const onSignal = () => {
    unlock()
    process.exit(130)
  }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
  try {
    return fn()
  } finally {
    process.off('SIGTERM', onSignal)
    process.off('SIGINT', onSignal)
    unlock()
  }
}

// All five statuses in one call; throws on failure. Callers slice by status —
// the plan functions own status selection, so nothing here pre-filters.
const listAllBeads = () =>
  JSON.parse(run('bd', ['list', '--status', 'open,in_progress,blocked,deferred,closed', '--json']))

const FETCH_LIMIT = 5000
const fetchIssues = () => {
  const rows = JSON.parse(
    run('gh', ['issue', 'list', '--repo', REPO, '--state', 'all', '--json', 'number,state,labels', '--limit', String(FETCH_LIMIT)]),
  )
  if (rows.length >= FETCH_LIMIT)
    throw new Error(`issue list hit the ${FETCH_LIMIT} fetch limit — raise it before trusting absence-based decisions`)
  return {
    issueByNumber: new Map(rows.map(i => [i.number, { state: i.state, labels: i.labels.map(l => l.name) }])),
    maxKnownIssueNumber: rows.reduce((max, i) => Math.max(max, i.number), 0),
  }
}

// ---------------------------------------------------------------------------
// The sync sequence
// ---------------------------------------------------------------------------

const runSync = ({ quiet = false, dryRun = false } = {}) => {
  const pre = preconditions()
  if (!pre.ok) {
    if (!quiet) console.log(`bd-github-sync: skipped (${pre.reason})`)
    return { skipped: pre.reason }
  }
  const { env } = pre

  const result = withLock(pre.root, () => {
    const { issueByNumber, maxKnownIssueNumber } = fetchIssues()
    const preBeads = listAllBeads()
    const report = []

    // 1. Adopt GitHub-side closes BEFORE pushing (see header). A failed close
    // leaves an open bead that the push would use to re-open the issue, so
    // any failure here aborts the whole run.
    const closes = planCloseReconciliation(preBeads, issueByNumber)
    const closeFailures = []
    for (const { id, number } of closes) {
      if (dryRun || tryRun('bd', ['close', id, '--reason', `Closed on GitHub (issue #${number}); reconciled by bd-github-sync.`], { env }) !== null) {
        report.push(`closed ${id} (issue #${number} was closed on GitHub)`)
      } else {
        closeFailures.push(id)
      }
    }
    if (closeFailures.length)
      throw new Error(`aborting before push: could not adopt GitHub closes for ${closeFailures.join(', ')}`)

    // 2. The sync itself.
    const syncOut = run('bd', ['github', 'sync', ...(dryRun ? ['--dry-run'] : [])], { env })
    const syncSummary = syncOut
      .split('\n')
      .filter(l => /Pulled|Pushed|Created|Updated|dry-run/.test(l))
      .map(l => l.trim())
    report.push(...syncSummary)

    // 3. Un-flatten priorities (pre/post comparison — see header), push back.
    const preById = new Map(preBeads.map(b => [b.id, b]))
    const postBeads = dryRun ? preBeads : listAllBeads()
    const fixes = planPriorityFixes(preById, postBeads, issueByNumber)
    for (const { id, to } of fixes) {
      if (!dryRun) run('bd', ['update', id, '-p', String(to)], { env })
      report.push(`priority ${id} → ${to} (re-derived after pull-flattening)`)
    }
    if (fixes.length && !dryRun) run('bd', ['github', 'sync', '--push-only', '--issues', fixes.map(f => f.id).join(',')], { env })

    // 4. Carry bead closes out to issues still open (see header: via gh, not
    // a selective bd push, whose watermark silently skips older closes).
    const closePushes = planClosePushes(postBeads, issueByNumber, maxKnownIssueNumber)
    for (const { id, number } of closePushes) {
      const ok = dryRun || tryRun('gh', ['issue', 'close', String(number), '--repo', REPO, '--reason', 'completed'], { env }) !== null
      report.push(ok ? `closed issue #${number} to match closed bead ${id}` : `FAILED to close issue #${number} (bead ${id}) — close it by hand or re-run`)
    }

    const changed = closes.length + fixes.length + closePushes.length > 0 || syncSummary.some(l => /[1-9]/.test(l))
    if (!quiet || changed) console.log(['bd-github-sync:', ...report].join('\n  '))
    return { closes, fixes, closePushes }
  })

  if (result?.skipped && !quiet) console.log(`bd-github-sync: skipped (${result.skipped})`)
  return result
}

// ---------------------------------------------------------------------------
// PreToolUse(Bash) hook mode
// ---------------------------------------------------------------------------

const allow = () => process.exit(0)

const hookPrePr = () => {
  let payload = {}
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    allow()
  }
  const cmd = payload?.tool_input?.command ?? ''
  if (!cmd || !matchesPrCommand(cmd)) allow()
  if (allowsBeadIds(cmd)) allow()

  const cwd = payload?.cwd ?? process.cwd()
  const bodies = bodyFilePaths(cmd)
    .map(p => resolveBodyPath(p, cwd, homedir()))
    .filter(p => existsSync(p))
    .map(p => readFileSync(p, 'utf8'))
  const ids = extractBeadIds([cmd, ...bodies].join('\n'))
  if (ids.length === 0) allow()

  // No bd call of any kind before the DB-exists gate — see header.
  const dbReady = initializedDbRoot() !== null
  const lookup = () => {
    const shown = dbReady ? tryRun('bd', ['show', ...ids, '--json']) : null
    return new Map((shown ? JSON.parse(shown) : []).map(b => [b.id, issueNumberFromRef(b.external_ref)]))
  }

  let byId = lookup()
  const missing = ids.filter(id => !byId.get(id))
  const pre = missing.length && dbReady ? preconditions() : { ok: false }
  if (pre.ok && process.env.BD_GITHUB_SYNC_DRY !== '1') {
    // Mint issues for referenced beads that have none — selective push, seconds.
    tryRun('bd', ['github', 'sync', '--push-only', '--issues', missing.join(',')], { env: pre.env })
    byId = lookup()
  }

  const mapped = ids.filter(id => byId.get(id)).map(id => ({ id, number: byId.get(id) }))
  const unmapped = ids.filter(id => !byId.get(id))
  console.error(buildDenyMessage(mapped, unmapped))
  process.exit(2)
}

// ---------------------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())
if (isMain) {
  const args = new Set(process.argv.slice(2))
  if (args.has('--hook-pre-pr')) {
    hookPrePr()
  } else {
    try {
      runSync({ quiet: args.has('--quiet'), dryRun: args.has('--dry-run') })
    } catch (e) {
      console.error(`bd-github-sync: failed — ${e.message ?? e}`)
      process.exit(1)
    }
  }
}
