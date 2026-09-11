import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { launchSessionEndSync, resolveMainRepoRoot, syncLogPath } from './bd-codex-session-end.mjs'

const created = new Set<string>()

afterEach(() => {
  for (const path of created) rmSync(path, { recursive: true, force: true })
  created.clear()
  vi.restoreAllMocks()
})

const makeGitRepo = ({ worktree = false } = {}) => {
  const main = mkdtempSync(join(tmpdir(), 'bd-codex-session-end-'))
  created.add(main)
  spawnSync('git', ['init', '-q'], { cwd: main })
  writeFileSync(join(main, 'README'), 'fixture\n')
  spawnSync('git', ['add', 'README'], { cwd: main })
  spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: main })
  if (!worktree) return { main, cwd: main }

  const checkout = join(main, 'checkout')
  spawnSync('git', ['worktree', 'add', '-q', checkout, 'HEAD'], { cwd: main })
  return { main, cwd: checkout }
}

const writeSyncFixture = (name: string, body: string) => {
  const fixture = join(mkdtempSync(join(tmpdir(), `bd-sync-fixture-${name}-`)), 'sync.mjs')
  created.add(dirname(fixture))
  writeFileSync(fixture, body)
  chmodSync(fixture, 0o755)
  return fixture
}

const waitForLog = async (path: string, text: string) => {
  await vi.waitFor(() => expect(readFileSync(path, 'utf8')).toContain(text), { timeout: 5_000, interval: 20 })
}

describe('resolveMainRepoRoot', () => {
  it('resolves the shared main root when called from a linked worktree', () => {
    const { main, cwd } = makeGitRepo({ worktree: true })
    expect(resolveMainRepoRoot({ cwd })).toBe(realpathSync(main))
  })
})

describe('launchSessionEndSync', () => {
  it('returns before the detached sync finishes and writes its stdout/stderr to the shared log', async () => {
    const { main, cwd } = makeGitRepo({ worktree: true })
    const releaseDir = mkdtempSync(join(tmpdir(), 'bd-codex-release-'))
    created.add(releaseDir)
    const release = join(releaseDir, 'release')
    const fixture = writeSyncFixture(
      'success',
      `import { existsSync, watch } from 'node:fs'\nconst release = ${JSON.stringify(release)}\nlet watcher\nlet done = false\nconst finish = () => { if (done) return; done = true; watcher?.close(); process.stdout.write('fake sync success\\n') }\nwatcher = watch(${JSON.stringify(releaseDir)}, (_, name) => { if (String(name) === 'release' && existsSync(release)) finish() })\nif (existsSync(release)) finish()\nprocess.stdout.write('fake sync ready\\n')\n`,
    )
    const launcher = writeSyncFixture(
      'parent',
      `import { launchSessionEndSync } from ${JSON.stringify(fileURLToPath(new URL('./bd-codex-session-end.mjs', import.meta.url)))}\nlaunchSessionEndSync({ cwd: ${JSON.stringify(cwd)}, syncScript: ${JSON.stringify(fixture)} })\n`,
    )
    let parentStatus: number | null = null
    let parentStderr = ''
    const parent = spawn(process.execPath, [launcher], { stdio: ['ignore', 'ignore', 'pipe'] })
    parent.stderr.on('data', chunk => { parentStderr += String(chunk) })
    parent.once('close', status => { parentStatus = status })

    const root = realpathSync(main)
    try {
      await vi.waitFor(() => expect(parentStatus, parentStderr).toBe(0), { timeout: 5_000, interval: 20 })
      expect(existsSync(syncLogPath(root))).toBe(true)
      await waitForLog(syncLogPath(root), 'fake sync ready')
      expect(readFileSync(syncLogPath(root), 'utf8')).not.toContain('fake sync success')
      writeFileSync(release, 'go\n')
      await waitForLog(syncLogPath(root), 'fake sync success')
    } finally {
      if (!existsSync(release)) writeFileSync(release, 'cleanup\n')
    }
  }, 20_000)

  it('captures a failing delegated sync in stderr-backed log output', async () => {
    const { main, cwd } = makeGitRepo()
    const fixture = writeSyncFixture(
      'failure',
      `process.stderr.write('fake sync failure\\n'); process.exitCode = 1\n`,
    )
    const result = launchSessionEndSync({ cwd, syncScript: fixture })

    expect(result.started).toBe(true)
    await waitForLog(syncLogPath(realpathSync(main)), 'fake sync failure')
  }, 20_000)

  it('uses file descriptors and unrefs the child, without probing for a Beads clone', () => {
    const { main, cwd } = makeGitRepo()
    const child = { once: vi.fn(), unref: vi.fn() }
    const spawnImpl = vi.fn(() => child)
    const result = launchSessionEndSync({ cwd, syncScript: '/tmp/fake-sync.mjs', spawnImpl })

    expect(result.started).toBe(true)
    expect(spawnImpl).toHaveBeenCalledWith(
      process.execPath,
      ['/tmp/fake-sync.mjs', '--quiet'],
      expect.objectContaining({ cwd: realpathSync(main), detached: true, stdio: ['ignore', expect.any(Number), expect.any(Number)] }),
    )
    expect(child.unref).toHaveBeenCalledOnce()
    expect(existsSync(join(main, '.beads', 'embeddeddolt'))).toBe(false)
  })

  it('reports launch failures on stderr and preserves the failure in the log', () => {
    const { main, cwd } = makeGitRepo()
    const error = new Error('fixture spawn failed')
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = launchSessionEndSync({ cwd, syncScript: '/tmp/fake-sync.mjs', spawnImpl: () => { throw error } })

    expect(result.started).toBe(false)
    expect(stderr).toHaveBeenCalledWith('bd-codex-session-end: failed — fixture spawn failed')
    expect(readFileSync(syncLogPath(realpathSync(main)), 'utf8')).toContain('bd-codex-session-end: failed — fixture spawn failed')
  })
})
