#!/usr/bin/env node
/**
 * Push-time scope print (wired as a PreToolUse(Bash) hook). It NEVER blocks:
 * exit 0 always, and its only output is additionalContext.
 *
 * On `git push` it prints what each pushed source changes against
 * origin/master, as this clone last fetched it:
 *
 *   git diff --shortstat   --no-ext-diff origin/master...<source>
 *   git diff --name-status --no-ext-diff origin/master...<source>   (deletions first)
 *
 * plus the ahead/behind commit counts. The source is each refspec's <src>, or
 * HEAD when the push names none; a push of every branch, of tags only, or of
 * deletions names no single source and says so instead. A squash onto a master that moved after
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
import { emitPreToolUseContext, fitLines } from './hook-context.mjs'

const BASE = 'origin/master'

export const pushInvocations = cmd => gitInvocations(cmd).filter(g => g.word === 'push')

// git push options that take their value as the next token.
const PUSH_VALUE_OPTS = new Set(['--repo', '--receive-pack', '--exec', '--push-option', '-o'])
const PUSH_EVERYTHING = new Map([
  ['--all', 'every branch'],
  ['--branches', 'every branch'],
  ['--mirror', 'every ref'],
])

/**
 * What a push sends, from its arguments: the source revs whose scope to print,
 * or why it names no single source. No refspec means the current branch.
 */
export const pushSources = rest => {
  const positional = []
  let tags = false
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]
    if (t.startsWith('-')) {
      const name = t.split('=')[0]
      if (PUSH_EVERYTHING.has(name)) return { sources: [], declined: `it pushes ${PUSH_EVERYTHING.get(name)} (${name})` }
      if (name === '--delete' || name === '-d') return { sources: [], declined: 'it deletes remote refs (--delete)' }
      if (name === '--tags') tags = true
      if (PUSH_VALUE_OPTS.has(name) && !t.includes('=')) i++
      continue
    }
    positional.push(t)
  }
  const refspecs = positional.slice(1) // the first positional is the repository
  if (!refspecs.length) {
    return tags ? { sources: [], declined: 'it pushes tags only (--tags)' } : { sources: ['HEAD'], declined: null }
  }
  // [+]<src>[:<dst>]; an empty src deletes <dst>
  const sources = [...new Set(refspecs.map(r => r.replace(/^\+/, '').split(':')[0]).filter(Boolean))]
  return sources.length ? { sources, declined: null } : { sources: [], declined: 'it only deletes remote refs' }
}

const git = (cwd, cArgs, args) =>
  execFileSync('git', [...cArgs, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).trimEnd()

const firstLine = e => String(e?.stderr || e?.message || e).trim().split('\n')[0]

/** Scope facts for one pushed source, or null when cwd is not inside a repository. */
const scopeOf = (cwd, cArgs, src) => {
  try {
    git(cwd, cArgs, ['rev-parse', '--git-dir'])
  } catch {
    return null // not a repository: the push itself reports that
  }
  const range = `${BASE}...${src}`
  let names, shortstat, counts, label
  try {
    names = git(cwd, cArgs, ['diff', '--name-status', '--no-ext-diff', '--no-renames', range])
    shortstat = git(cwd, cArgs, ['diff', '--shortstat', '--no-ext-diff', range]).trim()
    counts = git(cwd, cArgs, ['rev-list', '--left-right', '--count', range]).split(/\s+/)
    label = src === 'HEAD' ? git(cwd, cArgs, ['rev-parse', '--abbrev-ref', 'HEAD']) : src
  } catch (e) {
    return `push-scope: \`git diff ${range}\` failed: ${firstLine(e)}`
  }
  const lines = names ? names.split('\n') : []
  const deletions = lines.filter(l => l.startsWith('D\t'))
  return fitLines(
    [
      `push-scope: ${label} against ${BASE} as last fetched here (merge-base diff, deletions first):`,
      `${src} is ${counts[1]} ahead, ${counts[0]} behind ${BASE}`,
      shortstat || 'no file differences',
    ],
    [...deletions, ...lines.filter(l => !l.startsWith('D\t'))],
    n => `…and ${n} more`,
  ).join('\n')
}

const main = () => {
  let payload
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return // not a hook payload
  }
  const cmd = payload?.tool_input?.command ?? ''
  if (!/\bpush\b/.test(cmd)) return // fast path only: pushInvocations decides
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
    const { sources, declined } = pushSources(inv.rest)
    if (declined) notes.push(`push-scope: no scope for this push: ${declined}.`)
    for (const src of sources) {
      const key = `${cwd}\0${inv.cArgs.join('\0')}\0${src}`
      if (seen.has(key)) continue
      seen.add(key)
      const note = scopeOf(cwd, inv.cArgs, src)
      if (note) notes.push(note)
    }
  }
  emitPreToolUseContext(notes)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) main()
