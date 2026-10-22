import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BUILD_ARGS,
  DIST_PACKAGES,
  FROZEN_INSTALL_ARGS,
  ensureDeps,
  lockfileBehindBase,
  readDepsState,
  staleDist,
  stateDir,
} from './ensure-deps.mjs'

// Every ensureDeps case spawns the detached job plus a PATH-fronted pnpm: two
// node startups, ~150ms alone and several times that under the gate's load.
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

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
    cwd,
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

const commitLockfile = (root: string, content: string) => {
  write(join(root, 'pnpm-lock.yaml'), content)
  git(root, 'add', 'pnpm-lock.yaml')
  git(root, 'commit', '-qm', `lockfile ${content.trim()}`)
  return git(root, 'rev-parse', 'HEAD')
}

const writeInstallRecord = (root: string, content: string, mtimeSec?: number) =>
  write(join(root, 'node_modules', '.pnpm', 'lock.yaml'), content, mtimeSec)

// Sources at T0, the build record after them: what a finished `tsc -b` leaves.
const writeFreshDist = (root: string) => {
  for (const pkg of DIST_PACKAGES) {
    write(join(root, pkg.dir, 'tsconfig.json'), '{}\n', T0)
    write(join(root, pkg.dir, 'src', 'index.ts'), 'export {}\n', T0)
    write(join(root, pkg.dir, pkg.entry), 'built\n', T0 + 10)
    write(join(root, pkg.dir, pkg.buildInfo), '{}\n', T0 + 10)
  }
}

/** A git checkout whose install record and dists already match it. */
const makeCheckout = (lockfile = 'lock: v1\n') => {
  const root = tempDir('ensure-deps-')
  git(root, 'init', '-q', '-b', 'work')
  commitLockfile(root, lockfile)
  writeInstallRecord(root, lockfile)
  writeFreshDist(root)
  return root
}

/**
 * A PATH-fronted `pnpm` that does what the real one leaves behind: `install`
 * writes the install record from the lockfile, the build writes every dist
 * entry and build record. Each call is appended to `calls`. FAKE_PNPM_FAIL
 * names a command prefix to fail with exit 3; FAKE_PNPM_RELEASE holds the
 * command until that file exists.
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
const finish = () => {
  if (process.env.FAKE_PNPM_FAIL && args.startsWith(process.env.FAKE_PNPM_FAIL)) {
    process.stderr.write('fake pnpm failure\\n')
    process.exitCode = 3
    return
  }
  if (args.startsWith('install')) {
    fs.mkdirSync('node_modules/.pnpm', { recursive: true })
    fs.copyFileSync('pnpm-lock.yaml', 'node_modules/.pnpm/lock.yaml')
  }
  if (args === ${JSON.stringify(BUILD_ARGS.join(' '))}) {
    for (const pkg of ${JSON.stringify(DIST_PACKAGES)}) {
      for (const out of [pkg.entry, pkg.buildInfo]) {
        fs.mkdirSync(path.dirname(path.join(pkg.dir, out)), { recursive: true })
        fs.writeFileSync(path.join(pkg.dir, out), 'built\\n')
      }
    }
  }
  process.stdout.write('fake pnpm ' + args + ' ok\\n')
}
const release = process.env.FAKE_PNPM_RELEASE
if (!release) finish()
else {
  const poll = setInterval(() => { if (fs.existsSync(release)) { clearInterval(poll); finish() } }, 10)
  setTimeout(() => process.exit(1), 60_000).unref()
}
`,
  )
  chmodSync(join(bin, 'pnpm'), 0o755)
  const env = { ...process.env, ...extraEnv, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` }
  const readCalls = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [])
  return { env, readCalls }
}

/** ensureDeps in a process of its own, standing in for the hook the host spawns. */
const runHookProcess = (root: string, env: NodeJS.ProcessEnv, waitMs: number, { detached = false } = {}) => {
  const launcher = join(tempDir('ensure-deps-hook-'), 'hook.mjs')
  writeFileSync(
    launcher,
    `import { ensureDeps } from ${JSON.stringify(fileURLToPath(new URL('./ensure-deps.mjs', import.meta.url)))}
process.stdout.write(await ensureDeps({ root: ${JSON.stringify(root)}, waitMs: ${waitMs} }))
`,
  )
  let status: number | null | undefined
  let stdout = ''
  const child = spawn(process.execPath, [launcher], { env, detached, stdio: ['ignore', 'pipe', 'inherit'] })
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.once('close', code => { status = code })
  return { pid: child.pid!, status: () => status, stdout: () => stdout }
}

const lastLine = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').at(-1) : undefined)

const INSTALL = FROZEN_INSTALL_ARGS.join(' ')
const BUILD = BUILD_ARGS.join(' ')
const lockPath = (root: string) => join(stateDir(root), 'lock')
const logPath = (root: string) => join(stateDir(root), 'log')

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

  it('reports a dist whose entry point is gone while its build record survives', () => {
    const root = makeCheckout()
    rmSync(join(root, pkg.dir, 'dist'), { recursive: true })
    expect(staleDist(root)).toEqual([{ dir: pkg.dir, reason: 'missing' }])
  })

  it.each(['src/nested/deep.ts', 'tsconfig.json'])('reports a dist older than its input %s', input => {
    const root = makeCheckout()
    write(join(root, pkg.dir, input), 'changed\n', T0 + 20)
    expect(staleDist(root)).toEqual([{ dir: pkg.dir, reason: 'outdated' }])
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

describe('lockfileBehindBase', () => {
  // origin/master moved the lockfile on from where this branch forked.
  const forkBehindMaster = () => {
    const root = makeCheckout('lock: v1\n')
    const fork = git(root, 'rev-parse', 'HEAD')
    const master = commitLockfile(root, 'lock: v2\n')
    git(root, 'update-ref', 'refs/remotes/origin/master', master)
    git(root, 'checkout', '-q', fork)
    return root
  }

  it('is true when master changed the lockfile since the fork and the branch did not', () => {
    expect(lockfileBehindBase(forkBehindMaster())).toBe(true)
  })

  it('is false when the branch changed its own lockfile', () => {
    const root = forkBehindMaster()
    write(join(root, 'pnpm-lock.yaml'), 'lock: v3\n')
    expect(lockfileBehindBase(root)).toBe(false)
  })

  it('is false when the branch has master\'s lockfile', () => {
    const root = makeCheckout()
    git(root, 'update-ref', 'refs/remotes/origin/master', 'HEAD')
    expect(lockfileBehindBase(root)).toBe(false)
  })

  it('is false when there is no base ref to compare with', () => {
    expect(lockfileBehindBase(makeCheckout())).toBe(false)
  })
})

describe('ensureDeps', { timeout: SPAWNING_TEST_TIMEOUT }, () => {
  it('prints nothing and runs nothing when nothing is stale', async () => {
    const root = makeCheckout()
    const pnpm = fakePnpm()
    expect(await ensureDeps({ root, env: pnpm.env })).toBe('')
    expect(pnpm.readCalls()).toEqual([])
    expect(existsSync(stateDir(root))).toBe(false)
  })

  it('reinstalls a mismatched node_modules and says so', async () => {
    const root = makeCheckout()
    writeInstallRecord(root, 'lock: v0\n')
    const pnpm = fakePnpm()
    const text = await ensureDeps({ root, env: pnpm.env })
    expect(pnpm.readCalls()).toEqual([INSTALL])
    expect(readDepsState(root)).toBe('fresh')
    expect(text).toContain('installed from a different pnpm-lock.yaml')
    expect(text).toContain(`\`pnpm ${INSTALL}\``)
    expect(text).toContain('finished before this session started')
    expect(existsSync(lockPath(root))).toBe(false)
  })

  it('installs into a checkout with no node_modules', async () => {
    const root = makeCheckout()
    rmSync(join(root, 'node_modules'), { recursive: true })
    const pnpm = fakePnpm()
    const text = await ensureDeps({ root, env: pnpm.env })
    expect(pnpm.readCalls()).toEqual([INSTALL])
    expect(text).toContain('no install record')
  })

  it('rebuilds a stale dist without reinstalling', async () => {
    const root = makeCheckout()
    rmSync(join(root, DIST_PACKAGES[0].dir, 'dist'), { recursive: true })
    const pnpm = fakePnpm()
    const text = await ensureDeps({ root, env: pnpm.env })
    expect(pnpm.readCalls()).toEqual([BUILD])
    expect(staleDist(root)).toEqual([])
    expect(text).toContain(`${DIST_PACKAGES[0].dir} dist was missing`)
  })

  it('installs before it builds when both are stale', async () => {
    const root = makeCheckout()
    writeInstallRecord(root, 'lock: v0\n')
    write(join(root, DIST_PACKAGES[0].dir, 'src', 'index.ts'), 'changed\n', T0 + 20)
    const pnpm = fakePnpm()
    const text = await ensureDeps({ root, env: pnpm.env })
    expect(pnpm.readCalls()).toEqual([INSTALL, BUILD])
    expect(text).toContain(`${DIST_PACKAGES[0].dir} dist was older than its sources`)
  })

  it('skips the build and reports the failure when the install fails', async () => {
    const root = makeCheckout()
    writeInstallRecord(root, 'lock: v0\n')
    rmSync(join(root, DIST_PACKAGES[0].dir, 'dist'), { recursive: true })
    const pnpm = fakePnpm({ FAKE_PNPM_FAIL: 'install' })
    const text = await ensureDeps({ root, env: pnpm.env })
    expect(pnpm.readCalls()).toEqual([INSTALL])
    expect(text).toContain('FAILED')
    expect(text).toContain(logPath(root))
    expect(readFileSync(logPath(root), 'utf8')).toContain('fake pnpm failure')
    expect(existsSync(lockPath(root))).toBe(false)
  })

  it('leaves a slow install running in the background and says where its log is', async () => {
    const root = makeCheckout()
    writeInstallRecord(root, 'lock: v0\n')
    const release = join(tempDir('ensure-deps-release-'), 'release')
    const pnpm = fakePnpm({ FAKE_PNPM_RELEASE: release })
    try {
      const text = await ensureDeps({ root, env: pnpm.env, waitMs: 100 })
      expect(text).toContain('still running in the background')
      expect(text).toContain(logPath(root))
      expect(existsSync(lockPath(root))).toBe(true)
    } finally {
      writeFileSync(release, 'go\n')
    }
    await vi.waitFor(() => expect(existsSync(lockPath(root))).toBe(false), { timeout: 10_000, interval: 20 })
    expect(readDepsState(root)).toBe('fresh')
    expect(readFileSync(logPath(root), 'utf8').trim().split('\n').at(-1)).toBe('[ensure-deps] done')
  })

  it('records the job, not the hook, as the lock holder', async () => {
    const root = makeCheckout()
    writeInstallRecord(root, 'lock: v0\n')
    const release = join(tempDir('ensure-deps-release-'), 'release')
    try {
      const text = await ensureDeps({ root, env: fakePnpm({ FAKE_PNPM_RELEASE: release }).env, waitMs: 100 })
      const holder = readFileSync(lockPath(root), 'utf8')
      expect(holder).not.toBe(String(process.pid))
      expect(text).toContain(`(pid ${holder})`)
    } finally {
      writeFileSync(release, 'go\n')
    }
    await vi.waitFor(() => expect(existsSync(lockPath(root))).toBe(false), { timeout: 10_000, interval: 20 })
  })

  it('lets the hook process exit while the job keeps running', async () => {
    const root = makeCheckout()
    writeInstallRecord(root, 'lock: v0\n')
    const release = join(tempDir('ensure-deps-release-'), 'release')
    const hook = runHookProcess(root, fakePnpm({ FAKE_PNPM_RELEASE: release }).env, 100)
    try {
      await vi.waitFor(() => expect(hook.status()).toBe(0), { timeout: 10_000, interval: 20 })
      expect(hook.stdout()).toContain('still running in the background')
      expect(existsSync(lockPath(root))).toBe(true)
    } finally {
      writeFileSync(release, 'go\n')
    }
    await vi.waitFor(() => expect(lastLine(logPath(root))).toBe('[ensure-deps] done'), { timeout: 10_000, interval: 20 })
  })

  it('finishes the job when the hook is killed along with its process group', async () => {
    const root = makeCheckout()
    writeInstallRecord(root, 'lock: v0\n')
    const release = join(tempDir('ensure-deps-release-'), 'release')
    const hook = runHookProcess(root, fakePnpm({ FAKE_PNPM_RELEASE: release }).env, 10_000, { detached: true })
    try {
      // The job is up once the lock names it instead of the hook.
      await vi.waitFor(() => {
        expect(existsSync(lockPath(root))).toBe(true)
        expect(readFileSync(lockPath(root), 'utf8')).not.toBe(String(hook.pid))
      }, { timeout: 10_000, interval: 20 })
      process.kill(-hook.pid, 'SIGKILL')
      await vi.waitFor(() => expect(hook.status()).not.toBe(undefined), { timeout: 10_000, interval: 20 })
    } finally {
      writeFileSync(release, 'go\n')
    }
    await vi.waitFor(() => expect(lastLine(logPath(root))).toBe('[ensure-deps] done'), { timeout: 10_000, interval: 20 })
  })

  it('takes over an empty lock file', async () => {
    const root = makeCheckout()
    writeInstallRecord(root, 'lock: v0\n')
    write(lockPath(root), '')
    const pnpm = fakePnpm()
    await ensureDeps({ root, env: pnpm.env })
    expect(pnpm.readCalls()).toEqual([INSTALL])
  })

  it('does not start a second job while one is running', async () => {
    const root = makeCheckout()
    writeInstallRecord(root, 'lock: v0\n')
    write(lockPath(root), String(process.pid))
    const pnpm = fakePnpm()
    const text = await ensureDeps({ root, env: pnpm.env })
    expect(pnpm.readCalls()).toEqual([])
    expect(text).toContain(`already running (pid ${process.pid})`)
  })

  it('takes over the lock of a job that died', async () => {
    const root = makeCheckout()
    writeInstallRecord(root, 'lock: v0\n')
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!
    write(lockPath(root), String(dead))
    const pnpm = fakePnpm()
    await ensureDeps({ root, env: pnpm.env })
    expect(pnpm.readCalls()).toEqual([INSTALL])
  })

  it('warns that a reinstall cannot fix a branch whose lockfile is behind master', async () => {
    const root = makeCheckout('lock: v1\n')
    const fork = git(root, 'rev-parse', 'HEAD')
    git(root, 'update-ref', 'refs/remotes/origin/master', commitLockfile(root, 'lock: v2\n'))
    // The directory last installed master's dependency set; this branch is older.
    writeInstallRecord(root, 'lock: v2\n')
    git(root, 'checkout', '-q', fork)
    const pnpm = fakePnpm()
    const text = await ensureDeps({ root, env: pnpm.env })
    expect(pnpm.readCalls()).toEqual([INSTALL])
    expect(text).toContain('behind origin/master')
    expect(text).toContain('rebase')
  })

  it('does not warn about the base when only a dist was rebuilt', async () => {
    const root = makeCheckout('lock: v1\n')
    const fork = git(root, 'rev-parse', 'HEAD')
    git(root, 'update-ref', 'refs/remotes/origin/master', commitLockfile(root, 'lock: v2\n'))
    git(root, 'checkout', '-q', fork)
    writeInstallRecord(root, 'lock: v1\n')
    rmSync(join(root, DIST_PACKAGES[0].dir, 'dist'), { recursive: true })
    expect(lockfileBehindBase(root)).toBe(true)
    const text = await ensureDeps({ root, env: fakePnpm().env })
    expect(text).toContain('finished before this session started')
    expect(text).not.toContain('behind origin/master')
  })

  it('leaves a checkout without pnpm-lock.yaml alone', async () => {
    const root = makeCheckout()
    rmSync(join(root, 'pnpm-lock.yaml'))
    rmSync(join(root, DIST_PACKAGES[0].dir, 'dist'), { recursive: true })
    const pnpm = fakePnpm()
    expect(await ensureDeps({ root, env: pnpm.env })).toBe('')
    expect(pnpm.readCalls()).toEqual([])
  })

  it('does not warn about the base when the branch is level with it', async () => {
    const root = makeCheckout()
    git(root, 'update-ref', 'refs/remotes/origin/master', 'HEAD')
    writeInstallRecord(root, 'lock: v0\n')
    const text = await ensureDeps({ root, env: fakePnpm().env })
    expect(text).toContain('finished before this session started')
    expect(text).not.toContain('behind origin/master')
  })
})
