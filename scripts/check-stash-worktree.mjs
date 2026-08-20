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
 *  - a selector-consuming stash operation that follows a renumbering one in
 *    the same compound command — the selector was checked against entries
 *    that will have shifted by the time it runs
 *
 * Second, unrelated rule (same hook, different root cause — deliberately NOT
 * generalized into one "shared git state" guard): `git commit --amend` commits
 * whatever the INDEX holds, and multiple agents share one worktree directory's
 * index. An amend whose staged file set grows beyond the commit being amended
 * is nearly always absorbing another session's staged work — blocked in every
 * repo, single-worktree included. Opt-out: AMEND_OK=1.
 *
 * Reads the hook payload (JSON) on stdin; only an actual `git stash …` /
 * `git commit --amend` invocation (verb position, quote-aware) is inspected —
 * prose that mentions them is not. Exit 2 → block; exit 0 → allow. Opt-outs
 * (STASH_OK=1 / AMEND_OK=1) count as the whole command's prefix or the
 * invocation's own prefix — the string inside quoted prose elsewhere does not.
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
 * Walk a command string and yield each git invocation with its shell context:
 * word (the token after git's global flags), rest (tokens after it), cArgs
 * (repo-locating globals to replay on state queries), cdPath (last in-scope
 * plain `cd` target — one inside `(…)`/`$(…)` dies with that subshell), and
 * assigns (leading VAR= tokens, for per-invocation opt-outs).
 */
export const gitInvocations = cmd => {
  const out = []
  let cdPath = null
  const outerCd = [] // saved cdPath per enclosing subshell scope
  let depth = 0
  for (const { tokens, depth: d, heredoc } of shellSegmentsWithDepth(cmd)) {
    while (depth < d) {
      outerCd.push(cdPath)
      depth++
    }
    while (depth > d) {
      cdPath = outerCd.pop()
      depth--
    }
    if (heredoc) continue // heredoc body lines are data, not commands
    let i = 0
    const assigns = []
    // Skip VAR= assignments, wrapper commands, shell reserved words, and (past
    // position 0) wrapper flags, so `env -i git stash …` and `if git stash …`
    // are seen. A wrapper flag that takes an operand (`sudo -u alice git …`)
    // still hides git — accidents, not adversaries.
    while (
      i < tokens.length &&
      (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) ||
        WRAPPERS.has(tokens[i]) ||
        RESERVED.has(tokens[i]) ||
        (i > 0 && tokens[i].startsWith('-')))
    ) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) assigns.push(tokens[i])
      i++
    }
    if (tokens[i] === 'cd' && tokens[i + 1] !== undefined) {
      cdPath = tokens[i + 1] // same prefix skip as for git: `{ cd /x && …` counts
      continue
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
    if (tokens[i] === undefined) continue
    out.push({ word: tokens[i], rest: tokens.slice(i + 1), cArgs, cdPath, assigns })
  }
  return out
}

/**
 * `git stash …` invocations: sub is the stash subcommand (null for a bare or
 * flags-only `git stash`), optOut marks a STASH_OK=1 prefixing the invocation.
 */
export const stashInvocations = cmd =>
  gitInvocations(cmd).flatMap(g => {
    if (g.word !== 'stash') return []
    let sub = null
    let j = 0
    if (g.rest.length && !g.rest[0].startsWith('-')) {
      if (!SUBCOMMANDS.has(g.rest[0])) return [] // unknown word — git rejects it itself
      sub = g.rest[0]
      j = 1
    }
    return [
      {
        sub,
        args: g.rest.slice(j),
        cArgs: g.cArgs,
        cdPath: g.cdPath,
        optOut: g.assigns.includes('STASH_OK=1'),
      },
    ]
  })

// commit options that take a separate value token — their value must not be
// read as a pathspec (a `-m` message would otherwise disable the amend rule).
const COMMIT_VALUE_LONG = new Set([
  '--message', '--file', '--reuse-message', '--reedit-message', '--template',
  '--author', '--date', '--fixup', '--squash', '--trailer', '--pathspec-from-file',
  '--cleanup',
])
const COMMIT_VALUE_SHORT = 'mFCct'

/**
 * `git commit --amend` invocations: paths are explicit pathspecs (an amend
 * that names its files is deliberate scope), all marks -a/--all, optOut an
 * AMEND_OK=1 prefixing the invocation.
 */
export const amendInvocations = cmd =>
  gitInvocations(cmd).flatMap(g => {
    if (g.word !== 'commit' || !g.rest.includes('--amend')) return []
    let all = false
    let include = false // -i: pathspecs ADD to the index, they do not replace it
    const paths = []
    for (let i = 0; i < g.rest.length; i++) {
      const t = g.rest[i]
      if (t === '--') {
        paths.push(...g.rest.slice(i + 1))
        break
      }
      if (t === '--all') {
        all = true
        continue
      }
      if (t === '--include') {
        include = true
        continue
      }
      if (t.startsWith('--')) {
        if (!t.includes('=') && COMMIT_VALUE_LONG.has(t)) i++
        continue
      }
      if (t.startsWith('-') && t.length > 1) {
        for (let k = 1; k < t.length; k++) {
          if (t[k] === 'a') all = true
          if (t[k] === 'i') include = true
          if (COMMIT_VALUE_SHORT.includes(t[k])) {
            if (k === t.length - 1) i++ // value is the next token
            break // in-token remainder is the attached value
          }
        }
        continue
      }
      paths.push(t)
    }
    return [
      {
        all,
        include,
        paths,
        cArgs: g.cArgs,
        cdPath: g.cdPath,
        optOut: g.assigns.includes('AMEND_OK=1'),
      },
    ]
  })

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

// Subcommands that renumber the shared stack. `apply` reads an entry but
// leaves the numbering intact; list/show/create touch nothing.
const RENUMBERING = new Set(['push', 'save', 'pop', 'drop', 'clear', 'branch', 'store'])
export const renumbersStack = inv => inv.sub === null || RENUMBERING.has(inv.sub)

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

  const unreadable =
    `BLOCKED: could not read the shared stash list, so \`git stash ${sub}\` cannot be ` +
    `checked against it (${wt} share this stack). STASH_OK=1 skips this guard.`

  if (sub === 'pop' || sub === 'apply' || sub === 'drop' || sub === 'branch') {
    if (state.stashes === null) return unreadable
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
    if (state.stashes === null) return unreadable
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
      maxBuffer: 32 * 1024 * 1024,
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
  let stashes = null // null = could not read; decide() fails closed on it
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

/**
 * Path sets for the amend rule: prev = files in the commit being amended,
 * staged = what the amend would commit (the index; with -a, all tracked
 * changes). null → could not read (no repo / unborn HEAD) — git errors itself.
 */
const amendState = (cwd, cArgs, all) => {
  const run = args =>
    execFileSync('git', [...cArgs, '--no-pager', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  try {
    let prev
    try {
      // First-parent delta: `show` on a clean merge presents a combined diff
      // with no paths, which would flag every staged file as growth.
      prev = run(['diff', '--name-only', 'HEAD^', 'HEAD'])
    } catch {
      prev = run(['show', '--name-only', '--format=', 'HEAD']) // root commit
    }
    const staged = run(
      all ? ['diff', '--name-only', 'HEAD'] : ['diff', '--name-only', '--cached'],
    )
    return {
      prev: new Set(prev ? prev.split('\n') : []),
      staged: staged ? staged.split('\n') : [],
    }
  } catch {
    return null
  }
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
  const payloadCwd = payload?.cwd || process.cwd()

  // -- stash rules (shared refs/stash across worktrees) --
  const stashOk = /^\s*STASH_OK=1\s/.test(cmd) // whole-command opt-out prefix
  if (!stashOk && /\bstash\b/i.test(cmd)) {
    const all = stashInvocations(cmd)
    const cache = new Map()
    // A selector after a renumbering op was validated against entries that
    // will have shifted by the time it runs. An opted-out invocation skips its
    // own decision but still renumbers.
    let renumberSeen = false
    for (const inv of all) {
      const consumesSelector =
        inv.sub === 'pop' || inv.sub === 'apply' || inv.sub === 'drop' || inv.sub === 'branch'
      if (consumesSelector && renumberSeen && !inv.optOut) {
        const st = stateFor(inv, payloadCwd, cache)
        if (st && st.worktrees > 1) {
          process.stderr.write(
            `BLOCKED: this \`git stash ${inv.sub}\` follows a stash operation that renumbers ` +
              `the stack shared by ${st.worktrees} worktrees, so its selector was checked ` +
              `against entries that will have shifted by the time it runs. ` +
              `Run them as separate commands. STASH_OK=1 prefixed skips this guard.\n`,
          )
          process.exit(2)
        }
      }
      if (!inv.optOut) {
        const reason = decide(inv, stateFor(inv, payloadCwd, cache))
        if (reason) {
          process.stderr.write(reason + '\n')
          process.exit(2)
        }
      }
      if (renumbersStack(inv)) renumberSeen = true
    }
  }

  // -- amend rule (one worktree directory, many agents, one index) --
  if (!/^\s*AMEND_OK=1\s/.test(cmd) && /--amend/.test(cmd)) {
    for (const inv of amendInvocations(cmd)) {
      if (inv.optOut) continue
      // A pathspec without -i commits ONLY the named files — deliberate scope.
      // With -i/--include the index rides along, so the comparison still runs
      // (the named files themselves stay exempt below).
      if (inv.paths.length && !inv.include) continue
      const { cwd, exact } = effectiveCwd(payloadCwd, inv.cdPath)
      if (!exact) {
        process.stderr.write(
          `BLOCKED: the cd target before this --amend is not a literal path, so the guard ` +
            `cannot check which worktree's index the amend would commit. AMEND_OK=1 ` +
            `prefixed to the command skips this check.\n`,
        )
        process.exit(2)
      }
      const st = amendState(cwd, inv.cArgs, inv.all)
      if (!st) continue
      const grown = st.staged.filter(p => !st.prev.has(p) && !inv.paths.includes(p))
      if (grown.length) {
        const shown = grown.slice(0, 10).join('\n  ')
        const more = grown.length > 10 ? `\n  …and ${grown.length - 10} more` : ''
        process.stderr.write(
          `BLOCKED: this --amend would add files the commit being amended does not touch:\n` +
            `  ${shown}${more}\n` +
            `The index is shared by every agent working in this directory, and --amend ` +
            `commits whatever is staged, not what you changed. AMEND_OK=1 prefixed to the ` +
            `command skips this check.\n`,
        )
        process.exit(2)
      }
    }
  }

  allow()
}

// Exact-path comparison: a suffix match could run the hook at import time from
// a future sibling whose name this file's happens to end with.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) main()
