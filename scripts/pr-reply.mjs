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
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { REPO, isMainModule } from './bd-github-sync.mjs'

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

const main = argv => {
  if (argv.length !== 3) return USAGE
  const [pr, commentId, file] = argv
  if (!/^\d+$/.test(pr)) return `pr is not a number: ${pr}\n${USAGE}`
  if (!/^\d+$/.test(commentId)) return `comment-id is not a number: ${commentId}\n${USAGE}`
  // pnpm runs a script from the package root and passes the caller's
  // directory as INIT_CWD, which is what a relative path was written against.
  const body = readBody(resolve(process.env.INIT_CWD || process.cwd(), file))
  if (body.error) return body.error
  const r = spawnSync('gh', ['api', `repos/${REPO}/pulls/${pr}/comments/${commentId}/replies`, '--method', 'POST', '--input', '-'], {
    input: JSON.stringify({ body: signedBody(body.text) }),
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (r.status !== 0) return (r.stderr || r.stdout || r.error?.message || `gh exited ${r.status}`).trimEnd()
  let url
  try {
    url = JSON.parse(r.stdout).html_url
  } catch {
    url = undefined
  }
  if (typeof url !== 'string') return `gh answered without a reply URL:\n${r.stdout.trimEnd()}`
  console.log(url)
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
