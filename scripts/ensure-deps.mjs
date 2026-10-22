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
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMainModule } from './is-main-module.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const LOCKFILE = 'pnpm-lock.yaml'
// pnpm's record of the lockfile node_modules was installed from, byte-identical
// to it after a successful install. Compared by content: a checkout rewrites
// the lockfile's mtime without changing what it says.
const INSTALL_RECORD = join('node_modules', '.pnpm', 'lock.yaml')
const BASE_REF = 'origin/master'
const FAILURE_TAIL_LINES = 10

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
 * Both tsconfigs compile `src/**` into `dist` with declarations, so each
 * source's `.js` and `.d.ts` are its outputs. agent-cli's kernel types are not
 * checked: their build fails on any app type error, so requiring them would
 * rerun it at every session start; `kmagent types` owns that (#1386).
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

const sourcesOf = pkgDir =>
  readdirSync(join(pkgDir, 'src'), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => relative(pkgDir, join(entry.parentPath, entry.name)))

/** What tsc emits for a source; an ambient `.d.ts` compiles to nothing. */
const emittedFor = source => {
  const compiled = /^src\/(.+)(?<!\.d)\.ts$/.exec(source)
  return compiled ? [`dist/${compiled[1]}.js`, `dist/${compiled[1]}.d.ts`] : []
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
    const sources = sourcesOf(dir)
    if (sources.flatMap(emittedFor).some(output => !existsSync(join(dir, output)))) return [{ dir: pkg.dir, reason: 'missing' }]
    // Under NodeNext the manifest's `type` decides the emitted module format.
    const inputs = ['tsconfig.json', 'package.json', ...sources]
    return Math.max(...inputs.map(input => mtimeOf(join(dir, input)) ?? 0)) > (mtimeOf(join(dir, pkg.buildInfo)) ?? -Infinity)
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

const tailOf = output => (output ?? '').trim().split('\n').slice(-FAILURE_TAIL_LINES).join('\n')

/**
 * Null on success; otherwise why the command failed, with the end of each
 * stream on its own, so a stack trace on stderr cannot push the compiler's
 * errors on stdout out of the tail.
 */
const runPnpm = (root, args, env) => {
  const result = spawnSync('pnpm', args, { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status === 0) return null
  const why = result.error?.message ?? (result.signal ? `killed by ${result.signal}` : `exit ${result.status}`)
  return [why, ...[result.stdout, result.stderr].map(tailOf).filter(Boolean)].join('\n')
}

const DEPS_REASON = {
  missing: 'node_modules has no install record (node_modules/.pnpm/lock.yaml)',
  mismatch: "node_modules was installed from a different pnpm-lock.yaml than this checkout's",
}
const DIST_REASON = { missing: 'was missing build outputs', outdated: 'was older than its sources' }

const UNFORMATTED_LOCKFILE_NOTE =
  `${LOCKFILE} still differs from the install record after a clean install: it is not in the form pnpm writes, ` +
  `so this reinstall repeats at every session start. \`cp ${INSTALL_RECORD} ${LOCKFILE}\` and commit it to stop that.`

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
      lines.push(`\`pnpm ${args.join(' ')}\` FAILED; until it succeeds, tests, tsc, lint and \`pnpm agent\` may not match this checkout: ${failure}`)
      break
    }
    lines.push(`Ran \`pnpm ${args.join(' ')}\`.`)
    if (args === FROZEN_INSTALL_ARGS && readDepsState(root) !== 'fresh') lines.push(UNFORMATTED_LOCKFILE_NOTE)
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
