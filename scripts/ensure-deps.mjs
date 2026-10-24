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
// after a successful install to the lockfile minus its leading package-manager
// document. Compared by content: a checkout rewrites the lockfile's mtime
// without changing what it says.
const INSTALL_RECORD = join('node_modules', '.pnpm', 'lock.yaml')
const PACKAGE_MANAGER_DOC = /^---\n[\s\S]*?\n---\n/
const FAILURE_TAIL_LINES = 10

/**
 * The one non-interactive install, shared with the gate. `--frozen-lockfile`
 * reconciles in both directions, so a package left newer than the branch asks
 * for is downgraded.
 */
export const FROZEN_INSTALL_ARGS = ['install', '--frozen-lockfile']
export const BUILD_ARGS = ['run', 'compile:packages']

/**
 * The packages `compile:packages` builds. `buildInfo` is each tsconfig's
 * tsBuildInfoFile: `tsc -b` rewrites it on every build, including one that
 * only refreshes timestamps, so sources are compared against it — an output
 * keeps its old mtime when a rebuild changes nothing, and would never settle.
 * Both tsconfigs compile `src/**` into `dist` with declarations, so each
 * source's `.js` and `.d.ts` are its outputs and every other output is
 * orphaned, except under `generated`: agent-cli's kernel types, which
 * `compile:post` builds from the app. They are not checked: their build fails
 * on any app type error, so requiring them would rerun it at every session
 * start; `kmagent types` owns that (#1386).
 */
export const DIST_PACKAGES = [
  { dir: 'packages/agent-cli', buildInfo: 'node_modules/.tmp/agent-cli.tsbuildinfo', generated: ['dist/kernel-types'] },
  { dir: 'packages/agent-dispatch', buildInfo: 'node_modules/.tmp/agent-dispatch.tsbuildinfo' },
]

const readOrNull = path => {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

const mtimeOf = path => statSync(path, { throwIfNoEntry: false })?.mtimeMs

// pnpm writes the install record even when the install fails on an unlisted
// build script, so the hook reports that failure once; the gate's install keeps failing.
export const readDepsState = root => {
  const wanted = readOrNull(join(root, LOCKFILE))
  if (!wanted) return 'no-lockfile'
  const installed = readOrNull(join(root, INSTALL_RECORD))
  if (!installed) return 'missing'
  return installed === wanted.replace(PACKAGE_MANAGER_DOC, '') ? 'fresh' : 'mismatch'
}

const filesUnder = (pkgDir, sub) =>
  existsSync(join(pkgDir, sub))
    ? readdirSync(join(pkgDir, sub), { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => relative(pkgDir, join(entry.parentPath, entry.name)))
    : []

/** The path a compiled source shares with its outputs (`src/a.ts`, `dist/a.js`: `a`); an ambient `.d.ts` compiles to nothing. */
const compiledBase = source => /^src\/(.+)(?<!\.d)\.ts$/.exec(source)?.[1]

const emittedFor = source => {
  const base = compiledBase(source)
  return base ? [`dist/${base}.js`, `dist/${base}.d.ts`] : []
}

/** Outputs, with their source maps, of a source that is gone: tsc never deletes them, so the module stays importable. */
const orphanedOutputs = (pkgDir, sources, generated = []) => {
  const compiled = new Set(sources.map(compiledBase).filter(Boolean))
  return filesUnder(pkgDir, 'dist').filter(output => {
    if (generated.some(tree => output.startsWith(`${tree}/`))) return false
    const base = /^dist\/(.+?)(?:\.d\.ts|\.js)(?:\.map)?$/.exec(output)?.[1]
    return base !== undefined && !compiled.has(base)
  })
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
    const sources = filesUnder(dir, 'src')
    if (sources.flatMap(emittedFor).some(output => !existsSync(join(dir, output)))) return [{ dir: pkg.dir, reason: 'missing' }]
    if (orphanedOutputs(dir, sources, pkg.generated).length) return [{ dir: pkg.dir, reason: 'orphaned' }]
    // Under NodeNext the manifest's `type` decides the emitted module format.
    const inputs = ['tsconfig.json', 'package.json', ...sources]
    return Math.max(...inputs.map(input => mtimeOf(join(dir, input)) ?? 0)) > (mtimeOf(join(dir, pkg.buildInfo)) ?? -Infinity)
      ? [{ dir: pkg.dir, reason: 'outdated' }]
      : []
  })

/**
 * Clears what `tsc -b` would leave wrong in a stale package. It trusts a build
 * record newer than its inputs over the outputs it describes, so the record
 * goes or an output someone deleted is never re-emitted; and it never deletes
 * the outputs of a deleted source, so those go too.
 */
const clearStaleBuilds = root => {
  const stale = new Set(staleDist(root).map(({ dir }) => dir))
  for (const pkg of DIST_PACKAGES) {
    if (!stale.has(pkg.dir)) continue
    const dir = join(root, pkg.dir)
    rmSync(join(dir, pkg.buildInfo), { force: true })
    for (const output of orphanedOutputs(dir, filesUnder(dir, 'src'), pkg.generated)) rmSync(join(dir, output))
  }
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
const DIST_REASON = {
  missing: 'was missing build outputs',
  orphaned: 'had outputs of deleted sources',
  outdated: 'was older than its sources',
}

const UNFORMATTED_LOCKFILE_NOTE =
  `${LOCKFILE} still differs from the install record after a clean install: it is not in the form pnpm writes, ` +
  `so this reinstall repeats at every session start. \`pnpm install --lockfile-only --force\` rewrites it; commit that to stop it.`

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
    if (args === BUILD_ARGS) clearStaleBuilds(root)
    const failure = runPnpm(root, args, env)
    if (failure) {
      lines.push(`\`pnpm ${args.join(' ')}\` FAILED; until it succeeds, tests, tsc, lint and \`pnpm agent\` may not match this checkout: ${failure}`)
      break
    }
    lines.push(`Ran \`pnpm ${args.join(' ')}\`.`)
    if (args === FROZEN_INSTALL_ARGS && readDepsState(root) !== 'fresh') lines.push(UNFORMATTED_LOCKFILE_NOTE)
  }
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
