#!/usr/bin/env node
/**
 * Reply on a PR review thread with a body taken verbatim from a file, signed
 * the way the desktop app's Autofix asks replies to be:
 *
 *   pnpm pr:reply <pr> <comment-id> <body-file>
 *
 * It exists so that reply is ONE command the publish gate
 * (bd-github-sync.mjs --hook-pre-pr) recognizes as covered: no shell
 * function, no variable holding the signature, no expansion. It prints the
 * reply's URL, which is what bd-publish-verify.mjs reads the published text
 * back from. The body is a file on disk and nothing else — stdin would need
 * a pipe or a heredoc, and either takes the command out of the covered shape.
 *
 * Its gh call runs in this process, where no hook sees it, so a spelling of
 * the invocation the hooks fail to recognize is checked by nobody. Bead ids
 * are therefore refused here, before anything is posted, with the same
 * KM_ALLOW_BEAD_IDS=1 escape the gate honors.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { REPO, beadIdDenial, extractBeadIds, isMainModule } from './bd-github-sync.mjs'

export const SIGNATURE = '_🤖 Addressed by [Claude Code](https://claude.com/claude-code)_'

export const signedBody = text => {
  const body = text.trimEnd()
  return body.endsWith(SIGNATURE) ? body : `${body}\n\n${SIGNATURE}`
}

const USAGE = 'usage: pnpm pr:reply <pr> <comment-id> <body-file>'

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

// pnpm runs a package script from the package root and passes the caller's
// directory as INIT_CWD. Only then is INIT_CWD this invocation's: run any
// other way, an inherited one belongs to some enclosing pnpm run.
const callerDir = () =>
  process.env.npm_lifecycle_event === 'pr:reply' && process.env.INIT_CWD ? process.env.INIT_CWD : process.cwd()

// Returns the error to print, or null once gh has answered success. After a
// success nothing here reports failure: the post has happened, and a failed
// exit would tell the read-back that nothing was published.
const main = argv => {
  if (argv.length !== 3) return USAGE
  const [pr, commentId, file] = argv
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
  let url
  try {
    url = JSON.parse(r.stdout).html_url
  } catch {
    url = undefined
  }
  // gh's own answer when it names no reply URL: printed as is, so the
  // read-back's report of an unnamed object is what follows.
  console.log(typeof url === 'string' ? url : r.stdout.trimEnd())
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
