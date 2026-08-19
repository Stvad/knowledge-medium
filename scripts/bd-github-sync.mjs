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
 *       BD_GITHUB_SYNC_DRY=1 in the ENVIRONMENT suppresses the mint — the
 *       valve every pipe-test of the hook uses.
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
import { existsSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = 'Stvad/knowledge-medium'

// ---------------------------------------------------------------------------
// Pure logic (unit-tested in bd-github-sync.test.ts)
// ---------------------------------------------------------------------------

const BEAD_ID = /(?<![\w-])km-[a-z0-9]+(?:-[a-z0-9]+)*(?![\w-])/g

/** Unique bead ids referenced in a blob of text, in first-seen order. */
export const extractBeadIds = text => [...new Set(text.match(BEAD_ID) ?? [])]

// gh must sit in COMMAND position — matching it anywhere in the text lets a
// commit message that merely mentions "gh pr comment" trip the gate and mint
// issues as a side effect of a local command. Position alone is not enough:
// quoted prose can contain `;`/newlines that fake a segment start, so the
// positional regexes run against a SKELETON of the command with quoted spans
// removed. Single-quoted text never executes and is dropped; command
// substitutions DO execute even inside double quotes, so their bodies are
// lifted out as segments of their own before the double-quoted spans go.
// (Commands arrive from the Bash tool, so quotes are balanced; this is a
// guard for that shape, not a full shell parser.)
const commandSkeleton = cmd => {
  const noSingle = cmd.replace(/'[^']*'/g, "''")
  const lifted = [
    ...[...noSingle.matchAll(/\$\(([^)]*)\)/g)].map(m => m[1]),
    ...[...noSingle.matchAll(/`([^`]*)`/g)].map(m => m[1]),
  ]
  return [noSingle.replace(/"(?:\\.|[^"\\])*"/g, '""'), ...lifted].join('\n')
}

const SEGMENT_START = String.raw`(?:^|[;&|(]\s*)`
// VAR=val assignments and common wrapper commands may precede the real verb.
const COMMAND_PREFIXES = String.raw`(?:(?:command|env|nohup|time|xargs)\s+|[A-Za-z_]\w*=\S*\s+)*`
const GH_PUBLISH = new RegExp(
  SEGMENT_START +
    COMMAND_PREFIXES +
    String.raw`(?:\S*\/)?gh\s+(?:pr\s+(?:create|edit|comment|review|merge)|issue\s+(?:create|edit|comment|close)|release\s+(?:create|edit))\b`,
  'm',
)

/** Does this shell command publish PR/issue/release text on GitHub? */
export const matchesPrCommand = cmd => GH_PUBLISH.test(commandSkeleton(cmd))

// The escape hatch must also be in command-prefix position of the SKELETON —
// honored from quoted prose, a PR body QUOTING it would both bypass the gate
// and publish the marker.
const ALLOW_MARKER = new RegExp(SEGMENT_START + COMMAND_PREFIXES + String.raw`KM_ALLOW_BEAD_IDS=1\s`, 'm')
export const allowsBeadIds = cmd => ALLOW_MARKER.test(commandSkeleton(cmd))

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
          `No GitHub issue found for: ${unmapped.join(', ')} — check \`bd show <id>\`. A real bead may have been skipped by the sync watermark (edit it to bump updated_at, then retry); if the sync could not run here, find the issue via \`gh issue list --search\`.`,
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

const preconditions = (root = initializedDbRoot()) => {
  if (!root) return { ok: false, reason: 'no initialized beads DB (or bd not on PATH)' }
  const token = tryRun('gh', ['auth', 'token'])?.trim()
  if (!token) return { ok: false, reason: 'no gh token' }
  return { ok: true, root, env: { ...process.env, GITHUB_TOKEN: token, BD_NO_REMOTE_ADOPT: '1' } }
}

const processAlive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/**
 * One sync at a time across sessions/worktrees (they share the one DB). The
 * lock only serializes THIS script; bd itself may still run concurrently
 * elsewhere — which is why listBeads failures abort instead of soft-failing.
 * The lock file holds the holder's pid, so the common leak — a holder killed
 * before its cleanup ran — self-heals on the next attempt via a dead-pid
 * check instead of waiting out a staleness window. A narrow TOCTOU remains
 * (two stealers can both unlink between one's read and the other's create,
 * sweeping a just-created live lock): accepted — the worst case is two
 * concurrent runs of converging operations, and closing it fully needs
 * primitives the filesystem doesn't offer.
 */
const withLock = (root, fn) => {
  const lock = join(root, '.beads', 'github-sync.lock')
  // Migrate the pre-pid shape (a directory) so it can't wedge the file lock.
  try {
    if (statSync(lock, { throwIfNoEntry: false })?.isDirectory()) rmdirSync(lock)
  } catch {}
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' })
      break
    } catch {
      const holder = Number(tryRead(lock))
      const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now())
      if ((holder && !processAlive(holder)) || age > 10 * 60_000) {
        try {
          unlinkSync(lock)
        } catch {}
        continue
      }
      if (Date.now() > deadline) return { skipped: `another sync is running (pid ${holder || 'unknown'})` }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    }
  }
  const unlock = () => {
    try {
      unlinkSync(lock)
    } catch {}
  }
  // Covers a kill landing while this process is between children. While a
  // spawnSync child runs, the event loop is blocked and no handler fires —
  // that leak is what the dead-pid steal above then heals.
  const onTerm = () => {
    unlock()
    process.exit(143)
  }
  const onInt = () => {
    unlock()
    process.exit(130)
  }
  process.on('SIGTERM', onTerm)
  process.on('SIGINT', onInt)
  try {
    return fn()
  } finally {
    process.off('SIGTERM', onTerm)
    process.off('SIGINT', onInt)
    unlock()
  }
}

const tryRead = p => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

// All five statuses in one call; throws on failure. Callers slice by status —
// the plan functions own status selection, so nothing here pre-filters.
// --limit 0 is explicit: the documented default is 50, and a truncated bead
// list would put every unlisted open bead back on the re-open-the-issue path.
const listAllBeads = () =>
  JSON.parse(run('bd', ['list', '--status', 'open,in_progress,blocked,deferred,closed', '--limit', '0', '--json']))

const FETCH_LIMIT = 5000
const fetchIssues = () => {
  const rows = JSON.parse(
    run('gh', ['issue', 'list', '--repo', REPO, '--state', 'all', '--json', 'number,state,labels', '--limit', String(FETCH_LIMIT)]),
  )
  if (rows.length >= FETCH_LIMIT)
    throw new Error(`issue list hit the ${FETCH_LIMIT} fetch limit — raise it before trusting absence-based decisions`)
  // This repo can never legitimately have zero issues — an empty 200 is an
  // API blip or token-scope problem, and absence-based decisions downstream
  // (close-adoption finding nothing, close-pushes seeing everything absent)
  // would all be wrong at once.
  if (rows.length === 0) throw new Error('issue list came back empty — refusing absence-based decisions')
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
      if (dryRun) {
        report.push(`[dry-run] would close ${id} (issue #${number} was closed on GitHub)`)
      } else if (tryRun('bd', ['close', id, '--reason', `Closed on GitHub (issue #${number}); reconciled by bd-github-sync.`], { env }) !== null) {
        report.push(`closed ${id} (issue #${number} was closed on GitHub)`)
      } else {
        closeFailures.push(id)
      }
    }
    if (closeFailures.length)
      throw new Error(
        `aborting before push: could not adopt GitHub closes for ${closeFailures.join(', ')}` +
          (report.length ? ` (already applied: ${report.join('; ')})` : ''),
      )

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
    if (dryRun) report.push('[dry-run] priority un-flattening not simulated — it needs the post-sync state')
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
      if (dryRun) {
        report.push(`[dry-run] would close issue #${number} to match closed bead ${id}`)
        continue
      }
      // Verify the target just before acting: issues and PRs share one number
      // sequence and `gh issue close` happily closes a PR, so a mis-pointed
      // ref (or the beyond-max inference) must never act blind. Also skips
      // targets that converged since the fetch.
      let target = null
      try {
        target = JSON.parse(tryRun('gh', ['api', `repos/${REPO}/issues/${number}`], { env }) ?? 'null')
      } catch {}
      if (!target) {
        report.push(`FAILED to inspect #${number} (bead ${id}) — leaving it alone`)
        continue
      }
      if (target.pull_request) {
        report.push(`SKIPPED #${number}: it is a pull request — bead ${id} carries a mis-pointed external_ref`)
        continue
      }
      if (target.state === 'closed') continue
      const ok = tryRun('gh', ['issue', 'close', String(number), '--repo', REPO, '--reason', 'completed'], { env }) !== null
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
  const dbRoot = initializedDbRoot()
  const lookup = () => {
    if (!dbRoot) return new Map()
    // Multi-id `bd show` reports unknown ids as `Error fetching …` on stderr
    // while still printing the found beads' JSON on stdout, exit 0 — a
    // PARTIAL result. run()'s error-text check would read it as total failure
    // and poison the whole mapping table, so parse the stdout directly.
    const r = spawnSync('bd', ['show', ...ids, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      return new Map(JSON.parse(r.stdout ?? '[]').map(b => [b.id, issueNumberFromRef(b.external_ref)]))
    } catch {
      return new Map()
    }
  }

  let byId = lookup()
  const missing = ids.filter(id => !byId.get(id))
  const pre = missing.length ? preconditions(dbRoot) : { ok: false }
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

// Exact-path comparison: a suffix match would run a live sync at import time
// from any future sibling whose name this file's happens to end with.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
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
