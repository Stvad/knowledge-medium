#!/usr/bin/env node
/**
 * PostToolUse(Bash) hook: verify what a publishing command ACTUALLY published
 * (issue #672). The PreToolUse gate inspects command STRINGS, which means
 * reconstructing shell semantics — an unbounded input space (quoting,
 * expansion, stdin, stale body files: each shipped a real bypass). Published
 * text exists exactly once, in the GitHub object after gh composes it; this
 * hook reads THAT back and acts on ground truth, with no shell parsing:
 *
 *   - bead ids (km-…) in a published body/title are rewritten to their issue
 *     numbers in place, minting the issue first when the bead has none —
 *     GitHub readers cannot resolve a bead id;
 *   - every #N in the published text is echoed back with its real
 *     title/state/kind as additionalContext, so a guessed number is visible
 *     in-context immediately after publishing. Close keywords only ACT at
 *     merge, so fixing a body after publication loses nothing — except on
 *     `gh pr merge`, whose text lands in the merge commit; the PreToolUse
 *     gate remains the only cover there.
 *
 * Coverage is exactly the objects the command's OUTPUT names: the URL gh
 * prints for CLI publishes, the top-level html_url of a `gh api` mutation's
 * response. A publish whose output names neither (gh pr review, gh api with
 * --template) is not verified here — the PreToolUse gate still scans its raw
 * command text.
 *
 * Blocking here would be pointless (the publish already happened), so this
 * hook never does: any internal failure exits 0 silently, and a repair that
 * fails is reported for hand-fixing, not retried.
 *
 * BD_GITHUB_SYNC_DRY=1 in the environment suppresses the writes (mint +
 * body PATCH) — the same pipe-test valve the sibling hooks use.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BEAD_ID,
  REPO,
  beadIssueLookup,
  extractBeadIds,
  extractIssueRefs,
  initializedDbRoot,
  issueRefsTable,
  matchesApiPublish,
  matchesPrCommand,
  preconditions,
  tryRun,
} from './bd-github-sync.mjs'

// ---------------------------------------------------------------------------
// Pure logic (unit-tested in bd-publish-verify.test.ts)
// ---------------------------------------------------------------------------

// Fragments before path groups: an #issuecomment URL also contains /pull/N,
// and the comment is the object this command touched, not its parent.
const TARGET_URL = () =>
  new RegExp(
    String.raw`https://github\.com/${REPO}/(?:pull/(\d+)|issues/(\d+)|releases/tag/([^\s"'\\<>)\]]+))(?:#issuecomment-(\d+)|#discussion_r(\d+))?`,
    'g',
  )

const classify = (pr, issue, tag, commentId, reviewCommentId) =>
  commentId
    ? { kind: 'comment', id: Number(commentId) }
    : reviewCommentId
      ? { kind: 'review-comment', id: Number(reviewCommentId) }
      : tag
        ? { kind: 'release', tag }
        : pr
          ? { kind: 'pr', number: Number(pr) }
          : { kind: 'issue', number: Number(issue) }

/**
 * The objects this command published, from its output. For CLI publishes the
 * whole output is scanned — gh prints the target's URL and never echoes
 * bodies. A `gh api` mutation's output IS the mutated object, and its body
 * can QUOTE foreign URLs (a comment quoting another PR), so there only the
 * top-level html_url names what the command touched — anything else would
 * make this hook fetch, echo, and potentially REWRITE an object the command
 * never edited. Unparseable api output yields no targets (fail-open).
 */
export const publishedTargets = (cmd, output) => {
  let scanText = output
  if (!matchesPrCommand(cmd)) {
    try {
      const url = JSON.parse(output)?.html_url
      scanText = typeof url === 'string' ? url : ''
    } catch {
      return []
    }
  }
  const seen = new Map()
  for (const m of scanText.matchAll(TARGET_URL())) {
    const t = classify(...m.slice(1))
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

const ghJson = args => {
  try {
    return JSON.parse(tryRun('gh', args) ?? 'null')
  } catch {
    return null
  }
}

const lookupWithMint = (ids, dry) => {
  // No bd call of any kind before the DB-exists gate (the first bd command in
  // a fresh clone creates an empty DB that then refuses to pull).
  const dbRoot = initializedDbRoot()
  if (!dbRoot) return new Map()
  let byId = beadIssueLookup(ids)
  const missing = ids.filter(id => !byId.get(id))
  if (missing.length && !dry) {
    const pre = preconditions(dbRoot)
    if (pre.ok) {
      // Mint issues for published beads that have none — selective push, seconds.
      tryRun('bd', ['github', 'sync', '--push-only', '--issues', missing.join(',')], { env: pre.env })
      byId = beadIssueLookup(ids)
    }
  }
  return byId
}

const patchTarget = (t, fetched, fields) => {
  // Releases PATCH by numeric id, not tag.
  const path = t.kind === 'release' ? `repos/${REPO}/releases/${fetched.id}` : apiPathFor(t)
  // stdio[0] must be pipe: run()'s 'ignore' default silently discards `input`.
  return (
    tryRun('gh', ['api', '-X', 'PATCH', path, '--input', '-'], {
      input: JSON.stringify(fields),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) !== null
  )
}

const verifyTarget = (t, dry) => {
  const notes = []
  const fetched = ghJson(['api', apiPathFor(t)])
  if (!fetched || typeof fetched !== 'object') return notes
  const label = typeof fetched.html_url === 'string' ? fetched.html_url : apiPathFor(t)
  const title = typeof fetched.title === 'string' ? fetched.title : ''
  const body = typeof fetched.body === 'string' ? fetched.body : ''
  let finalTitle = title
  let finalBody = body

  const ids = extractBeadIds(`${title}\n${body}`)
  if (ids.length) {
    const byId = lookupWithMint(ids, dry)
    const bodyPlan = planBeadIdRewrite(body, byId)
    const titlePlan = planBeadIdRewrite(title, byId)
    const rewrites = [...new Map([...titlePlan.rewrites, ...bodyPlan.rewrites].map(r => [r.id, r])).values()]
    const unmapped = [...new Set([...titlePlan.unmapped, ...bodyPlan.unmapped])]
    if (rewrites.length) {
      const subs = rewrites.map(r => `${r.id} → #${r.number}`).join(', ')
      if (dry) {
        notes.push(`[dry-run] would rewrite ${subs} in ${label}`)
      } else if (
        patchTarget(t, fetched, {
          body: bodyPlan.newText,
          // Comments and releases have no PATCHable title.
          ...(t.kind === 'pr' || t.kind === 'issue' ? { title: titlePlan.newText } : {}),
        })
      ) {
        notes.push(`rewrote ${subs} in ${label} — bead ids are opaque to GitHub readers`)
        finalTitle = titlePlan.newText
        finalBody = bodyPlan.newText
      } else {
        notes.push(`FAILED to rewrite ${subs} in ${label} — edit it by hand; bead ids are opaque to GitHub readers`)
      }
    }
    if (unmapped.length)
      notes.push(
        `${unmapped.join(', ')} in ${label} ${unmapped.length > 1 ? 'have' : 'has'} no GitHub issue` +
          `${dry ? ' (mint suppressed by BD_GITHUB_SYNC_DRY)' : ' and minting failed here'} — run pnpm bd:sync, then fix the published text`,
      )
  }

  const refs = extractIssueRefs(`${finalTitle}\n${finalBody}`)
  if (refs.length) notes.push(`${label}\n${issueRefsTable(`${finalTitle}\n${finalBody}`, refs, 'post')}`)
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
  // The Bash tool merges stderr into tool_response.stdout (measured 2026-08-20).
  const out = payload?.tool_response?.stdout ?? ''
  if (!cmd || !out) return
  if (!matchesPrCommand(cmd) && !matchesApiPublish(cmd)) return
  const all = publishedTargets(cmd, out)
  if (!all.length) return
  const targets = all.slice(0, MAX_TARGETS)
  const dry = process.env.BD_GITHUB_SYNC_DRY === '1'
  const notes = []
  if (all.length > targets.length)
    notes.push(`only the first ${MAX_TARGETS} of ${all.length} published objects named in the output were verified`)
  for (const t of targets) {
    try {
      notes.push(...verifyTarget(t, dry))
    } catch {
      // fail-open per target: a verification failure must not break the turn
    }
  }
  if (notes.length)
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: clipContext(
            `bd-publish-verify (ground truth read back from the GitHub API):\n${notes.join('\n')}`,
          ),
        },
      }),
    )
}

// Exact-path comparison — same reasoning as bd-github-sync.mjs.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  try {
    hookPostPublish()
  } catch {
    // never fail: the publish already happened; a broken verifier must not
    // surface as a hook error on every gh command
  }
  process.exit(0)
}
