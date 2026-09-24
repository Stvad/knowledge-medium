import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { changedLines, deleteOnce, journalPaths, parseMutateArgs, verdictOf } from './mutate.mjs'

describe('parseMutateArgs', () => {
  const base = ['--file', 'src/a.ts', '--test', 'src/a.test.ts']

  it('resolves paths against the invoking directory', () => {
    const cfg = parseMutateArgs([...base, '--delete', 'x'], '/repo')
    expect(cfg).toMatchObject({
      file: '/repo/src/a.ts',
      test: '/repo/src/a.test.ts',
      mutation: { kind: 'delete', text: 'x' },
      baseline: true,
      testName: undefined,
    })
  })

  it('takes a test-name filter and the baseline opt-out', () => {
    const cfg = parseMutateArgs([...base, '--edit', 'sed -i "" 1d src/a.ts', '-t', 'rejects', '--no-baseline'], '/r')
    expect(cfg).toMatchObject({ mutation: { kind: 'edit' }, testName: 'rejects', baseline: false })
  })

  it('requires exactly one mutation and both paths', () => {
    expect(() => parseMutateArgs(base, '/r')).toThrow(/--delete or --edit/)
    expect(() => parseMutateArgs([...base, '--delete', 'x', '--edit', 'y'], '/r')).toThrow(/not both/)
    expect(() => parseMutateArgs(['--test', 't', '--delete', 'x'], '/r')).toThrow(/--file/)
    expect(() => parseMutateArgs(['--file', 'f', '--delete', 'x'], '/r')).toThrow(/--test/)
    expect(() => parseMutateArgs([...base, '--delete', ''], '/r')).toThrow(/empty/)
  })
})

describe('deleteOnce', () => {
  it('removes a literal that occurs exactly once', () => {
    expect(deleteOnce('a\nif (x) return\nb\n', 'if (x) return\n')).toBe('a\nb\n')
  })

  it('refuses a literal that is absent or ambiguous, saying how often it occurs', () => {
    expect(() => deleteOnce('a\nb\n', 'zzz')).toThrow(/occurs 0 times/)
    expect(() => deleteOnce('x\nx\n', 'x')).toThrow(/occurs 2 times/)
  })
})

describe('changedLines', () => {
  it('returns only the lines between the common prefix and suffix', () => {
    expect(changedLines('a\nb\nc\nd\n', 'a\nc\nd\n')).toEqual({ removed: ['b'], added: [] })
    expect(changedLines('a\nb\nc\n', 'a\nB\nc\n')).toEqual({ removed: ['b'], added: ['B'] })
  })
})

describe('verdictOf', () => {
  const file = '/r/a.test.ts'
  const report = (results: object[]) => ({ testResults: results })
  const assertion = (title: string, status: string) => ({ ancestorTitles: ['mod'], title, status })

  it('names the failing tests as the pins', () => {
    const v = verdictOf(
      report([{ name: file, status: 'failed', message: '', assertionResults: [assertion('a', 'passed'), assertion('b', 'failed')] }]),
      file,
    )
    expect(v).toEqual({ kind: 'pinned', names: ['mod > b'], passed: 1 })
  })

  it('reports unpinned when every test that ran passed', () => {
    const v = verdictOf(
      report([{ name: file, status: 'passed', message: '', assertionResults: [assertion('a', 'passed'), assertion('b', 'skipped')] }]),
      file,
    )
    expect(v).toEqual({ kind: 'unpinned', passed: 1 })
  })

  it('gives no verdict for a load failure, zero tests, or a file that did not run', () => {
    expect(
      verdictOf(report([{ name: file, status: 'failed', message: 'Parse failure', assertionResults: [] }]), file),
    ).toMatchObject({ kind: 'none', reason: expect.stringMatching(/failed to load: Parse failure/) })
    expect(
      verdictOf(report([{ name: file, status: 'passed', message: '', assertionResults: [assertion('a', 'skipped')] }]), file),
    ).toMatchObject({ kind: 'none', reason: expect.stringMatching(/no test ran/) })
    expect(verdictOf(report([]), file)).toMatchObject({ kind: 'none', reason: expect.stringMatching(/did not run/) })
  })
})

// Fixtures live outside any git repository on purpose: the helper must work
// with no git at all, and a fake `git` on PATH records any call it makes.
describe('mutate end-to-end', { timeout: 60_000 }, () => {
  const script = fileURLToPath(new URL('./mutate.mjs', import.meta.url))
  const GUARD = '  if (x === 0) return false // pinned guard\n'
  const UNPINNED = '  if (x === -5) return false // unpinned guard\n'
  const MOD = `export const ok = x => {\n${GUARD}${UNPINNED}  // uncommitted edit that must survive\n  return x > -1\n}\n`

  const fixture = () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mutate-fx-')))
    writeFileSync(join(dir, 'vitest.config.mjs'), 'export default { test: { globals: true, include: ["**/*.test.mjs"] } }\n')
    writeFileSync(join(dir, 'mod.mjs'), MOD)
    writeFileSync(
      join(dir, 'mod.test.mjs'),
      "import { ok } from './mod.mjs'\n" +
        "describe('mod', () => {\n" +
        "  it('accepts positive', () => { expect(ok(1)).toBe(true) })\n" +
        "  it('rejects zero', () => { expect(ok(0)).toBe(false) })\n" +
        '})\n',
    )
    const bin = join(dir, 'fakebin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$@" >> "${join(dir, 'git-calls')}"\nexit 1\n`)
    chmodSync(join(bin, 'git'), 0o755)
    return dir
  }
  const env = (dir: string) => {
    // INIT_CWD from an outer `pnpm test` would re-root the helper's relative paths.
    const rest = { ...process.env }
    delete rest.INIT_CWD
    return { ...rest, PATH: `${join(dir, 'fakebin')}:${process.env.PATH}` }
  }
  const mutate = (dir: string, args: string[]) =>
    spawnSync('node', [script, '--file', join(dir, 'mod.mjs'), '--test', join(dir, 'mod.test.mjs'), ...args], {
      cwd: dir,
      env: env(dir),
      encoding: 'utf8',
    })
  const lastLine = (s: string) => s.trim().split('\n').at(-1)

  it('reports PINNED with the failing test, restores the exact bytes, and never calls git', () => {
    const dir = fixture()
    const r = mutate(dir, ['--delete', GUARD])
    expect(r.status, r.stderr).toBe(0)
    expect(lastLine(r.stdout)).toBe('PINNED by: mod > rejects zero')
    expect(r.stdout).toContain('baseline: 2 passed, 0 failed')
    expect(r.stdout).toContain('- if (x === 0) return false // pinned guard')
    expect(readFileSync(join(dir, 'mod.mjs'), 'utf8')).toBe(MOD)
    expect(existsSync(join(dir, 'git-calls'))).toBe(false)
    const { journal, snapshot } = journalPaths(join(dir, 'mod.mjs'))
    expect(existsSync(journal)).toBe(false)
    expect(existsSync(snapshot)).toBe(false)
  })

  it('reports UNPINNED with a distinct exit code and restores the bytes', () => {
    const dir = fixture()
    const r = mutate(dir, ['--delete', UNPINNED, '--no-baseline'])
    expect(r.status, r.stderr).toBe(1)
    expect(lastLine(r.stdout)).toBe('UNPINNED: 2 passed, 0 failed')
    expect(readFileSync(join(dir, 'mod.mjs'), 'utf8')).toBe(MOD)
  })

  it('runs a shell edit with MUTATE_FILE and honours -t', () => {
    const dir = fixture()
    const edit = `perl -0pi -e 's/  if \\(x === 0\\) return false \\/\\/ pinned guard\\n//' "$MUTATE_FILE"`
    const r = mutate(dir, ['--edit', edit, '-t', 'accepts', '--no-baseline'])
    expect(r.status, r.stdout + r.stderr).toBe(1) // the pinning test is filtered out
    expect(lastLine(r.stdout)).toBe('UNPINNED: 1 passed, 0 failed')
    expect(readFileSync(join(dir, 'mod.mjs'), 'utf8')).toBe(MOD)
  })

  it('gives no verdict when the edit changes nothing', () => {
    const dir = fixture()
    const r = mutate(dir, ['--edit', 'true', '--no-baseline'])
    expect(r.status).toBe(2)
    expect(r.stdout + r.stderr).toMatch(/did not change/)
    expect(readFileSync(join(dir, 'mod.mjs'), 'utf8')).toBe(MOD)
  })

  it('gives no verdict and never rewrites the file when a --delete literal is ambiguous', () => {
    const dir = fixture()
    const before = statSync(join(dir, 'mod.mjs')).mtimeMs
    const r = mutate(dir, ['--delete', 'return false', '--no-baseline'])
    expect(r.status).toBe(2)
    expect(r.stdout + r.stderr).toMatch(/occurs 2 times/)
    expect(readFileSync(join(dir, 'mod.mjs'), 'utf8')).toBe(MOD)
    expect(statSync(join(dir, 'mod.mjs')).mtimeMs).toBe(before)
  })

  it('gives no verdict when the --edit command fails', () => {
    const dir = fixture()
    const r = mutate(dir, ['--edit', 'exit 3', '--no-baseline'])
    expect(r.status).toBe(2)
    expect(lastLine(r.stdout)).toMatch(/--edit command exited 3/)
  })

  it('gives no verdict for a test path that does not exist', () => {
    const dir = fixture()
    const r = spawnSync(
      'node',
      [script, '--file', join(dir, 'mod.mjs'), '--test', join(dir, 'nope.test.mjs'), '--delete', GUARD],
      { cwd: dir, env: env(dir), encoding: 'utf8' },
    )
    expect(r.status).toBe(2)
    expect(lastLine(r.stdout)).toMatch(/nope\.test\.mjs does not exist/)
  })

  it('reports a baseline that cannot load without touching the file', () => {
    const dir = fixture()
    writeFileSync(join(dir, 'mod.test.mjs'), 'this is not javascript (\n')
    const r = mutate(dir, ['--delete', GUARD])
    expect(r.status).toBe(2)
    expect(lastLine(r.stdout)).toMatch(/^NO VERDICT: baseline: .*failed to load/)
    expect(r.stdout).not.toContain('edit:')
  })

  it('exits 3 and keeps the snapshot when the restore cannot be verified', () => {
    const dir = fixture()
    const target = join(dir, 'mod.mjs')
    const { journal, snapshot } = journalPaths(target)
    try {
      const r = mutate(dir, ['--edit', 'printf x >> "$MUTATE_FILE" && chmod 444 "$MUTATE_FILE"', '--no-baseline'])
      expect(r.status).toBe(3)
      expect(lastLine(r.stdout)).toMatch(/^RESTORE FAILED/)
      expect(readFileSync(snapshot, 'utf8')).toBe(MOD)
      expect(existsSync(journal)).toBe(true)
    } finally {
      chmodSync(target, 0o644)
      rmSync(journal, { force: true })
      rmSync(snapshot, { force: true })
    }
  })

  it('refuses while another live run holds the file', () => {
    const dir = fixture()
    const target = join(dir, 'mod.mjs')
    const { journal, snapshot } = journalPaths(target)
    mkdirSync(join(journal, '..'), { recursive: true })
    writeFileSync(journal, JSON.stringify({ target, snapshot, pid: process.pid, started: 'now' }))
    try {
      const r = mutate(dir, ['--delete', GUARD, '--no-baseline'])
      expect(r.status).toBe(2)
      expect(r.stdout).toContain(`another pnpm mutate (pid ${process.pid}`)
      expect(readFileSync(target, 'utf8')).toBe(MOD)
    } finally {
      rmSync(journal, { force: true })
    }
  })

  it('clears a leftover journal whose snapshot matches the file, then runs', () => {
    const dir = fixture()
    const target = join(dir, 'mod.mjs')
    const { journal, snapshot } = journalPaths(target)
    mkdirSync(join(journal, '..'), { recursive: true })
    writeFileSync(snapshot, MOD)
    writeFileSync(journal, JSON.stringify({ target, snapshot, pid: 2 ** 22 + 7, started: 'earlier' }))
    const r = mutate(dir, ['--delete', UNPINNED, '--no-baseline'])
    expect(r.status, r.stdout).toBe(1)
    expect(existsSync(journal)).toBe(false)
  })

  it('refuses to mutate over a failing baseline', () => {
    const dir = fixture()
    writeFileSync(join(dir, 'mod.mjs'), MOD.replace('return x > -1', 'return x < -1'))
    const r = mutate(dir, ['--delete', GUARD])
    expect(r.status).toBe(2)
    expect(r.stdout + r.stderr).toMatch(/baseline: 1 passed, 1 failed/)
    expect(readFileSync(join(dir, 'mod.mjs'), 'utf8')).toBe(MOD.replace('return x > -1', 'return x < -1'))
  })

  it('gives no verdict for a mutation that breaks the module load, and restores', () => {
    const dir = fixture()
    const r = mutate(dir, ['--delete', 'export const ok = x => {\n', '--no-baseline'])
    expect(r.status).toBe(2)
    expect(r.stdout + r.stderr).toMatch(/failed to load/)
    expect(readFileSync(join(dir, 'mod.mjs'), 'utf8')).toBe(MOD)
  })

  it('refuses when an earlier run left its journal and the file differs from that snapshot', () => {
    const dir = fixture()
    const target = join(dir, 'mod.mjs')
    const { journal, snapshot } = journalPaths(target)
    mkdirSync(join(journal, '..'), { recursive: true })
    writeFileSync(snapshot, 'the real original\n')
    writeFileSync(journal, JSON.stringify({ target, snapshot, pid: 2 ** 22 + 7, started: 'earlier' }))
    try {
      const r = mutate(dir, ['--delete', GUARD, '--no-baseline'])
      expect(r.status).toBe(2)
      expect(r.stdout + r.stderr).toContain(snapshot)
      expect(readFileSync(target, 'utf8')).toBe(MOD)
      expect(readFileSync(snapshot, 'utf8')).toBe('the real original\n')
    } finally {
      rmSync(journal, { force: true })
      rmSync(snapshot, { force: true })
    }
  })

  it('restores the bytes when interrupted mid-run and exits 130', async () => {
    const dir = fixture()
    writeFileSync(
      join(dir, 'mod.test.mjs'),
      // Outlives this test's own timeout, so only a forwarded SIGINT ends it in time.
      "it('slow', async () => { await new Promise(r => setTimeout(r, 120_000)) }, 200_000)\n",
    )
    const child = spawn(
      'node',
      [script, '--file', join(dir, 'mod.mjs'), '--test', join(dir, 'mod.test.mjs'), '--delete', GUARD, '--no-baseline'],
      { cwd: dir, env: env(dir), stdio: 'ignore' },
    )
    const exited = new Promise<number | null>(res => child.on('exit', code => res(code)))
    await expect
      .poll(() => readFileSync(join(dir, 'mod.mjs'), 'utf8') !== MOD, { timeout: 20_000, interval: 50 })
      .toBe(true)
    child.kill('SIGINT')
    expect(await exited).toBe(130)
    expect(readFileSync(join(dir, 'mod.mjs'), 'utf8')).toBe(MOD)
  })
})
