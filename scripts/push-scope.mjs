#!/usr/bin/env node
/**
 * Push-time scope print (wired as a PreToolUse(Bash) hook). It NEVER blocks:
 * exit 0 always, and its only output is additionalContext.
 *
 * On `git push` it prints what the branch changes against origin/master, as
 * this clone last fetched it:
 *
 *   git diff --shortstat   --no-ext-diff origin/master...HEAD
 *   git diff --name-status --no-ext-diff origin/master...HEAD   (deletions first)
 *
 * plus the ahead/behind commit counts. A squash onto a master that moved after
 * the fetch keeps the old tree over the new base, so it reverts whatever master
 * merged meanwhile, tests included, and the gate stays green because the tests
 * left with the code. In this listing that revert is a `D <test file>` line,
 * printed before anything leaves the machine, and a diff that grows across
 * review rounds is visible push by push. Facts only: no verdict, no advice.
 * It never fetches: a stale origin/master is part of what it reports.
 *
 * Separate from backup-before-restore.mjs on purpose: that hook answers
 * uncommitted work lost to a restore, this one answers committed history
 * rewritten against the wrong base. Different root causes, different triggers.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { effectiveCwd, gitInvocations } from './check-stash-worktree.mjs'

const BASE = 'origin/master'
const LISTED_FILES = 300
const CONTEXT_MAX = 9_000

export const pushInvocations = cmd => gitInvocations(cmd).filter(g => g.word === 'push')

const git = (cwd, cArgs, args) =>
  execFileSync('git', [...cArgs, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).trimEnd()

const firstLine = e => String(e?.stderr || e?.message || e).trim().split('\n')[0]

/** Scope facts for one repository, or null when cwd is not inside one. */
const scopeOf = (cwd, cArgs) => {
  try {
    git(cwd, cArgs, ['rev-parse', '--git-dir'])
  } catch {
    return null // not a repository: the push itself reports that
  }
  const range = `${BASE}...HEAD`
  let names, shortstat, counts
  try {
    names = git(cwd, cArgs, ['diff', '--name-status', '--no-ext-diff', '--no-renames', range])
    shortstat = git(cwd, cArgs, ['diff', '--shortstat', '--no-ext-diff', range]).trim()
    counts = git(cwd, cArgs, ['rev-list', '--left-right', '--count', range]).split(/\s+/)
  } catch (e) {
    return `push-scope: \`git diff ${range}\` failed: ${firstLine(e)}`
  }
  const branch = (() => {
    try {
      return git(cwd, cArgs, ['rev-parse', '--abbrev-ref', 'HEAD'])
    } catch {
      return 'HEAD'
    }
  })()
  const lines = names ? names.split('\n') : []
  const ordered = [...lines.filter(l => l.startsWith('D\t')), ...lines.filter(l => !l.startsWith('D\t'))]
  const out = [
    `push-scope: ${branch} against ${BASE} as last fetched here (merge-base diff, deletions first):`,
    `HEAD is ${counts[1]} ahead, ${counts[0]} behind ${BASE}`,
    shortstat || 'no file differences',
    ...ordered.slice(0, LISTED_FILES),
  ]
  if (ordered.length > LISTED_FILES) out.push(`…and ${ordered.length - LISTED_FILES} more`)
  return out.join('\n')
}

const main = () => {
  let payload
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return // not a hook payload
  }
  const cmd = payload?.tool_input?.command ?? ''
  if (!/\bpush\b/.test(cmd)) return
  const payloadCwd = payload.cwd || process.cwd()
  const notes = []
  const seen = new Set()
  for (const inv of pushInvocations(cmd)) {
    const { cwd, exact } = effectiveCwd(payloadCwd, inv.cdPath)
    const unresolved = exact ? inv.cArgs.find(a => a.includes('$')) : inv.cdPath
    if (unresolved) {
      notes.push(`push-scope: no scope for this push: its target \`${unresolved}\` is not a literal path.`)
      continue
    }
    const key = `${cwd}\0${inv.cArgs.join('\0')}`
    if (seen.has(key)) continue
    seen.add(key)
    const note = scopeOf(cwd, inv.cArgs)
    if (note) notes.push(note)
  }
  if (!notes.length) return
  const text = notes.join('\n\n')
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: text.length > CONTEXT_MAX ? text.slice(0, CONTEXT_MAX) : text,
      },
    }) + '\n',
  )
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) main()
