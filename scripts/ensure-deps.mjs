#!/usr/bin/env node
// SessionStart hook: reinstall node_modules and rebuild the agent packages
// when they no longer match this checkout.
//
// Agent worktree directories are reused: a new session checks its branch out
// in a directory an earlier session used, git rewrites the tracked files, and
// the untracked node_modules and packages/*/dist keep what the last install or
// build there produced. The drift presents as the session's own type errors or
// as flaky tests.
//
// Prints nothing when nothing is stale, and never fails session start. Two
// sessions starting in one checkout at the same moment can both install;
// accepted as rare.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMainModule } from './is-main-module.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const LOCKFILE = 'pnpm-lock.yaml'
// pnpm's record of the lockfile node_modules was installed from, byte-identical
// to it after a successful install. Compared by content: a checkout rewrites
// the lockfile's mtime without changing what it says.
const INSTALL_RECORD = join('node_modules', '.pnpm', 'lock.yaml')
const BASE_REF = 'origin/master'
const FAILURE_TAIL_LINES = 15

/**
 * The one non-interactive install, shared with the gate. `--frozen-lockfile`
 * reconciles in both directions, so a package left newer than the branch asks
 * for is downgraded. The purge flag is load-bearing: an install that has to
 * recreate node_modules aborts without a TTY, and neither caller has one.
 */
export const FROZEN_INSTALL_ARGS = ['install', '--frozen-lockfile', '--config.confirmModulesPurge=false']
export const BUILD_ARGS = ['run', 'compile:packages']

/**
 * The packages `compile:packages` builds. `buildInfo` is each tsconfig's
 * tsBuildInfoFile: `tsc -b` rewrites it on every build, including one that
 * only refreshes timestamps, so sources are compared against it — an output
 * keeps its old mtime when a rebuild changes nothing, and would never settle.
 */
export const DIST_PACKAGES = [
  { dir: 'packages/agent-cli', buildInfo: 'node_modules/.tmp/agent-cli.tsbuildinfo' },
  { dir: 'packages/agent-dispatch', buildInfo: 'node_modules/.tmp/agent-dispatch.tsbuildinfo' },
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

const stringLeaves = value => (typeof value === 'string' ? [value] : Object.values(value ?? {}).flatMap(stringLeaves))

/** Whether any file the package's manifest promises — a bin or an export — is absent. */
const outputsMissing = pkgDir => {
  const { bin, exports } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  return [...stringLeaves(bin), ...stringLeaves(exports)].some(output => !existsSync(join(pkgDir, output)))
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
    if (outputsMissing(dir)) return [{ dir: pkg.dir, reason: 'missing' }]
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

/**
 * `tsc -b` trusts a build record newer than its inputs over the outputs it
 * describes, so a stale package's record goes before the build, or an output
 * someone deleted is never re-emitted.
 */
const forgetStaleBuildRecords = root => {
  const stale = new Set(staleDist(root).map(({ dir }) => dir))
  for (const pkg of DIST_PACKAGES) if (stale.has(pkg.dir)) rmSync(join(root, pkg.dir, pkg.buildInfo), { force: true })
}

/** Null on success; otherwise why the command failed, with the end of its output. */
const runPnpm = (root, args, env) => {
  const result = spawnSync('pnpm', args, { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status === 0) return null
  const tail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-FAILURE_TAIL_LINES).join('\n')
  return `${result.error?.message ?? (result.signal ? `killed by ${result.signal}` : `exit ${result.status}`)}\n${tail}`
}

const DEPS_REASON = {
  missing: 'node_modules has no install record (node_modules/.pnpm/lock.yaml)',
  mismatch: "node_modules was installed from a different pnpm-lock.yaml than this checkout's",
}
const DIST_REASON = { missing: 'was missing files its package.json names', outdated: 'was older than its sources' }

const BEHIND_BASE_WARNING =
  `This branch's ${LOCKFILE} is behind ${BASE_REF} (changed there after this branch forked, not here), ` +
  "so the install matches the branch's older dependency set and downgrades whatever a newer checkout left installed. " +
  `A failure caused by an outdated dependency is fixed by a rebase onto ${BASE_REF}, not a reinstall.`

/** Reconciles `root`; returns the context for the session, '' when nothing was stale. */
export const ensureDeps = ({ root, env = process.env }) => {
  const deps = readDepsState(root)
  if (deps === 'no-lockfile') return ''
  const dist = staleDist(root)
  // A new dependency set can change the toolchain or purge the build records,
  // so the packages are rebuilt against every install.
  const steps = deps !== 'fresh' ? [FROZEN_INSTALL_ARGS, BUILD_ARGS] : dist.length ? [BUILD_ARGS] : []
  if (!steps.length) return ''

  const stale = [...(deps === 'fresh' ? [] : [DEPS_REASON[deps]]), ...dist.map(d => `${d.dir} dist ${DIST_REASON[d.reason]}`)]
  const lines = [`[ensure-deps] ${stale.join('; ')}.`]
  for (const args of steps) {
    if (args === BUILD_ARGS) forgetStaleBuildRecords(root)
    const failure = runPnpm(root, args, env)
    if (failure) {
      lines.push(`\`pnpm ${args.join(' ')}\` FAILED, so tests, tsc, lint and \`pnpm agent\` can fail for reasons unrelated to your work: ${failure}`)
      break
    }
    lines.push(`Ran \`pnpm ${args.join(' ')}\`.`)
  }
  if (deps !== 'fresh' && lockfileBehindBase(root)) lines.push(BEHIND_BASE_WARNING)
  return lines.join('\n')
}

if (isMainModule(import.meta.url)) {
  try {
    const text = ensureDeps({ root: ROOT })
    if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }))
  } catch (error) {
    console.error(`[ensure-deps] ${error?.message ?? error}`)
  }
}
