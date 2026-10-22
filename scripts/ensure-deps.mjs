#!/usr/bin/env node
// SessionStart hook: bring this checkout's node_modules and built agent
// packages up to date before the session's first command reads them.
//
// Agent worktree directories are recycled across sessions. Git refreshes the
// tracked files, but the untracked node_modules and packages/*/dist keep what
// the directory's last install or build produced, and the drift presents as
// the session's own type errors or as flaky tests.
//
// Contract: never break session start, and print nothing when nothing is
// stale. Work that outlives the wait is left running detached, never killed
// half-way through an install.
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMainModule } from './is-main-module.mjs'

const SCRIPT = fileURLToPath(import.meta.url)
const ROOT = dirname(dirname(SCRIPT))
const LOCKFILE = 'pnpm-lock.yaml'
// pnpm's record of the lockfile node_modules was installed from, byte-identical
// to it after a successful install. Compared by content: a checkout rewrites
// the lockfile's mtime without changing what it says.
const INSTALL_RECORD = join('node_modules', '.pnpm', 'lock.yaml')
const BASE_REF = 'origin/master'

/**
 * The one non-interactive install, shared with the gate. `--frozen-lockfile`
 * reconciles in both directions, so a package left newer than the branch asks
 * for is downgraded. The purge flag is load-bearing: an install that has to
 * recreate node_modules aborts without a TTY, and neither caller has one.
 */
export const FROZEN_INSTALL_ARGS = ['install', '--frozen-lockfile', '--config.confirmModulesPurge=false']
export const BUILD_ARGS = ['run', 'compile:packages']
const STEP_ARGS = { install: FROZEN_INSTALL_ARGS, build: BUILD_ARGS }

// Below the 30s timeout .claude/settings.json and .codex/hooks.json give this hook.
export const WAIT_MS = 20_000

/**
 * The packages `compile:packages` builds. `buildInfo` is each tsconfig's
 * tsBuildInfoFile: `tsc -b` rewrites it on every build, including one that
 * only refreshes timestamps, so sources are compared against it — the entry
 * keeps its old mtime when a rebuild changes nothing, and would never settle.
 */
export const DIST_PACKAGES = [
  { dir: 'packages/agent-cli', entry: 'dist/cli.js', buildInfo: 'node_modules/.tmp/agent-cli.tsbuildinfo' },
  { dir: 'packages/agent-dispatch', entry: 'dist/daemon.js', buildInfo: 'node_modules/.tmp/agent-dispatch.tsbuildinfo' },
]

const readOrNull = path => {
  try {
    return readFileSync(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

const mtimeOf = path => statSync(path, { throwIfNoEntry: false })?.mtimeMs

export const readDepsState = root => {
  const wanted = readOrNull(join(root, LOCKFILE))
  if (!wanted) return 'no-lockfile'
  const installed = readOrNull(join(root, INSTALL_RECORD))
  if (!installed) return 'missing'
  return installed.equals(wanted) ? 'fresh' : 'mismatch'
}

const newestInput = pkgDir => {
  let newest = mtimeOf(join(pkgDir, 'tsconfig.json')) ?? 0
  for (const entry of readdirSync(join(pkgDir, 'src'), { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) newest = Math.max(newest, mtimeOf(join(entry.parentPath, entry.name)) ?? 0)
  }
  return newest
}

/**
 * Packages whose dist does not reflect their sources. Mtime-based like
 * `tsc -b`'s own check, so a checkout that rewrites a source unchanged
 * over-reports; the rebuild that follows refreshes the build record and
 * settles it.
 */
export const staleDist = root =>
  DIST_PACKAGES.flatMap(pkg => {
    const dir = join(root, pkg.dir)
    if (!existsSync(join(dir, 'src'))) return []
    if (!existsSync(join(dir, pkg.entry))) return [{ dir: pkg.dir, reason: 'missing' }]
    return newestInput(dir) > (mtimeOf(join(dir, pkg.buildInfo)) ?? -Infinity)
      ? [{ dir: pkg.dir, reason: 'outdated' }]
      : []
  })

const git = (root, args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  return result.status === 0 ? result.stdout.trim() : null
}

/**
 * Whether the base changed the lockfile after this branch forked while the
 * branch left it alone: then a frozen install matches the branch's older set,
 * and only a rebase brings the newer one.
 */
export const lockfileBehindBase = (root, baseRef = BASE_REF) => {
  const fork = git(root, ['merge-base', 'HEAD', baseRef])
  const blobs = fork && git(root, ['rev-parse', `${fork}:${LOCKFILE}`, `${baseRef}:${LOCKFILE}`])
  if (!blobs) return false
  const [atFork, atBase] = blobs.split('\n')
  return atFork !== atBase && git(root, ['hash-object', LOCKFILE]) === atFork
}

/** Per-checkout state (lock, log) in the git dir, which no reinstall purges and git never tracks. */
export const stateDir = root => {
  const dir = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'ensure-deps'])
  if (!dir) throw new Error(`could not resolve the git dir of ${root}`)
  return dir
}

const pidAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

const createLock = lockPath => {
  try {
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' })
    return true
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }
}

const lockHolder = lockPath => Number(readOrNull(lockPath)?.toString())

/** Null once this process holds the lock; otherwise the pid of the live job that does. */
const takeLock = lockPath => {
  if (createLock(lockPath)) return null
  const holder = lockHolder(lockPath)
  if (pidAlive(holder)) return holder
  rmSync(lockPath, { force: true })
  return createLock(lockPath) ? null : lockHolder(lockPath)
}

const startJob = ({ root, steps, env }) => {
  const dir = stateDir(root)
  mkdirSync(dir, { recursive: true })
  const lockPath = join(dir, 'lock')
  const logPath = join(dir, 'log')
  const holder = takeLock(lockPath)
  if (holder !== null) return { kind: 'busy', pid: holder, logPath }

  // Until the pid below replaces it the lock names this process, so a failed
  // launch leaves a lock the next session start sees is dead and takes over.
  const logFd = openSync(logPath, 'w')
  try {
    // Detached with file stdio: the host neither waits for the job nor kills
    // it with this process's group, so an interrupted start leaves no half-done install.
    const child = spawn(process.execPath, [SCRIPT, '--job', root, lockPath, ...steps], {
      cwd: root,
      detached: true,
      env,
      stdio: ['ignore', logFd, logFd],
    })
    writeFileSync(lockPath, String(child.pid))
    return { kind: 'started', child, logPath }
  } finally {
    closeSync(logFd)
  }
}

/** The job's exit code, or null once `ms` passes with it still running. */
const waitForExit = (child, ms) =>
  new Promise(resolve => {
    const timer = setTimeout(() => {
      child.unref()
      resolve(null)
    }, ms)
    const settle = code => {
      clearTimeout(timer)
      resolve(code)
    }
    child.once('exit', code => settle(code ?? 1))
    // Defence in depth: a failed launch of node itself, which would otherwise
    // crash the hook with an unhandled 'error'.
    child.once('error', () => settle(1))
  })

/**
 * `tsc -b` trusts a build record newer than its inputs over the outputs it
 * describes, so a record whose entry is gone must go too or nothing is re-emitted.
 */
const forgetOrphanedBuildRecords = root => {
  for (const pkg of DIST_PACKAGES) {
    if (!existsSync(join(root, pkg.dir, pkg.entry))) rmSync(join(root, pkg.dir, pkg.buildInfo), { force: true })
  }
}

const runJob = (root, lockPath, steps) => {
  const say = line => process.stdout.write(`[ensure-deps] ${line}\n`)
  try {
    for (const step of steps) {
      const command = `pnpm ${STEP_ARGS[step].join(' ')}`
      if (step === 'build') forgetOrphanedBuildRecords(root)
      say(`${new Date().toISOString()} ${command}`)
      const result = spawnSync('pnpm', STEP_ARGS[step], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] })
      if (result.status !== 0) {
        say(`FAILED: ${command} — ${result.error?.message ?? (result.signal ? `killed by ${result.signal}` : `exit ${result.status}`)}`)
        return 1
      }
    }
    say('done')
    return 0
  } finally {
    rmSync(lockPath, { force: true })
  }
}

const DEPS_REASON = {
  missing: 'node_modules has no install record (node_modules/.pnpm/lock.yaml)',
  mismatch: "node_modules was installed from a different pnpm-lock.yaml than this checkout's",
}
const DIST_REASON = { missing: 'was missing', outdated: 'was older than its sources' }
const UNRELATED_FAILURES = 'tests, tsc, lint and `pnpm agent` can fail for reasons unrelated to your work'

const lastLogLine = logPath => readOrNull(logPath)?.toString().trim().split('\n').at(-1) ?? '(empty log)'

const describeOutcome = ({ job, exitCode, commands }) => {
  const pending = `Until it finishes, ${UNRELATED_FAILURES}. Its log (${job.logPath}) ends with \`[ensure-deps] done\` or an \`[ensure-deps] FAILED\` line.`
  if (job.kind === 'busy') return `A job started by another session is already running (pid ${job.pid}). ${pending}`
  if (exitCode === null) return `${commands} is still running in the background (pid ${job.child.pid}). ${pending}`
  if (exitCode === 0) return `Fixed: ${commands} finished before this session started (log: ${job.logPath}).`
  return `${commands} FAILED, so ${UNRELATED_FAILURES}. Last log line: ${lastLogLine(job.logPath)} Full log: ${job.logPath}`
}

const BEHIND_BASE_WARNING =
  `This branch's ${LOCKFILE} is behind ${BASE_REF} (changed there after this branch forked, not here), ` +
  "so the install matches the branch's older dependency set and downgrades whatever a newer checkout left installed. " +
  `A failure caused by an outdated dependency is fixed by a rebase onto ${BASE_REF}, not a reinstall.`

/** Reconciles `root`; resolves to the context for the session, '' when nothing was stale. */
export const ensureDeps = async ({ root, waitMs = WAIT_MS, env = process.env }) => {
  const deps = readDepsState(root)
  if (deps === 'no-lockfile') return ''
  const dist = staleDist(root)
  const steps = [...(deps === 'fresh' ? [] : ['install']), ...(dist.length ? ['build'] : [])]
  if (!steps.length) return ''

  const job = startJob({ root, steps, env })
  const exitCode = job.kind === 'started' ? await waitForExit(job.child, waitMs) : null
  const stale = [...(deps === 'fresh' ? [] : [DEPS_REASON[deps]]), ...dist.map(d => `${d.dir} dist ${DIST_REASON[d.reason]}`)]
  const commands = steps.map(step => `\`pnpm ${STEP_ARGS[step].join(' ')}\``).join(' then ')
  return [
    `[ensure-deps] ${stale.join('; ')}.`,
    describeOutcome({ job, exitCode, commands }),
    ...(steps.includes('install') && lockfileBehindBase(root) ? [BEHIND_BASE_WARNING] : []),
  ].join('\n')
}

if (isMainModule(import.meta.url)) {
  if (process.argv[2] === '--job') {
    const [root, lockPath, ...steps] = process.argv.slice(3)
    process.exitCode = runJob(root, lockPath, steps)
  } else {
    try {
      const text = await ensureDeps({ root: ROOT })
      if (text) {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }))
      }
    } catch (error) {
      console.error(`[ensure-deps] ${error?.message ?? error}`)
    }
  }
}
