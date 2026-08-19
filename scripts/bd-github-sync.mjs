#!/usr/bin/env node
/**
 * beads↔GitHub sync with the two documented traps guarded (AGENTS.md beads
 * section; memory reference_bd_github_sync_close_ordering):
 *
 * 1. A GitHub-side close (hand-close or a merged "Fixes #N") is CLOBBERED by
 *    the next sync — the still-open bead pushes over it and re-opens the
 *    issue. So GitHub-side closes are adopted into beads BEFORE syncing.
 * 2. A pull flattens bead priority to P2 while the real priority lives in the
 *    issue's P0–P4 / priority::N label. So after syncing, beads sitting at
 *    the flattened value get their priority re-derived from the label and
 *    pushed back.
 * 3. A bead closed BEFORE its first sync stays closed locally but its issue is
 *    minted OPEN. So after syncing, closed beads whose issue is open get a
 *    selective close-push (which does carry CLOSED once the link exists).
 *    Note the deliberate asymmetry with (1): GitHub-side CLOSES are adopted
 *    (they come from PR merges), GitHub-side REOPENS do not stick (beads is
 *    the source of truth; reopen the bead instead).
 *
 * Modes:
 *   node scripts/bd-github-sync.mjs               # full sync (manual / SessionEnd)
 *   node scripts/bd-github-sync.mjs --quiet       # only report when something changed
 *   node scripts/bd-github-sync.mjs --dry-run     # print plans, mutate nothing
 *   node scripts/bd-github-sync.mjs --hook-pre-pr # Claude Code PreToolUse(Bash) hook:
 *       fast-exits unless the command publishes PR/issue text (gh pr create/edit/
 *       comment, gh issue comment) AND that text references bead ids (km-…).
 *       Then it mints GitHub issues for any referenced bead that lacks one
 *       (selective --issues push, seconds) and BLOCKS (exit 2) with the km→#N
 *       substitution table — public text must use issue numbers, which GitHub
 *       readers can resolve and bead ids are not.
 *       Escape hatch: prefix the command with KM_ALLOW_BEAD_IDS=1.
 *       The FULL sync does not run here: converged it still costs ~60s (a GET
 *       compare per issue), which is too slow to sit in front of every PR.
 *       SessionEnd and manual runs carry it.
 *
 * Every path no-ops silently when bd, the beads DB, or a gh token is missing
 * (cloud sessions) — except the hook's bead-id block, which still fires: an
 * unmapped reference is worth blocking even where the sync can't run.
 *
 * bd prints `Error:` and exits 0, so failure is detected from output text.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const REPO = 'Stvad/knowledge-medium'

// ---------------------------------------------------------------------------
// Pure logic (unit-tested in bd-github-sync.test.ts)
// ---------------------------------------------------------------------------

const BEAD_ID = /(?<![\w-])km-[a-z0-9]+(?:-[a-z0-9]+)*(?![\w-])/g

/** Unique bead ids referenced in a blob of text, in first-seen order. */
export const extractBeadIds = text => [...new Set(text.match(BEAD_ID) ?? [])]

/** Does this shell command publish PR/issue text on GitHub? */
export const matchesPrCommand = cmd =>
  /\bgh\s+(?:pr\s+(?:create|edit|comment)|issue\s+comment)\b/.test(cmd)

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

/**
 * Priority 0–4 from GitHub label names. The machine label (`priority::high`,
 * upstream's PriorityMapping vocabulary) wins over the hand label (`P1`) —
 * though bd's own pull already maps the machine labels, so the hand-label
 * branch is the one that actually rescues flattened imports.
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

export const issueNumberFromRef = ref => {
  const m = /\/issues\/(\d+)$/.exec(ref ?? '')
  return m ? Number(m[1]) : null
}

/**
 * Non-closed beads whose GitHub issue is closed. Only the flattened default
 * (priority 2) is ever corrected, so a deliberate bd-side priority that
 * disagrees with a stale hand label is never overwritten.
 */
export const planCloseReconciliation = (beads, issueByNumber) =>
  beads
    .filter(b => b.status !== 'closed')
    .map(b => ({ id: b.id, number: issueNumberFromRef(b.external_ref) }))
    .filter(({ number }) => number !== null && issueByNumber.get(number)?.state === 'CLOSED')

/**
 * Closed beads whose GitHub issue is still open (minted after the close). An
 * issue absent from the map counts as open: the map predates the sync, so the
 * canonical case — an issue minted DURING this run for an already-closed bead
 * — is exactly the one the map cannot contain. A redundant selective push of
 * an already-closed pair is a no-op, so over-inclusion is safe.
 */
export const planClosePushes = (closedBeads, issueByNumber) =>
  closedBeads
    .filter(b => b.status === 'closed')
    .map(b => ({ id: b.id, number: issueNumberFromRef(b.external_ref) }))
    .filter(({ number }) => number !== null && (issueByNumber.get(number)?.state ?? 'OPEN') === 'OPEN')

export const planPriorityFixes = (beads, issueByNumber) =>
  beads
    .filter(b => b.priority === 2)
    .map(b => {
      const issue = issueByNumber.get(issueNumberFromRef(b.external_ref))
      const to = issue ? deriveLabelPriority(issue.labels) : null
      return { id: b.id, to }
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
  const out = execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
  // bd reports failures as `Error: …` on stdout with exit 0 — treat that as a
  // real failure so callers can't silently succeed-with-failure.
  if (file === 'bd' && /^Error/m.test(out)) throw new Error(`bd ${args[0]}: ${out.trim()}`)
  return out
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

/**
 * All three must hold before invoking any bd command: the first bd call in a
 * fresh clone would CREATE an empty DB, which then refuses to pull (AGENTS.md
 * cloud-session trap) — so the DB's prior existence is itself a precondition.
 */
const preconditions = () => {
  const root = mainRepoRoot()
  if (!root || !existsSync(join(root, '.beads', 'embeddeddolt'))) return { ok: false, reason: 'no initialized beads DB' }
  if (!tryRun('bd', ['--version'])) return { ok: false, reason: 'bd not on PATH' }
  const token = tryRun('gh', ['auth', 'token'])?.trim()
  if (!token) return { ok: false, reason: 'no gh token' }
  return { ok: true, root, token }
}

/** One sync at a time across sessions/worktrees (they share the one DB). */
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
          rmdirSync(lock)
        } catch {}
        continue
      }
      if (Date.now() > deadline) return { skipped: 'another sync is running' }
      execFileSync('sleep', ['0.5'])
    }
  }
  try {
    return fn()
  } finally {
    try {
      rmdirSync(lock)
    } catch {}
  }
}

const listBeads = statuses =>
  statuses.flatMap(status => {
    const out = tryRun('bd', ['list', '--status', status, '--json'])
    return out ? JSON.parse(out) : []
  })

const fetchIssues = () => {
  const out = run('gh', [
    'issue', 'list', '--repo', REPO, '--state', 'all',
    '--json', 'number,state,labels', '--limit', '1000',
  ])
  return new Map(JSON.parse(out).map(i => [i.number, { state: i.state, labels: i.labels.map(l => l.name) }]))
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
  const env = { ...process.env, GITHUB_TOKEN: pre.token, BD_NO_REMOTE_ADOPT: '1' }

  return withLock(pre.root, () => {
    const issues = fetchIssues()
    const report = []

    // 1. Adopt GitHub-side closes BEFORE pushing (see header).
    const closes = planCloseReconciliation(listBeads(['open', 'in_progress', 'blocked']), issues)
    for (const { id, number } of closes) {
      if (!dryRun) run('bd', ['close', id, '--reason', `Closed on GitHub (issue #${number}); reconciled by bd-github-sync.`], { env })
      report.push(`closed ${id} (issue #${number} was closed on GitHub)`)
    }

    // 2. The sync itself.
    const syncOut = run('bd', ['github', 'sync', ...(dryRun ? ['--dry-run'] : [])], { env })
    const syncSummary = syncOut
      .split('\n')
      .filter(l => /Pulled|Pushed|Created|Updated|dry-run/.test(l))
      .map(l => l.trim())
    report.push(...syncSummary)

    // 3. Un-flatten priorities pulled as P2, and push the fixes back.
    const fixes = planPriorityFixes(listBeads(['open', 'in_progress', 'blocked']), issues)
    for (const { id, to } of fixes) {
      if (!dryRun) run('bd', ['update', id, '-p', String(to)], { env })
      report.push(`priority ${id} → ${to} (re-derived from label after pull-flattening)`)
    }
    if (fixes.length && !dryRun) run('bd', ['github', 'sync', '--push-only', '--issues', fixes.map(f => f.id).join(',')], { env })

    // 4. Carry pre-first-sync bead closes out to their just-minted issues.
    const closePushes = planClosePushes(listBeads(['closed']), issues)
    for (const { id, number } of closePushes) report.push(`pushing close of ${id} to open issue #${number}`)
    if (closePushes.length && !dryRun)
      run('bd', ['github', 'sync', '--push-only', '--issues', closePushes.map(c => c.id).join(',')], { env })

    const changed = closes.length + fixes.length + closePushes.length > 0 || syncSummary.some(l => /[1-9]/.test(l))
    if (!quiet || changed) console.log(['bd-github-sync:', ...report].join('\n  '))
    return { closes, fixes, closePushes }
  })
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
  if (/\bKM_ALLOW_BEAD_IDS=1\b/.test(cmd)) allow()

  const cwd = payload?.cwd ?? process.cwd()
  const bodies = bodyFilePaths(cmd)
    .map(p => (isAbsolute(p) ? p : resolve(cwd, p)))
    .filter(p => existsSync(p))
    .map(p => readFileSync(p, 'utf8'))
  const ids = extractBeadIds([cmd, ...bodies].join('\n'))
  if (ids.length === 0) allow()

  const lookup = () => {
    const shown = tryRun('bd', ['show', ...ids, '--json'])
    return new Map((shown ? JSON.parse(shown) : []).map(b => [b.id, issueNumberFromRef(b.external_ref)]))
  }

  let byId = lookup()
  const missing = ids.filter(id => !byId.get(id))
  const pre = missing.length ? preconditions() : { ok: false }
  if (pre.ok && process.env.BD_GITHUB_SYNC_DRY !== '1') {
    // Mint issues for referenced beads that have none — selective push, seconds.
    const env = { ...process.env, GITHUB_TOKEN: pre.token, BD_NO_REMOTE_ADOPT: '1' }
    tryRun('bd', ['github', 'sync', '--push-only', '--issues', missing.join(',')], { env })
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
