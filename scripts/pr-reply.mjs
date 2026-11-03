#!/usr/bin/env node
/**
 * Reply on a PR review thread with a body taken verbatim from a file, signed
 * the way the desktop app's Autofix asks replies to be:
 *
 *   pnpm pr:reply <pr> <comment-id> <body-file> [--resolve]
 *
 * It exists so that reply is ONE command the publish gate
 * (bd-github-sync.mjs --hook-pre-pr) recognizes as covered: no shell
 * function, no variable holding the signature, no expansion. It prints the
 * reply's URL, which is what bd-publish-verify.mjs reads the published text
 * back from. The body is a file on disk and nothing else — stdin would need
 * a pipe or a heredoc, and either takes the command out of the covered shape.
 * With --resolve it then resolves the review thread the comment belongs to.
 *
 * Its gh call runs in this process, where no hook sees it, so a spelling of
 * the invocation the hooks fail to recognize would be checked by nobody. The
 * script therefore checks its own text, whatever the spelling: bead ids are
 * refused before anything is posted, with the same KM_ALLOW_BEAD_IDS=1 escape
 * the gate honors, and every #N in the posted reply is echoed with its real
 * title, read from GitHub's answer, as the read-back would.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { REPO, beadIdDenial, extractBeadIds, extractIssueRefs, issueRefsTable, moreRefsNote, refsCap } from './bd-github-sync.mjs'
import { isMainModule } from './is-main-module.mjs'

export const SIGNATURE = '_🤖 Addressed by [Claude Code](https://claude.com/claude-code)_'

export const signedBody = text => {
  const body = text.trimEnd()
  return body.endsWith(SIGNATURE) ? body : `${body}\n\n${SIGNATURE}`
}

const USAGE = 'usage: pnpm pr:reply <pr> <comment-id> <body-file> [--resolve]'

// The time the reference echo may take after the post; with --resolve's own
// budget ahead of it, still inside the Bash tool's timeout. refsCap turns it
// into how many lookups fit.
const ECHO_BUDGET_MS = (() => {
  const v = Number(process.env.KM_PR_REPLY_ECHO_BUDGET_MS)
  return Number.isFinite(v) && v >= 0 ? v : 60_000
})()

const readBody = file => {
  let stat
  try {
    stat = statSync(file)
  } catch {
    return { error: `${file}: does not exist` }
  }
  if (!stat.isFile()) return { error: `${file}: is not a regular file` }
  const text = readFileSync(file, 'utf8')
  return text.trim() ? { text } : { error: `${file}: is empty` }
}

// The whole --resolve step, every page and the mutation together; the reply is
// already posted by then, so a hung or long-paging call must not stop the echo
// that follows.
const RESOLVE_BUDGET_MS = (() => {
  const v = Number(process.env.KM_PR_REPLY_RESOLVE_BUDGET_MS)
  return Number.isFinite(v) && v >= 0 ? v : 30_000
})()

const THREADS_QUERY =
  'query($owner:String!,$name:String!,$pr:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$pr){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id isResolved comments(first:1){nodes{fullDatabaseId}}}}}}}'
const RESOLVE_MUTATION = 'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}'

// Every value travels as a gh variable (-f string, -F typed), never as text of
// the document. Throws on a gh failure, an answer that is not JSON, or a
// deadline already past.
const graphql = (deadline, query, ...variables) => {
  const timeout = deadline - Date.now()
  if (timeout <= 0) throw new Error(`out of time (${RESOLVE_BUDGET_MS / 1000}s)`)
  const r = spawnSync('gh', ['api', 'graphql', '-f', `query=${query}`, ...variables], { encoding: 'utf8', timeout })
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || r.error?.message || `gh exited ${r.status}`)
  return JSON.parse(r.stdout)
}

// The thread whose top-level comment is rootId, paging until found or out of pages.
const findThread = (pr, rootId, deadline) => {
  const [owner, name] = REPO.split('/')
  let after = null
  do {
    const page = graphql(
      deadline,
      THREADS_QUERY,
      '-f', `owner=${owner}`,
      '-f', `name=${name}`,
      '-F', `pr=${pr}`,
      ...(after ? ['-f', `after=${after}`] : []),
    )?.data?.repository?.pullRequest?.reviewThreads
    if (!Array.isArray(page?.nodes)) throw new Error('unexpected answer to the thread query')
    // fullDatabaseId is a BigInt, sent as a decimal string: a review comment's
    // id outgrew databaseId's 32 bits
    const thread = page.nodes.find(t => String(t.comments?.nodes?.[0]?.fullDatabaseId) === String(rootId))
    if (thread) return thread
    after = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null
  } while (after)
  return null
}

// Resolves the review thread rooted at comment rootId. Returns the line for
// stdout or the error for stderr, never throws: it runs after the post, so it
// must not decide the exit code.
const resolveThread = (pr, rootId) => {
  try {
    const deadline = Date.now() + RESOLVE_BUDGET_MS
    const thread = findThread(pr, rootId, deadline)
    if (!thread) throw new Error(`no review thread starts with comment ${rootId}`)
    if (thread.isResolved) return { message: `review thread ${thread.id} was already resolved` }
    const resolved = graphql(deadline, RESOLVE_MUTATION, '-f', `id=${thread.id}`)?.data?.resolveReviewThread?.thread
    if (resolved?.isResolved !== true) throw new Error(`GitHub left review thread ${thread.id} unresolved`)
    return { message: `resolved review thread ${thread.id}` }
  } catch (err) {
    return { error: `--resolve: could not resolve the review thread: ${String(err.message).replace(/\s+/g, ' ').trim()}` }
  }
}

// pnpm runs a package script from the package root and passes the caller's
// directory as INIT_CWD. Only then is INIT_CWD this invocation's: run any
// other way, an inherited one belongs to some enclosing pnpm run.
const callerDir = () =>
  process.env.npm_lifecycle_event === 'pr:reply' && process.env.INIT_CWD ? process.env.INIT_CWD : process.cwd()

// Returns the error to print, or null once gh has answered success. After a
// success nothing here reports failure: the post has happened, and a failed
// exit would tell the read-back that nothing was published.
const main = argv => {
  const resolveRequested = argv.includes('--resolve')
  const positionals = argv.filter(arg => arg !== '--resolve')
  if (positionals.length !== 3 || positionals.some(arg => arg.startsWith('--'))) return USAGE
  const [pr, commentId, file] = positionals
  if (!/^\d+$/.test(pr)) return `pr is not a number: ${pr}\n${USAGE}`
  if (!/^\d+$/.test(commentId)) return `comment-id is not a number: ${commentId}\n${USAGE}`
  const body = readBody(resolve(callerDir(), file))
  if (body.error) return body.error
  const ids = process.env.KM_ALLOW_BEAD_IDS === '1' ? [] : extractBeadIds(body.text)
  if (ids.length) return beadIdDenial(ids)
  const r = spawnSync('gh', ['api', `repos/${REPO}/pulls/${pr}/comments/${commentId}/replies`, '--method', 'POST', '--input', '-'], {
    input: JSON.stringify({ body: signedBody(body.text) }),
    encoding: 'utf8',
  })
  if (r.status !== 0) return (r.stderr || r.stdout || r.error?.message || `gh exited ${r.status}`).trimEnd()
  let reply
  try {
    reply = JSON.parse(r.stdout)
  } catch {
    reply = null
  }
  // gh's own answer when it names no reply URL: printed as is, so the
  // read-back's report of an unnamed object is what follows.
  console.log(typeof reply?.html_url === 'string' ? reply.html_url : r.stdout.trimEnd())
  if (resolveRequested) {
    // in_reply_to_id is the thread's top-level comment, which commentId may not be
    const outcome = resolveThread(pr, typeof reply?.in_reply_to_id === 'number' ? reply.in_reply_to_id : Number(commentId))
    if (outcome.error) console.error(outcome.error)
    else console.log(outcome.message)
  }
  const published = typeof reply?.body === 'string' ? reply.body : signedBody(body.text)
  const refs = extractIssueRefs(published)
  if (!refs.length) return null
  const cap = refsCap(ECHO_BUDGET_MS)
  console.log(
    cap > 0
      ? `\n${issueRefsTable(published, refs.slice(0, cap), 'post')}${moreRefsNote(refs.length, cap)}`
      : `\n${refs.length} issue references in the reply not echoed (out of time budget) — check them yourself`,
  )
  return null
}

if (isMainModule(import.meta.url)) {
  const error = main(process.argv.slice(2))
  if (error) {
    console.error(error)
    // exitCode, not exit(): nothing holds the loop open, and exit() can drop
    // a queued write to a piped stream.
    process.exitCode = 1
  }
}
