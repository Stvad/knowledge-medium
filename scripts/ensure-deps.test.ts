import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BUILD_ARGS,
  DIST_PACKAGES,
  FROZEN_INSTALL_ARGS,
  ensureDeps,
  readDepsState,
  sessionRoot,
  staleDist,
} from './ensure-deps.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

// Every ensureDeps case spawns a PATH-fronted pnpm per step, ~50ms each alone
// and several times that under the gate's load.
const SPAWNING_TEST_TIMEOUT = 20_000

const created = new Set<string>()

afterEach(() => {
  for (const path of created) rmSync(path, { recursive: true, force: true })
  created.clear()
})

const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.add(dir)
  return dir
}

const write = (path: string, content: string, mtimeSec?: number) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  if (mtimeSec !== undefined) utimesSync(path, mtimeSec, mtimeSec)
}

const T0 = 1_700_000_000

const writeInstallRecord = (root: string, content: string, mtimeSec?: number) =>
  write(join(root, 'node_modules', '.pnpm', 'lock.yaml'), content, mtimeSec)

// Each fixture package's sources and what tsc emits for them; an ambient
// declaration file compiles to nothing.
const SOURCES = ['src/index.ts', 'src/nested/util.ts', 'src/ambient.d.ts']
const OUTPUTS = ['dist/index.js', 'dist/index.d.ts', 'dist/nested/util.js', 'dist/nested/util.d.ts']

// Sources at T0, the outputs and build record after them: what a finished `tsc -b` leaves.
const writeFreshDist = (root: string) => {
  for (const pkg of DIST_PACKAGES) {
    write(join(root, pkg.dir, 'package.json'), '{}\n', T0)
    write(join(root, pkg.dir, 'tsconfig.json'), '{}\n', T0)
    for (const source of SOURCES) write(join(root, pkg.dir, source), 'export {}\n', T0)
    for (const out of OUTPUTS) write(join(root, pkg.dir, out), 'fixture build\n', T0 + 10)
    for (const dir of pkg.generated ?? []) write(join(root, pkg.dir, dir, 'types.d.ts'), 'generated\n', T0 + 10)
    // A file in dist that no compiler emits is not an output of any source.
    write(join(root, pkg.dir, 'dist', 'notes.txt'), 'not emitted\n', T0 + 10)
    write(join(root, pkg.dir, pkg.buildInfo), '{}\n', T0 + 10)
  }
}

/** A checkout whose install record and dists already match it. */
const makeCheckout = (lockfile = 'lock: v1\n') => {
  const root = tempDir('ensure-deps-')
  write(join(root, 'pnpm-lock.yaml'), lockfile)
  writeInstallRecord(root, lockfile)
  writeFreshDist(root)
  return root
}

/**
 * A PATH-fronted `pnpm` that does what the real one leaves behind: `install`
 * writes the install record from the lockfile, the build writes every output
 * and build record the way `tsc -b` would. Each call is appended to `calls`.
 * FAKE_PNPM_FAIL names a command prefix to fail with exit 3, printing its
 * errors to stdout and a stack trace to stderr the way a failed build does.
 * FAKE_PNPM_REFORMAT makes `install` write the record in a different form
 * from the committed lockfile, as pnpm does for one it did not write.
 */
const fakePnpm = (extraEnv: Record<string, string> = {}) => {
  const bin = tempDir('ensure-deps-bin-')
  const calls = join(bin, 'calls')
  writeFileSync(
    join(bin, 'pnpm'),
    `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2).join(' ')
fs.appendFileSync(${JSON.stringify(calls)}, args + '\\n')
if (process.env.FAKE_PNPM_FAIL && args.startsWith(process.env.FAKE_PNPM_FAIL)) {
  process.stdout.write('fake pnpm failure: the real error\\n')
  for (let i = 0; i < 30; i++) process.stderr.write('    at frame' + i + ' (/somewhere/file.js:1:1)\\n')
  process.exit(3)
}
if (args.startsWith('install')) {
  fs.mkdirSync('node_modules/.pnpm', { recursive: true })
  const lockfile = fs.readFileSync('pnpm-lock.yaml', 'utf8')
  fs.writeFileSync('node_modules/.pnpm/lock.yaml', process.env.FAKE_PNPM_REFORMAT ? lockfile + '\\n' : lockfile)
}
if (args === ${JSON.stringify(BUILD_ARGS.join(' '))}) {
  const mtime = p => fs.statSync(p).mtimeMs
  for (const pkg of ${JSON.stringify(DIST_PACKAGES)}) {
    // Like tsc -b: a build record newer than every input means nothing to
    // emit, whether or not the outputs it describes still exist.
    const info = path.join(pkg.dir, pkg.buildInfo)
    const inputs = fs.readdirSync(path.join(pkg.dir, 'src'), { recursive: true, withFileTypes: true })
      .filter(e => e.isFile()).map(e => path.join(e.parentPath, e.name))
    if (fs.existsSync(info) && inputs.every(p => mtime(p) < mtime(info))) continue
    for (const out of [...${JSON.stringify(OUTPUTS)}, pkg.buildInfo]) {
      fs.mkdirSync(path.dirname(path.join(pkg.dir, out)), { recursive: true })
      fs.writeFileSync(path.join(pkg.dir, out), 'built\\n')
    }
  }
}
`,
  )
  chmodSync(join(bin, 'pnpm'), 0o755)
  const env = { ...process.env, ...extraEnv, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` }
  const readCalls = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [])
  return { env, readCalls }
}

const INSTALL = FROZEN_INSTALL_ARGS.join(' ')
const BUILD = BUILD_ARGS.join(' ')

describe('DIST_PACKAGES', () => {
  // The dist check assumes this layout; a moved build record or output dir
  // would otherwise read as stale on every session start.
  it.each(DIST_PACKAGES)('matches the real build of $dir', pkg => {
    const { compilerOptions } = JSON.parse(readFileSync(join(repoRoot, pkg.dir, 'tsconfig.json'), 'utf8'))
    expect(compilerOptions).toMatchObject({ rootDir: 'src', outDir: 'dist', declaration: true })
    expect(normalize(compilerOptions.tsBuildInfoFile)).toBe(pkg.buildInfo)
    expect(JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).scripts['compile:packages']).toContain(pkg.dir)
  })

  it('marks exactly the kernel-types tree as generated rather than compiled from package sources', () => {
    const { compilerOptions } = JSON.parse(readFileSync(join(repoRoot, 'tsconfig.kernel-types.json'), 'utf8'))
    const cli = DIST_PACKAGES.find(p => p.dir === 'packages/agent-cli')!
    expect(cli.generated).toEqual([relative(cli.dir, normalize(compilerOptions.outDir))])
  })
})

describe('sessionRoot', () => {
  it("is this script's checkout when run by hand, without a hook payload", () => {
    expect(sessionRoot('')).toBe(repoRoot)
  })
})

describe('readDepsState', () => {
  it('is fresh when the install record matches the lockfile by content, however much newer the lockfile is', () => {
    const root = makeCheckout()
    // A checkout rewrites the lockfile with unchanged content: mtime says stale.
    utimesSync(join(root, 'pnpm-lock.yaml'), T0 + 1_000, T0 + 1_000)
    writeInstallRecord(root, 'lock: v1\n', T0)
    expect(readDepsState(root)).toBe('fresh')
  })

  it('is a mismatch when the contents differ, even with the install record newer', () => {
    const root = makeCheckout()
    utimesSync(join(root, 'pnpm-lock.yaml'), T0, T0)
    writeInstallRecord(root, 'lock: v0\n', T0 + 1_000)
    expect(readDepsState(root)).toBe('mismatch')
  })

  // What pnpm 11+ writes: the project's own lockfile document follows one
  // recording the pinned package manager, which the install record leaves out.
  const PACKAGE_MANAGER_DOC = `---
lockfileVersion: '9.0'

importers:

  .:
    packageManagerDependencies:
      pnpm:
        specifier: 12.14.0
        version: 12.14.0

---
`

  it('is fresh when the install record matches the lockfile after its package-manager document', () => {
    const root = makeCheckout(`${PACKAGE_MANAGER_DOC}lock: v1\n`)
    writeInstallRecord(root, 'lock: v1\n')
    expect(readDepsState(root)).toBe('fresh')
  })

  it('is a mismatch when the lockfile after its package-manager document differs from the install record', () => {
    const root = makeCheckout(`${PACKAGE_MANAGER_DOC}lock: v1\n`)
    writeInstallRecord(root, 'lock: v0\n')
    expect(readDepsState(root)).toBe('mismatch')
  })

  it('is missing when node_modules has no install record', () => {
    const root = makeCheckout()
    rmSync(join(root, 'node_modules'), { recursive: true })
    expect(readDepsState(root)).toBe('missing')
  })

  it('has nothing to compare in a checkout without pnpm-lock.yaml', () => {
    const root = makeCheckout()
    rmSync(join(root, 'pnpm-lock.yaml'))
    expect(readDepsState(root)).toBe('no-lockfile')
  })
})

describe('staleDist', () => {
  const [pkg] = DIST_PACKAGES

  it('reports nothing when every dist was built after its sources', () => {
    expect(staleDist(makeCheckout())).toEqual([])
  })

  it.each(OUTPUTS)('reports a dist missing %s, which tsc emits for one of its sources', output => {
    const root = makeCheckout()
    rmSync(join(root, pkg.dir, output))
    expect(staleDist(root)).toEqual([{ dir: pkg.dir, reason: 'missing' }])
  })

  it.each([
    ['src/nested/util.ts', 'changed\n'],
    ['tsconfig.json', '{}\n'],
    ['package.json', '{}\n'],
  ])('reports a dist older than its input %s', (input, content) => {
    const root = makeCheckout()
    write(join(root, pkg.dir, input), content, T0 + 20)
    expect(staleDist(root)).toEqual([{ dir: pkg.dir, reason: 'outdated' }])
  })

  it('reports a dist holding outputs of a source the checkout deleted', () => {
    const root = makeCheckout()
    for (const out of ['dist/gone.js', 'dist/gone.d.ts', 'dist/gone.js.map']) write(join(root, pkg.dir, out), 'old\n', T0 + 10)
    expect(staleDist(root)).toEqual([{ dir: pkg.dir, reason: 'orphaned' }])
  })

  it('reports a dist whose build record a reinstall purged', () => {
    const root = makeCheckout()
    rmSync(join(root, pkg.dir, pkg.buildInfo))
    expect(staleDist(root)).toEqual([{ dir: pkg.dir, reason: 'outdated' }])
  })

  it('skips a package this checkout has no sources for', () => {
    const root = makeCheckout()
    rmSync(join(root, pkg.dir), { recursive: true })
    expect(staleDist(root)).toEqual([])
  })
})

describe('ensureDeps', { timeout: SPAWNING_TEST_TIMEOUT }, () => {
  const run = (root: string, extraEnv: Record<string, string> = {}) => {
    const pnpm = fakePnpm(extraEnv)
    return { text: ensureDeps({ root, env: pnpm.env }), calls: pnpm.readCalls() }
  }

  it('prints nothing and runs nothing when nothing is stale', () => {
    expect(run(makeCheckout())).toEqual({ text: '', calls: [] })
  })

  it('reinstalls a mismatched node_modules, rebuilds against it, and says so', () => {
    const root = makeCheckout()
    writeInstallRecord(root, 'lock: v0\n')
    const { text, calls } = run(root)
    expect(calls).toEqual([INSTALL, BUILD])
    expect(readDepsState(root)).toBe('fresh')
    expect(text).toContain('installed from a different pnpm-lock.yaml')
    expect(text).toContain(`Ran \`pnpm ${INSTALL}\`.`)
  })

  it('installs into a checkout with no node_modules', () => {
    const root = makeCheckout()
    rmSync(join(root, 'node_modules'), { recursive: true })
    const { text, calls } = run(root)
    expect(calls).toEqual([INSTALL, BUILD])
    expect(text).toContain('no install record')
  })

  it('rebuilds a stale dist without reinstalling', () => {
    const root = makeCheckout()
    rmSync(join(root, DIST_PACKAGES[0].dir, 'dist'), { recursive: true })
    const { text, calls } = run(root)
    expect(calls).toEqual([BUILD])
    expect(staleDist(root)).toEqual([])
    expect(text).toContain(`${DIST_PACKAGES[0].dir} dist was missing`)
    // The healthy package kept its build record, so tsc -b left it alone.
    expect(readFileSync(join(root, DIST_PACKAGES[1].dir, OUTPUTS[0]), 'utf8')).toBe('fixture build\n')
  })

  it('deletes the outputs of a deleted source when it rebuilds', () => {
    const root = makeCheckout()
    const [, pkg] = DIST_PACKAGES
    const orphans = ['dist/gone.js', 'dist/gone.d.ts', 'dist/gone.js.map'].map(out => join(root, pkg.dir, out))
    for (const orphan of orphans) write(orphan, 'old\n', T0 + 10)
    const { text, calls } = run(root)
    expect(calls).toEqual([BUILD])
    expect(orphans.filter(existsSync)).toEqual([])
    expect(staleDist(root)).toEqual([])
    expect(text).toContain(`${pkg.dir} dist had outputs of deleted sources`)
  })

  it('skips the build and reports the failure with pnpm\'s output when the install fails', () => {
    const root = makeCheckout()
    writeInstallRecord(root, 'lock: v0\n')
    const { text, calls } = run(root, { FAKE_PNPM_FAIL: 'install' })
    expect(calls).toEqual([INSTALL])
    expect(text).toContain(`\`pnpm ${INSTALL}\` FAILED`)
    expect(text).toContain('fake pnpm failure: the real error')
    expect(text).toContain('at frame29')
  })

  it('explains a reinstall that will repeat because the lockfile is not in the form pnpm writes', () => {
    const root = makeCheckout()
    writeInstallRecord(root, 'lock: v0\n')
    const { text, calls } = run(root, { FAKE_PNPM_REFORMAT: '1' })
    expect(calls).toEqual([INSTALL, BUILD])
    expect(text).toContain('pnpm install --lockfile-only --force')
  })

  it('leaves a checkout without pnpm-lock.yaml alone', () => {
    const root = makeCheckout()
    rmSync(join(root, 'pnpm-lock.yaml'))
    rmSync(join(root, DIST_PACKAGES[0].dir, 'dist'), { recursive: true })
    expect(run(root)).toEqual({ text: '', calls: [] })
  })

  it("as the hook, reconciles the checkout holding the session's cwd, not its own", () => {
    const root = makeCheckout()
    execFileSync('git', ['init', '-q', root])
    writeInstallRecord(root, 'lock: v0\n')
    const cwd = join(root, DIST_PACKAGES[0].dir, 'src')
    const pnpm = fakePnpm()
    const output = execFileSync(process.execPath, [join(repoRoot, 'scripts', 'ensure-deps.mjs')], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', cwd }),
      env: pnpm.env,
      encoding: 'utf8',
    })
    expect(pnpm.readCalls()).toEqual([INSTALL, BUILD])
    expect(readDepsState(root)).toBe('fresh')
    expect(JSON.parse(output).hookSpecificOutput.additionalContext).toContain(`Ran \`pnpm ${INSTALL}\`.`)
  })
})
