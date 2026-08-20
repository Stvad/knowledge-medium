#!/usr/bin/env node
/**
 * PostToolUse/PostToolUseFailure(Bash) hook: verify what a publishing command
 * ACTUALLY published (issue #672). Published text exists exactly once — in
 * the GitHub object after gh composes it — so this hook reads THAT back and
 * acts on ground truth instead of reconstructing shell semantics:
 *
 *   - bead ids (km-…) in a published body/title are rewritten to their issue
 *     numbers in place, minting the issue first when the bead has none —
 *     GitHub readers cannot resolve a bead id. Skipped when the command
 *     carried KM_ALLOW_BEAD_IDS=1: the pre-gate's escape marks the mention
 *     as a deliberate literal, and rewriting it would corrupt intended text.
 *   - every #N in the published text is echoed back with its real
 *     title/state/kind as additionalContext, so a guessed number is visible
 *     in-context immediately after publishing. Close keywords only ACT at
 *     merge, so fixing a body after publication loses nothing — the paths
 *     where repair CANNOT reach (gh pr merge / gh pr review text, GraphQL
 *     mutations, --silent api calls, git commit messages) keep their
 *     pre-publish checks in bd-github-sync.mjs instead.
 *
 * Coverage is exactly the objects the command's OUTPUT names: the URLs gh
 * prints for CLI publishes, the top-level html_urls of `gh api` response
 * lines. The Bash tool merges the whole invocation's output with no
 * output→command attribution, and recovering one would be shell parsing —
 * so the WRITE path takes only the case that needs no association at all:
 * the output names exactly ONE object in total (the real publish's URL is
 * always present, so anything a sibling printed makes two candidates and
 * disqualifies the write) and the command carries no explicit GET method
 * (a compound can mix a read segment with the mutation). Everything else is
 * echo-only. CLI targets are additionally filtered to the kinds the
 * command's verbs can produce (repairableKinds) as a noise bound. Accepted
 * residuals: truncated tool output that cuts inside an id resolves to a
 * wrong — then merely echoed — object, and in a compound that mixes `gh
 * api` with CLI publishes the api-published object goes unverified.
 *
 * Blocking here would be pointless (the publish already happened), so this
 * hook never does: any internal failure exits 0 silently, a failed repair is
 * reported for hand-fixing, and every subprocess carries a timeout so a
 * killable hook cannot be caught mid-rewrite with its report unemitted.
 *
 * BD_GITHUB_SYNC_DRY=1 in the environment suppresses the writes (mint +
 * body PATCH) — the same pipe-test valve the sibling hooks use.
 */

import { readFileSync } from 'node:fs'
import {
  BEAD_ID,
  REPO,
  allowsBeadIds,
  beadIssueLookupWithMint,
  extractBeadIds,
  extractIssueRefs,
  fetchIssueInfo,
  hasExplicitGetMethod,
  isMainModule,
  issueRefsTable,
  matchesApiPublish,
  matchesPrCommand,
  repairableKinds,
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
// this hook cannot do — multiple candidates instead disqualify the repair
// via the single-object gate below.
const topLevelUrls = output => {
  const urlOf = s => {
    try {
      const j = JSON.parse(s)
      return j && typeof j === 'object' && typeof j.html_url === 'string' ? j.html_url : null
    } catch {
      return null
    }
  }
  const whole = urlOf(output)
  if (whole) return [whole]
  return output
    .split('\n')
    .map(line => urlOf(line.trim()))
    .filter(Boolean)
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
  let scanText = output
  let kinds = null
  if (matchesPrCommand(cmd)) {
    kinds = repairableKinds(cmd)
  } else {
    scanText = topLevelUrls(output).join('\n')
  }
  const seen = new Map()
  for (const m of scanText.matchAll(TARGET_URL())) {
    const t = classify(...m.slice(1))
    if (kinds && !kinds.has(t.kind)) continue
    seen.set(JSON.stringify(t), t)
  }
  return [...seen.values()]
}

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

/** Substitute every mappable bead id with its #N; report both outcomes. */
export const planBeadIdRewrite = (text, byId) => {
  const rewrites = new Map()
  const unmapped = new Set()
  const newText = text.replace(BEAD_ID, id => {
    const number = byId.get(id)
    if (!number) {
      unmapped.add(id)
      return id
    }
    rewrites.set(id, number)
    return `#${number}`
  })
  return {
    newText,
    rewrites: [...rewrites].map(([id, number]) => ({ id, number })),
    unmapped: [...unmapped],
  }
}

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
// Self-imposed budget well under the 120s hook timeout in settings.json:
// the host's kill must never land after a PATCH but before its report. The
// worst single overshoot past a deadline check is one fetch + the mint +
// one re-fetch (≈65s with the per-spawn timeouts), so 50s of headroom
// covers it; per-target refs echoes size themselves to the time left.
const DEADLINE_MS = 70_000

const ghJson = args => {
  try {
    return JSON.parse(tryRun('gh', args, { timeout: GH_TIMEOUT }) ?? 'null')
  } catch {
    return null
  }
}

// Which PATCH/PUT field carries the object's "title" text, when it has one.
const TITLE_FIELD = { pr: 'title', issue: 'title', release: 'name' }

const patchTarget = (t, fetched, fields) => {
  // Releases PATCH by numeric id, not tag; review bodies update via PUT.
  const path = t.kind === 'release' ? `repos/${REPO}/releases/${fetched.id}` : apiPathFor(t)
  const method = t.kind === 'review' ? 'PUT' : 'PATCH'
  // stdio[0] must be pipe: run()'s 'ignore' default silently discards `input`.
  return (
    tryRun('gh', ['api', '-X', method, path, '--input', '-'], {
      input: JSON.stringify(fields),
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: GH_TIMEOUT,
    }) !== null
  )
}

const titleOf = (t, obj) => {
  const field = TITLE_FIELD[t.kind]
  return field && typeof obj?.[field] === 'string' ? obj[field] : ''
}

const unmappedNote = (ids, label, dry) =>
  `${ids.join(', ')} in ${label} ${ids.length > 1 ? 'have' : 'has'} no GitHub issue` +
  `${dry ? ' (mint suppressed by BD_GITHUB_SYNC_DRY)' : ' and minting failed here'} — run pnpm bd:sync, then fix the published text`

const verifyTarget = (t, { dry, repairVeto, rewriteAllowed, deadline }) => {
  const notes = []
  const fetched = ghJson(['api', apiPathFor(t)])
  if (!fetched || typeof fetched !== 'object') return notes
  const label = typeof fetched.html_url === 'string' ? fetched.html_url : apiPathFor(t)
  let finalTitle = titleOf(t, fetched)
  let finalBody = typeof fetched.body === 'string' ? fetched.body : ''

  const ids = rewriteAllowed ? extractBeadIds(`${finalTitle}\n${finalBody}`) : []
  if (ids.length) {
    const byId = beadIssueLookupWithMint(ids, { dry })
    // A stale external_ref (deleted or transferred issue) must not be
    // written into public text — rewrite only mappings whose issue resolves.
    const stale = []
    for (const [id, number] of [...byId]) {
      if (number && typeof fetchIssueInfo(number) !== 'object') {
        byId.delete(id)
        stale.push(`${id} → #${number}`)
      }
    }
    if (stale.length)
      notes.push(
        `left ${stale.join(', ')} alone in ${label} — the mapped issue does not resolve (stale sync state?); fix by hand`,
      )
    if (![...byId.values()].some(Boolean)) {
      notes.push(unmappedNote(ids.filter(id => !byId.get(id)), label, dry))
    } else {
      // The mint above can take seconds — re-read the object and rewrite the
      // FRESH text, or a concurrent edit would be overwritten with this
      // hook's stale copy.
      const fresh = dry ? fetched : ghJson(['api', apiPathFor(t)])
      if (!fresh || typeof fresh !== 'object') {
        notes.push(`did NOT rewrite bead ids in ${label} — could not re-read it before writing; fix by hand`)
      } else {
        const freshTitle = titleOf(t, fresh)
        const freshBody = typeof fresh.body === 'string' ? fresh.body : ''
        const titlePlan = planBeadIdRewrite(freshTitle, byId)
        const bodyPlan = planBeadIdRewrite(freshBody, byId)
        const rewrites = [...new Map([...titlePlan.rewrites, ...bodyPlan.rewrites].map(r => [r.id, r])).values()]
        const unmapped = [...new Set([...titlePlan.unmapped, ...bodyPlan.unmapped])]
        if (rewrites.length) {
          const subs = rewrites.map(r => `${r.id} → #${r.number}`).join(', ')
          const titleField = TITLE_FIELD[t.kind]
          const fields = {
            ...(bodyPlan.newText !== freshBody ? { body: bodyPlan.newText } : {}),
            ...(titleField && titlePlan.newText !== freshTitle ? { [titleField]: titlePlan.newText } : {}),
          }
          if (dry) {
            notes.push(`[dry-run] would rewrite ${subs} in ${label}`)
          } else if (repairVeto) {
            notes.push(`NOT auto-rewriting ${subs} in ${label} — ${repairVeto}; fix by hand`)
          } else if (patchTarget(t, fresh, fields)) {
            notes.push(`rewrote ${subs} in ${label} — bead ids are opaque to GitHub readers`)
            finalTitle = titlePlan.newText
            finalBody = bodyPlan.newText
          } else {
            notes.push(`FAILED to rewrite ${subs} in ${label} — edit it by hand; bead ids are opaque to GitHub readers`)
          }
        }
        if (unmapped.length) notes.push(unmappedNote(unmapped, label, dry))
      }
    }
  }

  const finalText = `${finalTitle}\n${finalBody}`
  const refs = extractIssueRefs(finalText)
  if (refs.length) {
    // The echo sizes itself to the time left: each lookup is bounded by
    // GH_TIMEOUT, so echoing more refs than the remaining budget divides
    // into could overrun the deadline and cost an already-made repair its
    // report.
    const budget = Math.max(0, Math.floor((deadline - Date.now()) / GH_TIMEOUT) - 1)
    const cap = Math.min(REFS_CAP, budget)
    const capNote = refs.length > cap ? `\n  …and ${refs.length - cap} more references not echoed` : ''
    if (cap > 0) notes.push(`${label}\n${issueRefsTable(finalText, refs.slice(0, cap), 'post')}${capNote}`)
    else notes.push(`${label}: ${refs.length} issue references not echoed (out of time budget) — check them yourself`)
  }
  return notes
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
  if (!all.length) return
  const targets = all.slice(0, MAX_TARGETS)
  const dry = process.env.BD_GITHUB_SYNC_DRY === '1'
  const rewriteAllowed = !allowsBeadIds(cmd)
  // Repair needs NO output→command association only when the output names
  // exactly ONE object in total: the real publish's URL is always in the
  // output, so anything a sibling command printed makes two candidates and
  // disqualifies the write — for every mode, api included. An explicit GET
  // anywhere in the command also vetoes: a compound can mix a read segment
  // with the mutation, and a merely READ object must never be written.
  const repairVeto =
    all.length > 1
      ? 'the output names more than one object, so this hook cannot tell which one the command published'
      : hasExplicitGetMethod(cmd)
        ? 'the command carries an explicit GET, and an object a read segment printed must never be written'
        : null
  const deadline = Date.now() + DEADLINE_MS
  const notes = []
  if (all.length > targets.length)
    notes.push(`only the first ${MAX_TARGETS} of ${all.length} published objects named in the output were verified`)
  for (const [i, t] of targets.entries()) {
    if (Date.now() > deadline) {
      notes.push(`${targets.length - i} published object(s) not verified (out of time budget) — check them yourself`)
      break
    }
    try {
      notes.push(...verifyTarget(t, { dry, repairVeto, rewriteAllowed, deadline }))
    } catch {
      // Defence in depth, not currently reachable: every failure inside
      // verifyTarget already resolves to a note or a silent skip. A future
      // edit that can throw must not kill the remaining targets' sweep.
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
