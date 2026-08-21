#!/usr/bin/env node
/**
 * PostToolUse/PostToolUseFailure(Bash) hook: report what a publishing command
 * ACTUALLY published (issue #672). Published text exists exactly once — in
 * the GitHub object after gh composes it — so this hook reads THAT back and
 * reports ground truth instead of reconstructing shell semantics:
 *
 *   - every #N in the published text is echoed back with its real
 *     title/state/kind as additionalContext, so a guessed number is visible
 *     in-context immediately after publishing. Close keywords only ACT at
 *     merge, so fixing a body after publication loses nothing.
 *   - bead ids (km-…) in a published body/title are reported with the issue
 *     number each maps to, for the agent to substitute — GitHub readers
 *     cannot resolve a bead id. Skipped when the command carried
 *     KM_ALLOW_BEAD_IDS=1, whose escape marks the mention as deliberate.
 *   - a MERGED PR additionally gets its merge commit read back (detected
 *     from gh's own "Merged pull request #N" line): its close keywords have
 *     already acted, so the echo names what was closed while reopening a
 *     wrong one is still cheap — covering merge text no pre-gate could read.
 *
 * This hook READS ONLY. It once rewrote bead ids in place, which required
 * knowing that a URL in the output belonged to THIS command — an association
 * the payload never states (the Bash tool merges a whole invocation's output)
 * and that only shell parsing could recover. Approximating it cost six
 * separate vetoes, each its own text classifier with its own false-positive
 * and false-negative; the guard surface grew faster than the repair's reach.
 * Reporting needs no such association: a wrong number in front of the agent
 * gets fixed by hand in one command. Deleted deliberately — do not restore a
 * write path here without solving output→command attribution first.
 *
 * Coverage is exactly the objects the command's OUTPUT names: the URLs gh
 * prints for CLI publishes, the top-level html_urls of `gh api` response
 * lines. CLI targets are filtered to the kinds the command's verbs can
 * produce (publishableKinds) as a noise bound. Accepted residuals: an
 * api-created review's inline comments[].body ride outside the review object
 * this hook fetches; commit-comment URLs (/commit/<sha>#commitcomment-N) are
 * not classified — nothing in this repo's flows publishes them; queued/--auto
 * merges land later with no success line, so their commits are not read back;
 * and bead ids inside landed commit MESSAGES are not scanned.
 *
 * Blocking here would be pointless (the publish already happened), so this
 * hook never does: any internal failure exits 0 silently, and every
 * subprocess carries a timeout so the host's kill cannot land with the
 * report unemitted.
 */

import { readFileSync } from 'node:fs'
import {
  REPO,
  allowsBeadIds,
  beadIssueLookup,
  closeKeywordRefs,
  extractBeadIds,
  extractIssueRefs,
  initializedDbRoot,
  isMainModule,
  issueRefsTable,
  matchesApiPublish,
  matchesPrCommand,
  publishableKinds,
  tryRun,
} from './bd-github-sync.mjs'

// ---------------------------------------------------------------------------
// Pure logic (unit-tested in bd-publish-verify.test.ts)
// ---------------------------------------------------------------------------

// Fragments before path groups: a fragment URL also contains /pull/N, and
// the fragment's object is what this command touched, not its parent.
const TARGET_URL = () =>
  new RegExp(
    String.raw`https://github\.com/${REPO}/(?:pull/(\d+)|issues/(\d+)|releases/tag/([^\s"'\\<>)\]]+))(?:#issuecomment-(\d+)|#discussion_r(\d+)|#pullrequestreview-(\d+))?`,
    'g',
  )

const classify = (pr, issue, tag, commentId, reviewCommentId, reviewId) =>
  commentId
    ? { kind: 'comment', id: Number(commentId) }
    : reviewCommentId
      ? { kind: 'review-comment', id: Number(reviewCommentId) }
      : reviewId
        ? { kind: 'review', pr: Number(pr), id: Number(reviewId) }
        : tag
          ? { kind: 'release', tag }
          : pr
            ? { kind: 'pr', number: Number(pr) }
            : { kind: 'issue', number: Number(issue) }

// gh api prints its JSON on one line, but the Bash tool merges stderr into
// the same stream — an update notice must not turn a verifiable publish into
// a silent skip, so fall back to per-line parsing. EVERY object line's
// html_url is collected, not the first: a sibling command can print a JSON
// object of its own, and picking one would be output→command association
// this hook cannot do. Reporting all of them is the right answer here —
// an extra object costs one echoed line.
const topLevelUrls = output => {
  const urlsOf = s => {
    try {
      const j = JSON.parse(s)
      // --slurp (and --paginate) wrap responses in an array — every
      // element's top-level html_url counts, same as multi-line output.
      const objs = Array.isArray(j) ? j : [j]
      const urls = objs.map(o => (o && typeof o === 'object' && typeof o.html_url === 'string' ? o.html_url : null)).filter(Boolean)
      return urls.length ? urls : null
    } catch {
      return null
    }
  }
  const whole = urlsOf(output)
  if (whole) return whole
  return output
    .split('\n')
    .flatMap(line => urlsOf(line.trim()) ?? [])
}

/**
 * The objects this command published, from its output. A `gh api` mutation's
 * output IS the mutated object, and its body can QUOTE foreign URLs (a
 * comment quoting another PR), so there only the top-level html_url names
 * what the command touched. CLI publish output never echoes bodies — gh
 * prints the target's URL — but sibling commands in the same invocation can
 * print anything, so CLI targets are limited to the kinds this command's
 * publish verbs produce.
 */
export const publishedTargets = (cmd, output) => {
  const seen = new Map()
  const collect = (text, kinds) => {
    for (const m of text.matchAll(TARGET_URL())) {
      const t = classify(...m.slice(1))
      if (kinds && !kinds.has(t.kind)) continue
      seen.set(JSON.stringify(t), t)
    }
  }
  // One invocation can do both, so both scans run and their targets union —
  // selecting a single mode by command kind dropped the api-published object
  // whenever a CLI publisher rode along. In that mixed case the CLI scan also
  // sees the api response's body, so a URL quoted there can be reported as
  // published; with nothing writing any more, that costs an echoed line.
  if (matchesPrCommand(cmd)) collect(output, publishableKinds(cmd))
  if (matchesApiPublish(cmd)) collect(topLevelUrls(output).join('\n'), null)
  return [...seen.values()]
}

// A merged PR is detected from gh's own success line, not by parsing the
// command: the pattern only ever appears in merge output, and it names the
// PR whose merge COMMIT — the one truly unrepairable text — can then be
// read back from the API (#683: detection where prevention cannot reach).
const MERGED_PR = () => /Merged pull request ((?:[\w.-]+\/[\w.-]+)?)#(\d+)/g
// A -R merge prints the qualified `owner/repo#N` — a foreign qualifier must
// not read back OUR PR of that number.
export const mergedPrNumbers = output =>
  [...new Set(
    [...output.matchAll(MERGED_PR())].filter(m => m[1] === '' || m[1] === REPO).map(m => Number(m[2])),
  )]

export const apiPathFor = t =>
  t.kind === 'pr'
    ? `repos/${REPO}/pulls/${t.number}`
    : t.kind === 'issue'
      ? `repos/${REPO}/issues/${t.number}`
      : t.kind === 'comment'
        ? `repos/${REPO}/issues/comments/${t.id}`
        : t.kind === 'review-comment'
          ? `repos/${REPO}/pulls/comments/${t.id}`
          : t.kind === 'review'
            ? `repos/${REPO}/pulls/${t.pr}/reviews/${t.id}`
            : `repos/${REPO}/releases/tags/${t.tag}`

// additionalContext shares the host's ~10K inline budget with every other
// hook on the event (measured for SessionStart in issue #643; assume the
// same order here). The trailing surrogate strip keeps a clipped emoji from
// mojibaking the tail.
export const clipContext = (s, max = 9_000) =>
  s.length <= max
    ? s
    : `${s.slice(0, max - 80).replace(/[\uD800-\uDBFF]$/, '')}\n[bd-publish-verify] context clipped to fit the hook inline limit`

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

const MAX_TARGETS = 5
const REFS_CAP = 15
const GH_TIMEOUT = 10_000
// Self-imposed budget well under the 120s hook timeout in settings.json, so
// the host's kill never lands with the report unemitted. Every step is one
// GH_TIMEOUT-bounded fetch, and per-target refs echoes size themselves to
// the time left.
const DEADLINE_MS = Number(process.env.BD_PUBLISH_VERIFY_BUDGET_MS ?? 70_000)

const ghJson = args => {
  try {
    return JSON.parse(tryRun('gh', args, { timeout: GH_TIMEOUT }) ?? 'null')
  } catch {
    return null
  }
}

// Which field carries the object's "title" text, when it has one.
const TITLE_FIELD = { pr: 'title', issue: 'title', release: 'name' }

const titleOf = (t, obj) => {
  const field = TITLE_FIELD[t.kind]
  return field && typeof obj?.[field] === 'string' ? obj[field] : ''
}

const verifyTarget = (t, { reportIds, deadline }) => {
  const notes = []
  const fetched = ghJson(['api', apiPathFor(t)])
  if (!fetched || typeof fetched !== 'object') return notes
  const label = typeof fetched.html_url === 'string' ? fetched.html_url : apiPathFor(t)
  const text = `${titleOf(t, fetched)}\n${typeof fetched.body === 'string' ? fetched.body : ''}`

  // Bead ids are reported, never substituted: the mapped numbers join the
  // refs echo below, so the agent reads each real title before pasting it.
  const ids = reportIds ? extractBeadIds(text) : []
  // No bd call of any kind before the DB-exists gate: in a clone without a
  // beads DB, any bd command CREATES an empty one that then refuses to pull.
  const byId = ids.length && initializedDbRoot() ? beadIssueLookup(ids) : new Map()
  if (ids.length)
    notes.push(
      `${label} publishes bead ids, which are opaque to GitHub readers — replace them now (gh pr edit / gh issue edit / gh api PATCH): ` +
        ids.map(id => (byId.get(id) ? `${id} → #${byId.get(id)}` : `${id} → no GitHub issue yet; run pnpm bd:sync`)).join(', '),
    )

  const refs = [...new Set([...extractIssueRefs(text), ...[...byId.values()].filter(Boolean)])]
  if (refs.length) {
    // The echo sizes itself to the time left: each lookup is bounded by
    // GH_TIMEOUT, so echoing more refs than the remaining budget divides
    // into could overrun the deadline and lose the whole report.
    const budget = Math.max(0, Math.floor((deadline - Date.now()) / GH_TIMEOUT) - 1)
    const cap = Math.min(REFS_CAP, budget)
    const capNote = refs.length > cap ? `\n  …and ${refs.length - cap} more references not echoed` : ''
    if (cap > 0) notes.push(`${label}\n${issueRefsTable(text, refs.slice(0, cap), 'post')}${capNote}`)
    else notes.push(`${label}: ${refs.length} issue references not echoed (out of time budget) — check them yourself`)
  }
  return notes
}

// The merge commit's close keywords have ALREADY acted by the time this
// runs, so this is detection, not prevention (#683: D): read the commit —
// the ground truth every pre-publish channel guess was trying to predict —
// and put what it references in front of the agent while reopening a
// wrongly closed issue is still cheap. Squash merges carry the PR body's
// keywords into the commit, so this covers file-fed and expanded merge text
// that no pre-gate could read.
const verifyMergeCommit = (n, deadline) => {
  const notes = []
  const pr = ghJson(['api', `repos/${REPO}/pulls/${n}`])
  if (!pr?.merged || typeof pr.merge_commit_sha !== 'string') return notes
  const commit = ghJson(['api', `repos/${REPO}/commits/${pr.merge_commit_sha}`])
  // A rebase merge lands each PR commit directly and merge_commit_sha names
  // only the rebased head — the PR's own commit messages carry the rest of
  // the acted close keywords, so they are scanned too (one listing call,
  // covers every merge strategy).
  const prCommits = ghJson(['api', `repos/${REPO}/pulls/${n}/commits?per_page=100`])
  const commitMsgs = Array.isArray(prCommits)
    ? prCommits.map(c => c?.commit?.message).filter(m => typeof m === 'string')
    : []
  const headMsg = typeof commit?.commit?.message === 'string' ? commit.commit.message : ''
  const message = [headMsg, ...commitMsgs].join('\n')
  const pageNote = commitMsgs.length === 100 ? `\n  …only the first 100 landed commits were scanned` : ''
  if (!message.trim()) return notes
  // The PR's own number always appears in a merge-commit message — echoing
  // it back would be pure noise.
  const refs = extractIssueRefs(message).filter(r => r !== n)
  if (!refs.length) return notes
  const budget = Math.max(0, Math.floor((deadline - Date.now()) / GH_TIMEOUT) - 1)
  const cap = Math.min(REFS_CAP, budget)
  if (cap === 0) return [`merge commit of #${n}: ${refs.length} issue references not echoed (out of time budget) — check them yourself`]
  // Only the HEAD commit's text is known to have landed under every merge
  // strategy — a squash with custom subject/body does not land the PR's own
  // commit messages, so their close keywords may never have acted and must
  // not prompt a reopen.
  const headCloses = closeKeywordRefs(headMsg).filter(r => r !== n)
  const commitCloses = closeKeywordRefs(commitMsgs.join('\n')).filter(r => r !== n && !headCloses.includes(r))
  const warn =
    (headCloses.length
      ? `\n  ⚠ close keywords in the merge commit have ALREADY acted — if an issue above was closed wrongly, reopen it now (gh issue reopen <n>)`
      : '') +
    (commitCloses.length
      ? `\n  (close keywords in the PR's own commits acted only if this was a merge or rebase — a squash with custom text did not land them)`
      : '')
  const capNote = refs.length > cap ? `\n  …and ${refs.length - cap} more references not echoed` : ''
  return [`merge commit ${pr.merge_commit_sha.slice(0, 9)} of #${n}:\n${issueRefsTable(message, refs.slice(0, cap), 'post')}${capNote}${pageNote}${warn}`]
}

const hookPostPublish = () => {
  let payload = {}
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return
  }
  const cmd = payload?.tool_input?.command ?? ''
  // The Bash tool merges stderr into tool_response.stdout; on
  // PostToolUseFailure there is NO tool_response and the output rides inside
  // the `error` string (both measured 2026-08-20).
  const out =
    typeof payload?.tool_response?.stdout === 'string' && payload.tool_response.stdout
      ? payload.tool_response.stdout
      : typeof payload?.error === 'string'
        ? payload.error
        : ''
  if (!cmd || !out) return
  if (!matchesPrCommand(cmd) && !matchesApiPublish(cmd)) return
  const all = publishedTargets(cmd, out)
  const allMerged = matchesPrCommand(cmd) ? mergedPrNumbers(out) : []
  const mergedPrs = allMerged.slice(0, 2)
  if (!all.length && !mergedPrs.length) return
  const targets = all.slice(0, MAX_TARGETS)
  const reportIds = !allowsBeadIds(cmd)
  const deadline = Date.now() + DEADLINE_MS
  const notes = []
  if (all.length > targets.length)
    notes.push(`only the first ${MAX_TARGETS} of ${all.length} published objects named in the output were verified`)
  if (allMerged.length > mergedPrs.length)
    notes.push(`${allMerged.length - mergedPrs.length} additional merged PR(s) not read back — check their landed commits yourself`)
  for (const [i, t] of targets.entries()) {
    if (Date.now() >= deadline) {
      notes.push(`${targets.length - i} published object(s) not verified (out of time budget) — check them yourself`)
      break
    }
    try {
      notes.push(...verifyTarget(t, { reportIds, deadline }))
    } catch {
      // Defence in depth, not currently reachable: every failure inside
      // verifyTarget already resolves to a note or a silent skip. A future
      // edit that can throw must not kill the remaining targets' sweep.
    }
  }
  for (const [i, n] of mergedPrs.entries()) {
    if (Date.now() >= deadline) {
      notes.push(`${mergedPrs.length - i} merged PR(s) not read back (out of time budget) — check their landed commits yourself`)
      break
    }
    try {
      notes.push(...verifyMergeCommit(n, deadline))
    } catch {
      // same defence-in-depth contract as the targets loop above
    }
  }
  const eventName = payload?.hook_event_name === 'PostToolUseFailure' ? 'PostToolUseFailure' : 'PostToolUse'
  if (notes.length)
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: eventName,
          additionalContext: clipContext(
            `bd-publish-verify (ground truth read back from the GitHub API):\n${notes.join('\n')}`,
          ),
        },
      }),
    )
}

if (isMainModule(import.meta.url)) {
  try {
    hookPostPublish()
  } catch {
    // never fail: the publish already happened; a broken verifier must not
    // surface as a hook error on every gh command
  }
  process.exit(0)
}
