#!/usr/bin/env node
/**
 * Backup before checkout/restore (PreToolUse(Bash) hook). It never blocks:
 * exit 0 always, and its only output is additionalContext.
 *
 * `git checkout [<rev>] -- <paths>` and `git restore <paths>` overwrite the
 * working tree from the index or a commit, not from the tree as it stood before
 * the edit being undone, so every uncommitted edit in a named file goes with it,
 * silently. Before such a command runs, every named path that differs from HEAD
 * (the empty tree before the first commit) is copied to
 *
 *   <git rev-parse --absolute-git-dir>/restore-backups/<session>/<timestamp>/<repo path>
 *
 * with <timestamp>.manifest.txt beside that directory, never inside it where a
 * repository path could land on it. The context reports the count, the
 * directory and each file's added/deleted lines: facts only, no cause, no
 * remedy. <session> is the first 8 characters of the payload's session_id, so
 * backup paths hold no uuid-shaped string. The per-worktree git dir keeps
 * backups out of the tree and out of other worktrees; they outlive the session,
 * go with `git worktree remove`, and nothing prunes them.
 *
 * Paths the hook cannot read statically widen the copy to every file that
 * differs from HEAD (unreadablePathspecs says when). A command that reads from a
 * named commit also has the untracked files that commit tracks copied, since it
 * overwrites them.
 *
 * Not covered, and accepted: a restore inside a script file, `bash -c`, a
 * heredoc or after `pushd`; untracked files under `checkout <rev> <path>`
 * without `--`; staged content that differs from the working tree when the
 * command also rewrites the index (it survives as an unreachable blob until
 * gc); edits `git diff` does not report, under assume-unchanged or
 * skip-worktree bits or inside submodules (this repository uses neither); and
 * other commands that discard work: reset --hard, switch -f or
 * --discard-changes, checkout-index -f, clean.
 */

import { copyFileSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { effectiveCwd, gitInvocations, unresolvedTarget } from './check-stash-worktree.mjs'
import { emitPreToolUseContext, firstLine, fitLines, git, readHookPayload } from './hook-context.mjs'

const WHOLE_TREE = ':/'

// Long checkout options that make it a branch operation rather than a restore.
const CHECKOUT_BRANCH_OPS = new Set(['--orphan', '--detach', '--track'])
const CHECKOUT_VALUE_OPTS = new Set(['--orphan', '--conflict', '--pathspec-from-file'])

/**
 * null → not a path restore. Else the pathspecs, and source: the commit the
 * files come from when the command names one (null: the index, or unknown).
 */
const parseCheckout = rest => {
  const operands = []
  let force = false
  let branchOp = false
  let fromFile = false
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]
    if (t === '--') return { pathspecs: rest.slice(i + 1), source: operands[0] ?? null, fromFile }
    if (t.startsWith('--')) {
      const name = t.split('=')[0]
      if (CHECKOUT_BRANCH_OPS.has(name)) branchOp = true
      if (name === '--force') force = true
      if (name === '--pathspec-from-file') fromFile = true
      if (CHECKOUT_VALUE_OPTS.has(name) && !t.includes('=')) i++
      continue
    }
    if (/^-[A-Za-z]/.test(t)) {
      for (let k = 1; k < t.length; k++) {
        if (t[k] === 'f') force = true
        if (t[k] === 't') branchOp = true // --track
        if (t[k] === 'b' || t[k] === 'B') {
          branchOp = true
          if (k === t.length - 1) i++ // `-b <name>`; `-b<name>` carries it attached
          break
        }
      }
      continue
    }
    operands.push(t)
  }
  // A forced checkout discards every local change, branch operation or not.
  if (force) return { pathspecs: [WHOLE_TREE], source: operands[0] ?? 'HEAD', fromFile }
  if (branchOp) return null
  return { pathspecs: operands, source: null, fromFile }
}

/** null → touches only the index; else its pathspecs and --source. */
const parseRestore = rest => {
  const pathspecs = []
  let staged = false
  let worktree = false
  let fromFile = false
  let source = null
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]
    if (t === '--') {
      pathspecs.push(...rest.slice(i + 1))
      break
    }
    if (t.startsWith('--')) {
      const [name, value] = t.split(/=(.*)/s)
      if (name === '--staged') staged = true
      if (name === '--worktree') worktree = true
      if (name === '--pathspec-from-file') fromFile = true
      if (name === '--source') source = value ?? rest[i + 1] ?? null
      const takesValue = ['--source', '--conflict', '--pathspec-from-file'].includes(name)
      if (takesValue && value === undefined) i++
      continue
    }
    if (/^-[A-Za-z]/.test(t)) {
      for (let k = 1; k < t.length; k++) {
        if (t[k] === 'S') staged = true
        if (t[k] === 'W') worktree = true
        if (t[k] === 's') {
          // `-s <tree>`; `-s<tree>` carries it attached
          source = k === t.length - 1 ? (rest[++i] ?? null) : t.slice(k + 1)
          break
        }
      }
      continue
    }
    pathspecs.push(t)
  }
  return staged && !worktree ? null : { pathspecs, source, fromFile }
}

// Characters a pathspec may hold and still mean exactly what it says to both
// the shell and git. Anything else (a $var, braces, a glob, a quote, a
// backslash) may expand to paths the parsed tokens do not show.
const PLAIN_PATHSPEC = /^[\w./@+,=%: -]+$/

/** Why a restore's pathspecs cannot be read statically, or null when they can. */
const unreadablePathspecs = (parsed, cmd) => {
  if (parsed.fromFile) return 'it reads its pathspecs from a file (--pathspec-from-file)'
  const unplain = parsed.pathspecs.find(p => !PLAIN_PATHSPEC.test(p))
  if (unplain !== undefined) return `its pathspec \`${unplain}\` is not a plain path`
  // A substitution or xargs supplies paths the parsed tokens do not show.
  if (/\$\(|`/.test(cmd)) return 'the command contains a command substitution'
  if (/\bxargs\b/.test(cmd)) return 'the command runs through xargs'
  return null
}

/**
 * Worktree-overwriting checkout/restore invocations in a command. pathspecs is
 * what to copy; widened names why it became the whole tree, when it did.
 */
export const restoreInvocations = cmd =>
  gitInvocations(cmd).flatMap(g => {
    const parsed =
      g.word === 'checkout' ? parseCheckout(g.rest) : g.word === 'restore' ? parseRestore(g.rest) : null
    if (!parsed) return []
    const widened = unreadablePathspecs(parsed, cmd)
    if (!widened && parsed.pathspecs.length === 0) return []
    return [
      {
        verb: g.word,
        pathspecs: widened ? [WHOLE_TREE] : parsed.pathspecs,
        source: parsed.source,
        widened,
        cArgs: g.cArgs,
        cdPath: g.cdPath,
      },
    ]
  })

// ---------------------------------------------------------------------------

const diffAgainst = (cwd, cArgs, base, mode, pathspecs) =>
  git(cwd, cArgs, ['diff', mode, '-z', '--no-renames', '--no-ext-diff', '--no-textconv', base, '--', ...pathspecs])
    .split('\0')
    .filter(Boolean)

/** HEAD, or the empty tree before the first commit, when every file is new. */
const headOrEmptyTree = (cwd, cArgs) => {
  try {
    return git(cwd, cArgs, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  } catch {
    return git(cwd, cArgs, ['hash-object', '-t', 'tree', '--stdin']) // stdin is empty
  }
}

/**
 * Untracked files under the pathspecs that `source` tracks: a checkout from
 * that commit overwrites them. Repo-relative.
 */
const untrackedIn = (cwd, cArgs, pathspecs, source) => {
  const untracked = git(cwd, cArgs, ['ls-files', '-z', '--others', '--exclude-standard', '--full-name', '--', ...pathspecs])
    .split('\0')
    .filter(Boolean)
  if (!untracked.length) return [] // fast path: cat-file would find nothing to match
  const input = untracked.map(p => `${source}:${p}\n`).join('')
  const kinds = git(cwd, cArgs, ['cat-file', '--batch-check=%(objecttype)'], input).split('\n')
  return untracked.filter((_, i) => kinds[i] === 'blob')
}

/**
 * Files under the pathspecs that differ from HEAD, repo-relative, plus the
 * untracked ones `source` would overwrite. --numstat reads every file and fails
 * outright on one it cannot read; --name-only still lists that file, so it is
 * the fallback and countsError says why the counts are missing.
 */
const changedFiles = (cwd, cArgs, pathspecs, source) => {
  const base = headOrEmptyTree(cwd, cArgs)
  let files
  let countsError = null
  try {
    files = diffAgainst(cwd, cArgs, base, '--numstat', pathspecs).map(rec => {
      const [added, deleted, ...path] = rec.split('\t')
      const count = n => (n === '-' ? null : Number(n))
      return { path: path.join('\t'), added: count(added), deleted: count(deleted) }
    })
  } catch (e) {
    countsError = firstLine(e)
    files = diffAgainst(cwd, cArgs, base, '--name-only', pathspecs).map(path => ({ path }))
  }
  // Fast path: with no source (an index restore) no untracked file is at risk.
  const untracked = source ? untrackedIn(cwd, cArgs, pathspecs, source) : []
  return { files: [...files, ...untracked.map(path => ({ path, untracked: true }))], countsError }
}

/** Copy one file (or symlink, as a link). Returns null, 'absent', or an error code. */
const copyOne = (src, dst) => {
  let st
  try {
    st = lstatSync(src)
  } catch {
    return 'absent' // deleted in the working tree: HEAD still holds it
  }
  try {
    mkdirSync(dirname(dst), { recursive: true })
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(src), dst)
    else if (st.isFile()) copyFileSync(src, dst)
    else return 'not a regular file'
    return null
  } catch (e) {
    return e?.code ?? String(e)
  }
}

const countsOf = f =>
  f.untracked ? 'untracked' : f.added === undefined ? '?' : f.added === null ? 'binary' : `+${f.added} -${f.deleted}`

// Widening and failures come before the listing, so a clipped listing never hides them.
const report = ({ dir, copied, failed, widened, countsError }) =>
  fitLines(
    [
      `backup-before-restore: copied ${copied.length === 1 ? '1 file' : `${copied.length} files`} ` +
        `before this command ran, to:`,
      dir,
      ...widened.map(w => `Every file that differs from HEAD was copied, because ${w}.`),
      ...failed.map(f => `not copied: ${f.path} (${f.reason})`),
      ...(countsError ? [`line counts unavailable: git diff --numstat failed: ${countsError}`] : []),
    ],
    copied.map(f => `  ${countsOf(f)}  ${f.path}`),
    n => `  …and ${n} more, listed in ${basename(dir)}.manifest.txt beside it`,
  ).join('\n')

const backUp = ({ payload, cmd, cwd: payloadCwd, invocations }) => {
  const session =
    String(payload.session_id ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8) || 'nosession'
  const now = new Date()
  const stamp = `${now.toISOString().replace(/:/g, '-')}-${process.pid}`
  const repos = new Map() // gitDir → {top, files: Map<path, file>, widened: Set<string>, countsError}
  const notes = []

  for (const inv of invocations) {
    const unresolved = unresolvedTarget(inv)
    if (unresolved) {
      notes.push(
        `backup-before-restore: nothing copied for \`git ${inv.verb}\`: its target \`${unresolved}\` ` +
          `is not a literal path, so the repository it restores in is unknown.`,
      )
      continue
    }
    const { cwd } = effectiveCwd(payloadCwd, inv.cdPath)
    let top, gitDir, files, countsError
    try {
      ;[top, gitDir] = git(cwd, inv.cArgs, ['rev-parse', '--show-toplevel', '--absolute-git-dir']).split('\n')
      ;({ files, countsError } = changedFiles(cwd, inv.cArgs, inv.pathspecs, inv.source))
    } catch {
      continue // not a repository, bad pathspec: the command itself reports these
    }
    const repo = repos.get(gitDir) ?? { top, files: new Map(), widened: new Set(), countsError: null }
    repos.set(gitDir, repo)
    for (const f of files) repo.files.set(f.path, f)
    if (inv.widened) repo.widened.add(inv.widened)
    repo.countsError ??= countsError
  }

  for (const [gitDir, repo] of repos) {
    const dir = join(gitDir, 'restore-backups', session, stamp)
    const copied = []
    const failed = []
    for (const f of repo.files.values()) {
      const reason = copyOne(join(repo.top, f.path), join(dir, f.path))
      if (reason === null) copied.push(f)
      else if (reason !== 'absent') failed.push({ path: f.path, reason })
    }
    if (!copied.length && !failed.length) continue
    // copyOne's mkdir under dir made this file's directory for every entry; if
    // it failed, this write throws too, and main reports it.
    writeFileSync(
      `${dir}.manifest.txt`, // beside the mirror, where no repository path can land
      [
        `command: ${cmd}`,
        `cwd: ${payloadCwd}`,
        `session: ${payload.session_id ?? ''}`,
        `time: ${now.toISOString()}`,
        ...copied.map(f => `${countsOf(f)}\t${f.path}`),
        ...failed.map(f => `not copied (${f.reason})\t${f.path}`),
        '',
      ].join('\n'),
    )
    notes.push(report({ dir, copied, failed, widened: [...repo.widened], countsError: repo.countsError }))
  }
  return notes
}

const main = () => {
  const hook = readHookPayload(/\b(checkout|restore)\b/)
  if (!hook) return
  try {
    emitPreToolUseContext(backUp({ ...hook, invocations: restoreInvocations(hook.cmd) }))
  } catch (e) {
    emitPreToolUseContext([`backup-before-restore: failed before copying everything: ${e?.message ?? e}`])
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) main()
