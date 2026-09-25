#!/usr/bin/env node
/**
 * Push-time scope print (PreToolUse(Bash) hook). It never blocks and never
 * fetches: exit 0 always, and its only output is additionalContext.
 *
 * On `git push` it prints, for each pushed source (each refspec's <src>, or
 * HEAD when the push names none), the merge-base diff against origin/master as
 * this clone last fetched it: the files by status with deletions first, the
 * shortstat, and the ahead/behind commit counts. A push that names no single
 * source (every branch, tags only, deletions, a refspec that is not literal)
 * says so instead.
 *
 * A squash onto a master that moved after the fetch keeps the old tree over the
 * new base and reverts whatever master merged meanwhile, tests included, so the
 * gate stays green. Here that revert is a `D <test file>` line, printed before
 * anything leaves the machine. Facts only: no verdict, no advice.
 *
 * Kept apart from backup-before-restore.mjs: a different root cause (history
 * rewritten against the wrong base, not uncommitted work lost to a restore).
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { effectiveCwd, gitInvocations, unresolvedTarget } from './check-stash-worktree.mjs'
import { emitPreToolUseContext, firstLine, fitLines, git, readHookPayload } from './hook-context.mjs'

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
  // A quoted substitution leaves an empty word; a variable leaves its name.
  const unread = refspecs.find(r => r === '' || r.includes('$'))
  if (unread !== undefined) return { sources: [], declined: 'it names a refspec that is not literal' }
  // [+]<src>[:<dst>]; an empty src deletes <dst>
  const sources = refspecs.map(r => r.replace(/^\+/, '').split(':')[0]).filter(Boolean)
  return sources.length ? { sources, declined: null } : { sources: [], declined: 'it only deletes remote refs' }
}

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
  const hook = readHookPayload(/\bpush\b/)
  if (!hook) return
  const notes = []
  const seen = new Set() // one scope per repository and source, however often it is pushed
  for (const inv of pushInvocations(hook.cmd)) {
    const unresolved = unresolvedTarget(inv)
    if (unresolved) {
      notes.push(`push-scope: no scope for this push: its target \`${unresolved}\` is not a literal path.`)
      continue
    }
    const { cwd } = effectiveCwd(hook.cwd, inv.cdPath)
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
