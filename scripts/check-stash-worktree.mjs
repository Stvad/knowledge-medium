#!/usr/bin/env node
/**
 * Cross-worktree stash guard (wired as a Claude Code PreToolUse(Bash) hook).
 *
 * `refs/stash` lives in the SHARED common dir — git makes only HEAD,
 * `refs/bisect/*`, `refs/worktree/*` and `refs/rewritten/*` per-worktree — so
 * every worktree of this repo pushes and pops ONE global stash stack. With
 * ~50 worktrees, `stash@{0}` means "whatever any session stashed last", and a
 * pop applies a diff computed against another worktree's base branch, often
 * cleanly enough that nothing looks wrong.
 *
 * When the repo has more than one worktree, this blocks:
 *  - pop/apply/drop/branch naming no explicit `stash@{N}`
 *  - pop/apply/drop of an entry whose recorded base branch is not the current
 *    worktree's branch (the shape of the real incidents)
 *  - push (bare `git stash`, `push`, `save`) with no message
 *  - `git stash clear` while the shared stack has entries
 *  - two stack-touching stash operations in one compound command — each is
 *    checked against the stack as it is NOW, and the first renumbers the
 *    entries the later ones name
 *
 * Reads the hook payload (JSON) on stdin; only an actual `git stash …`
 * invocation (verb position, quote-aware) is inspected — prose that mentions
 * stash is not. Exit 2 → block; exit 0 → allow. Opt-out: STASH_OK=1 as the
 * whole command's prefix or the stash invocation's own prefix — the string
 * inside quoted prose elsewhere does not count.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shellSegmentsWithDepth } from './shell-segments.mjs'

const WRAPPERS = new Set(['sudo', 'command', 'time', 'env', 'nice', 'nohup', 'xargs'])
// Shell reserved words that can precede a simple command in the same segment.
const RESERVED = new Set(['{', '}', '!', 'if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'do', 'done'])
const SUBCOMMANDS = new Set([
  'push', 'save', 'pop', 'apply', 'drop', 'clear', 'list', 'show', 'branch', 'create', 'store',
])

/**
 * Find actual `git stash …` invocations in a command string.
 * Returns {sub, args, cArgs, cdPath, optOut}: sub is the stash subcommand
 * (null for a bare/flags-only `git stash`), cArgs are repo-locating git
 * globals (-C, --git-dir, --work-tree) to replay on state queries, cdPath is
 * the target of the last plain `cd` still in scope (a cd inside `(…)` or
 * `$(…)` dies with that subshell), optOut marks a STASH_OK=1 assignment
 * prefixing this invocation itself.
 */
export const stashInvocations = cmd => {
  const out = []
  let cdPath = null
  const outerCd = [] // saved cdPath per enclosing subshell scope
  let depth = 0
  for (const { tokens, depth: d } of shellSegmentsWithDepth(cmd)) {
    while (depth < d) {
      outerCd.push(cdPath)
      depth++
    }
    while (depth > d) {
      cdPath = outerCd.pop()
      depth--
    }
    if (tokens[0] === 'cd' && tokens.length > 1) {
      cdPath = tokens[1]
      continue
    }
    let i = 0
    let optOut = false
    // Skip VAR= assignments, wrapper commands, and (past position 0) wrapper
    // flags, so `env -i git stash …` is still seen. A wrapper flag that takes
    // an operand (`sudo -u alice git …`) still hides git — accidents, not
    // adversaries.
    while (
      i < tokens.length &&
      (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) ||
        WRAPPERS.has(tokens[i]) ||
        RESERVED.has(tokens[i]) ||
        (i > 0 && tokens[i].startsWith('-')))
    ) {
      if (tokens[i] === 'STASH_OK=1') optOut = true
      i++
    }
    if ((tokens[i] || '').replace(/.*\//, '') !== 'git') continue
    i++
    const cArgs = []
    while (i < tokens.length && tokens[i].startsWith('-')) {
      const t = tokens[i]
      if ((t === '-C' || t === '--git-dir' || t === '--work-tree') && tokens[i + 1] !== undefined) {
        cArgs.push(t, tokens[i + 1])
        i += 2
      } else if (t.startsWith('--git-dir=') || t.startsWith('--work-tree=')) {
        cArgs.push(t)
        i++
      } else if (t === '-c' && tokens[i + 1] !== undefined) {
        i += 2 // config override — irrelevant to repo location
      } else {
        i++ // other global flag (--no-pager, -P, …)
      }
    }
    if (tokens[i] !== 'stash') continue
    i++
    let sub = null
    if (i < tokens.length && !tokens[i].startsWith('-') && SUBCOMMANDS.has(tokens[i])) {
      sub = tokens[i]
      i++
    } else if (i < tokens.length && !tokens[i].startsWith('-')) {
      continue // unknown word after `stash` — git itself rejects it
    }
    out.push({ sub, args: tokens.slice(i), cArgs, cdPath, optOut })
  }
  return out
}

/** First argument that names a stash entry: `stash@{…}` or a bare index. */
export const explicitEntry = args => {
  for (const a of args) {
    if (a.startsWith('-')) continue
    if (/^stash@\{.+\}$/.test(a) || /^\d+$/.test(a)) return a
  }
  return null
}

/** Does this push-shaped invocation carry a message? (`save` takes it positionally.) */
export const hasMessage = (sub, args) => {
  if (sub === 'save') return args.some(a => !a.startsWith('-'))
  const cut = args.indexOf('--') // past --, tokens are pathspecs, not options
  const opts = cut === -1 ? args : args.slice(0, cut)
  return opts.some(
    a =>
      a === '-m' ||
      a === '--message' ||
      a.startsWith('--message=') ||
      /^-[a-zA-Z]*m$/.test(a) || // clustered short flags ending in m (-um)
      /^-m./.test(a), // attached form (-mWIP)
  )
}

// Everything but a pure read either renumbers the shared stack (push/save/
// pop/drop/clear/branch/store) or consumes an entry from it (apply).
const READ_ONLY = new Set(['list', 'show', 'create'])
export const mutatesStack = inv => inv.sub === null || !READ_ONLY.has(inv.sub)

/** Base branch recorded in a stash entry's subject ("WIP on X: …" / "On X: …"). */
export const baseBranch = subject => {
  const m = subject.match(/^(?:WIP on|On) ([^:]+): /)
  return m ? m[1] : null
}

/**
 * Pure decision: null → allow, string → block with that message.
 * state: {worktrees, branch, stashes: [{ref, subject}]}; branch === null means
 * the target worktree's branch could not be determined statically.
 */
export const decide = (inv, state) => {
  if (!state || state.worktrees <= 1) return null
  const { sub, args } = inv
  const wt = `${state.worktrees} worktrees`

  if (sub === 'pop' || sub === 'apply' || sub === 'drop' || sub === 'branch') {
    if (state.stashes.length === 0) return null // git errors on its own
    // `branch` takes <branchname> first and only then an optional selector —
    // a numeric branch name must not read as stash@{N} (git uses stash@{0}).
    let selArgs = args
    if (sub === 'branch') {
      const name = args.findIndex(a => !a.startsWith('-'))
      selArgs = name === -1 ? [] : args.slice(name + 1)
    }
    const raw = explicitEntry(selArgs)
    if (!raw) {
      return (
        `BLOCKED: \`git stash ${sub}\` names no entry. refs/stash is ONE stack shared by all ` +
        `${wt} of this repo, so stash@{0} is whichever session stashed most recently — its ` +
        `diff may be against a different branch entirely. \`git stash list\` shows each ` +
        `entry's base branch and message; name one as stash@{N}. ` +
        `STASH_OK=1 prefixed to the command skips this guard.`
      )
    }
    const ref = /^\d+$/.test(raw) ? `stash@{${raw}}` : raw
    const entry = state.stashes.find(s => s.ref === ref)
    if (!entry) {
      if (/^stash@\{\d+\}$/.test(ref)) return null // out of range — git reports it
      return (
        `BLOCKED: cannot resolve \`${raw}\` against the stash list to check which branch it ` +
        `came from (${wt} share this stack). Name the entry as stash@{N}. ` +
        `STASH_OK=1 skips this guard.`
      )
    }
    if (sub !== 'branch') {
      // `stash branch` checks out the entry's own base commit, so cross-branch
      // application cannot happen there; the explicit-entry rule above is enough.
      const base = baseBranch(entry.subject)
      if (state.branch === null) {
        return (
          `BLOCKED: the cd/-C target is not a literal path, so the guard cannot tell which ` +
          `branch that worktree is on to check ${ref} (stashed on '${base ?? 'unknown'}') ` +
          `against it — ${wt} share this stash stack. STASH_OK=1 skips this guard.`
        )
      }
      if (!base) {
        return (
          `BLOCKED: ${ref} ("${entry.subject.slice(0, 80)}") does not record its base branch, ` +
          `so the guard cannot tell whether it belongs to this worktree's branch ` +
          `('${state.branch}') — ${wt} share this stack. STASH_OK=1 skips this guard.`
        )
      }
      if (base !== state.branch) {
        const harm =
          sub === 'drop'
            ? `dropping it would delete another session's work`
            : `applying it lands a diff computed against a different base branch`
        return (
          `BLOCKED: ${ref} was stashed on '${base}' but this worktree is on ` +
          `'${state.branch}' — with ${wt} sharing one stash stack, ${harm}. ` +
          `STASH_OK=1 skips this guard if the entry is genuinely yours.`
        )
      }
    }
    return null
  }

  if (sub === 'clear') {
    if (state.stashes.length === 0) return null
    return (
      `BLOCKED: \`git stash clear\` deletes all ${state.stashes.length} entries on the stack ` +
      `shared by ${wt} — including entries created by other sessions. ` +
      `STASH_OK=1 skips this guard.`
    )
  }

  if (sub === null || sub === 'push' || sub === 'save') {
    if (hasMessage(sub, args)) return null
    return (
      `BLOCKED: unlabeled stash. This pushes onto the ONE stack shared by ${wt}, burying ` +
      `other sessions' stash@{0}, and the new entry is later findable only by index. ` +
      `Label it (-m), or use a throwaway wip commit — commits are per-worktree. ` +
      `STASH_OK=1 skips this guard.`
    )
  }

  return null // list/show/create/store are read-only or plumbing
}

// ---------------------------------------------------------------------------

const allow = () => process.exit(0)

const gitState = (cwd, cArgs) => {
  const run = args =>
    execFileSync('git', [...cArgs, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  let worktrees
  try {
    worktrees = run(['worktree', 'list', '--porcelain'])
      .split('\n')
      .filter(l => l.startsWith('worktree ')).length
  } catch {
    return null // not a git repo (or bad -C target) — git will error on its own
  }
  let branch = null
  try {
    branch = run(['rev-parse', '--abbrev-ref', 'HEAD'])
  } catch {
    /* unborn HEAD etc. — leave null */
  }
  let stashes = []
  try {
    // %s (the stash COMMIT's subject) not %gs: the reflog message can be
    // overridden by `git stash store -m …` (re-stashed entries), while the
    // commit subject keeps the "WIP on <branch>: …" the stash machinery wrote.
    const out = run(['stash', 'list', '--format=%gd%x09%s'])
    stashes = out
      ? out.split('\n').map(l => {
          const [ref, ...rest] = l.split('\t')
          return { ref, subject: rest.join('\t') }
        })
      : []
  } catch {
    /* leave empty */
  }
  return { worktrees, branch, stashes }
}

const effectiveCwd = (payloadCwd, cdPath) => {
  if (!cdPath) return { cwd: payloadCwd, exact: true }
  if (cdPath.includes('$')) return { cwd: payloadCwd, exact: false } // unexpanded variable
  const p =
    cdPath === '~' ? homedir() : cdPath.startsWith('~/') ? resolve(homedir(), cdPath.slice(2)) : cdPath
  return { cwd: resolve(payloadCwd, p), exact: true }
}

const stateFor = (inv, payloadCwd, cache) => {
  const key = `${inv.cdPath ?? ''} ${inv.cArgs.join(' ')}`
  if (cache.has(key)) return cache.get(key)
  const { cwd, exact } = effectiveCwd(payloadCwd, inv.cdPath)
  let state = gitState(cwd, inv.cArgs)
  if (state && !exact) state = { ...state, branch: null }
  if (!state && (inv.cdPath || inv.cArgs.length)) {
    // The cd/-C target didn't resolve, but the stash stack is shared repo-wide:
    // judge from the session cwd with the target branch unknown.
    state = gitState(payloadCwd, [])
    if (state) state = { ...state, branch: null }
  }
  cache.set(key, state)
  return state
}

const main = () => {
  let payload = {}
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    allow() // not a parseable hook payload — don't get in the way
  }
  const cmd = payload?.tool_input?.command ?? ''
  if (!cmd) allow()
  if (/^\s*STASH_OK=1\s/.test(cmd)) allow() // whole-command opt-out prefix
  if (!/\bstash\b/i.test(cmd)) allow() // cheap prefilter before tokenizing

  const all = stashInvocations(cmd)
  // An opted-out invocation skips its own decision but still renumbers the
  // stack, so it stays in the compound-mutation count.
  const invocations = all.filter(inv => !inv.optOut)
  if (invocations.length === 0) allow()

  const payloadCwd = payload?.cwd || process.cwd()
  const cache = new Map()

  const mutating = all.filter(mutatesStack)
  if (mutating.length > 1 && invocations.some(mutatesStack)) {
    const st = stateFor(mutating[0], payloadCwd, cache)
    if (st && st.worktrees > 1) {
      process.stderr.write(
        `BLOCKED: ${mutating.length} stash operations in one command. The guard checks ` +
          `each against the stack as it is NOW, but every push/pop/drop renumbers the ` +
          `entries the later ones name — and ${st.worktrees} worktrees share this stack. ` +
          `Run them as separate commands. STASH_OK=1 prefixed skips this guard.\n`,
      )
      process.exit(2)
    }
  }

  for (const inv of invocations) {
    const reason = decide(inv, stateFor(inv, payloadCwd, cache))
    if (reason) {
      process.stderr.write(reason + '\n')
      process.exit(2)
    }
  }
  allow()
}

// Exact-path comparison: a suffix match could run the hook at import time from
// a future sibling whose name this file's happens to end with.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) main()
