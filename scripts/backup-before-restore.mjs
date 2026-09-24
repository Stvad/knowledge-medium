#!/usr/bin/env node
/**
 * Backup before checkout/restore (wired as a PreToolUse(Bash) hook). It NEVER
 * blocks: exit 0 always, and its only output is additionalContext.
 *
 * `git checkout [<rev>] -- <paths>` and `git restore <paths>` overwrite the
 * working tree from the index or a commit: they restore HEAD, not the tree as
 * it stood before the edit being undone, so every uncommitted edit in a named
 * file goes with it, silently. Advice to check `git status` first did not stop
 * that, and a blocking guard would cost a re-run on each of the many legitimate
 * restores, so this makes the loss recoverable and visible instead. Before the
 * command runs, every named path that differs from HEAD is copied to
 *
 *   <git rev-parse --absolute-git-dir>/restore-backups/<session>/<timestamp>/<repo path>
 *
 * with a manifest.txt naming the command, and the context reports the count,
 * that directory, and each file's added/deleted lines versus HEAD. Facts only:
 * no cause, no remedy. <session> is the first 8 characters of the payload's
 * session_id, so no uuid-shaped string reaches a command that reads a backup.
 *
 * Location: the per-worktree git dir keeps backups out of the tree and out of
 * every other worktree, and they outlive the session. `git worktree remove`
 * deletes them along with that worktree's own work. Nothing prunes them.
 *
 * What counts as named: checkout operands after `--`, or every operand when
 * there is no `--` (a branch or rev name matches no file); the whole tree for
 * `checkout -f` without `--`, which discards every local change; `git restore`
 * pathspecs unless it touches only the index (`--staged` without
 * `--worktree`). A pathspec the hook cannot read statically (a `$var`, a
 * command substitution, xargs, --pathspec-from-file) widens the copy to every
 * file that differs from HEAD, and the context says which of those applied.
 * Not covered: untracked files (an index or HEAD restore leaves them alone),
 * and a restore that runs inside a script file, `bash -c`, or a heredoc.
 */

import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { effectiveCwd, gitInvocations } from './check-stash-worktree.mjs'

const WHOLE_TREE = ':/'
const LISTED_FILES = 100
const CONTEXT_MAX = 9_000

// Long checkout options that make it a branch operation rather than a restore.
const CHECKOUT_BRANCH_OPS = new Set(['--orphan', '--detach', '--track'])

/** null → not a path restore; else operands to try as pathspecs. */
const parseCheckout = rest => {
  const operands = []
  let force = false
  let fromFile = false
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]
    if (t === '--') return { pathspecs: rest.slice(i + 1), fromFile }
    if (t.startsWith('--')) {
      const name = t.split('=')[0]
      if (CHECKOUT_BRANCH_OPS.has(name)) return null
      if (name === '--force') force = true
      if (name === '--pathspec-from-file') fromFile = true
      if ((name === '--pathspec-from-file' || name === '--conflict') && !t.includes('=')) i++
      continue
    }
    if (/^-[A-Za-z]/.test(t)) {
      if (/[bBt]/.test(t)) return null // -b/-B create a branch, -t tracks one
      if (t.includes('f')) force = true
      continue
    }
    operands.push(t)
  }
  return { pathspecs: force ? [WHOLE_TREE] : operands, fromFile }
}

/** null → touches only the index; else its pathspecs. */
const parseRestore = rest => {
  const pathspecs = []
  let staged = false
  let worktree = false
  let fromFile = false
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]
    if (t === '--') {
      pathspecs.push(...rest.slice(i + 1))
      break
    }
    if (t.startsWith('--')) {
      const name = t.split('=')[0]
      if (name === '--staged') staged = true
      if (name === '--worktree') worktree = true
      if (name === '--pathspec-from-file') fromFile = true
      const takesValue = ['--source', '--conflict', '--pathspec-from-file'].includes(name)
      if (takesValue && !t.includes('=')) i++
      continue
    }
    if (/^-[A-Za-z]/.test(t)) {
      for (let k = 1; k < t.length; k++) {
        if (t[k] === 'S') staged = true
        if (t[k] === 'W') worktree = true
        if (t[k] === 's') {
          if (k === t.length - 1) i++ // `-s <tree>`; `-s<tree>` carries it attached
          break
        }
      }
      continue
    }
    pathspecs.push(t)
  }
  return staged && !worktree ? null : { pathspecs, fromFile }
}

/**
 * Worktree-overwriting checkout/restore invocations in a command. pathspecs is
 * what to copy; widened names why it became the whole tree, when it did.
 */
export const restoreInvocations = cmd => {
  // A substitution or xargs supplies paths the parsed tokens do not show.
  const substituted = /\$\(|`/.test(cmd)
  const piped = /\bxargs\b/.test(cmd)
  return gitInvocations(cmd).flatMap(g => {
    const parsed =
      g.word === 'checkout' ? parseCheckout(g.rest) : g.word === 'restore' ? parseRestore(g.rest) : null
    if (!parsed) return []
    const variable = parsed.pathspecs.find(p => p.includes('$'))
    const widened = parsed.fromFile
      ? 'it reads its pathspecs from a file (--pathspec-from-file)'
      : variable
        ? `its pathspec \`${variable}\` is not literal`
        : substituted
          ? 'the command contains a command substitution'
          : piped
            ? 'the command runs through xargs'
            : null
    if (!widened && parsed.pathspecs.length === 0) return []
    return [
      {
        verb: g.word,
        pathspecs: widened ? [WHOLE_TREE] : parsed.pathspecs,
        widened,
        cArgs: g.cArgs,
        cdPath: g.cdPath,
      },
    ]
  })
}

// ---------------------------------------------------------------------------

const git = (cwd, cArgs, args) =>
  execFileSync('git', [...cArgs, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })

/** Files under the pathspecs that differ from HEAD, repo-relative; counts null for binary. */
const changedFiles = (cwd, cArgs, pathspecs) =>
  git(cwd, cArgs, [
    'diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', 'HEAD', '--', ...pathspecs,
  ])
    .split('\0')
    .filter(Boolean)
    .map(rec => {
      const [added, deleted, ...path] = rec.split('\t')
      const count = n => (n === '-' ? null : Number(n))
      return { path: path.join('\t'), added: count(added), deleted: count(deleted) }
    })

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

const countsOf = f => (f.added === null ? 'binary' : `+${f.added} -${f.deleted}`)

const report = ({ dir, copied, failed, widened }) => {
  const lines = [
    `backup-before-restore: copied ${copied.length === 1 ? '1 file that differs' : `${copied.length} files that differ`} ` +
      `from HEAD, before this command ran, to:`,
    dir,
    ...copied.slice(0, LISTED_FILES).map(f => `  ${countsOf(f)}  ${f.path}`),
  ]
  if (copied.length > LISTED_FILES) {
    lines.push(`  …and ${copied.length - LISTED_FILES} more, listed in manifest.txt`)
  }
  for (const f of failed) lines.push(`not copied: ${f.path} (${f.reason})`)
  for (const w of widened) lines.push(`Every file that differs from HEAD was copied, because ${w}.`)
  return lines.join('\n')
}

const backUp = ({ payload, cmd, invocations }) => {
  const payloadCwd = payload.cwd || process.cwd()
  const session =
    String(payload.session_id ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8) || 'nosession'
  const now = new Date()
  const stamp = `${now.toISOString().replace(/:/g, '-')}-${process.pid}`
  const repos = new Map() // gitDir → {top, files: Map<path, file>, widened: Set<string>}
  const notes = []

  for (const inv of invocations) {
    const { cwd, exact } = effectiveCwd(payloadCwd, inv.cdPath)
    const unresolved = exact ? inv.cArgs.find(a => a.includes('$')) : inv.cdPath
    if (unresolved) {
      notes.push(
        `backup-before-restore: nothing copied for \`git ${inv.verb}\`: its target \`${unresolved}\` ` +
          `is not a literal path, so the repository it restores in is unknown.`,
      )
      continue
    }
    let top, gitDir, files
    try {
      ;[top, gitDir] = git(cwd, inv.cArgs, ['rev-parse', '--show-toplevel', '--absolute-git-dir'])
        .trim()
        .split('\n')
      files = changedFiles(cwd, inv.cArgs, inv.pathspecs)
    } catch {
      continue // not a repository, unborn HEAD, bad pathspec: the command itself reports these
    }
    if (!files.length) continue
    const repo = repos.get(gitDir) ?? { top, files: new Map(), widened: new Set() }
    repos.set(gitDir, repo)
    for (const f of files) repo.files.set(f.path, f)
    if (inv.widened) repo.widened.add(inv.widened)
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
    if (copied.length) {
      writeFileSync(
        join(dir, 'manifest.txt'),
        [
          `command: ${cmd}`,
          `cwd: ${payloadCwd}`,
          `session: ${payload.session_id ?? ''}`,
          `time: ${now.toISOString()}`,
          ...copied.map(f => `${countsOf(f)}\t${f.path}`),
          '',
        ].join('\n'),
      )
    }
    notes.push(report({ dir, copied, failed, widened: [...repo.widened] }))
  }
  return notes
}

const emit = notes => {
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

const main = () => {
  let payload
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return // not a hook payload
  }
  const cmd = payload?.tool_input?.command ?? ''
  if (!/\b(checkout|restore)\b/.test(cmd)) return
  const invocations = restoreInvocations(cmd)
  if (!invocations.length) return
  try {
    emit(backUp({ payload, cmd, invocations }))
  } catch (e) {
    emit([`backup-before-restore: failed before copying everything: ${e?.message ?? e}`])
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) main()
