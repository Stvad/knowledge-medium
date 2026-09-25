import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { tempDirs } from './hook-test-support'
import { changedLines, deleteOnce, parseMutateArgs, statePaths, verdictOf } from './mutate.mjs'

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
      timeoutMs: 300_000,
    })
  })

  it('takes a test-name filter, the baseline opt-out and a timeout', () => {
    const cfg = parseMutateArgs([...base, '--edit', 'true', '-t', 'rejects', '--no-baseline', '--timeout', '2'], '/r')
    expect(cfg).toMatchObject({ mutation: { kind: 'edit' }, testName: 'rejects', baseline: false, timeoutMs: 2000 })
  })

  it('requires exactly one mutation, both paths, and a positive timeout', () => {
    expect(() => parseMutateArgs(base, '/r')).toThrow(/--delete or --edit/)
    expect(() => parseMutateArgs([...base, '--delete', 'x', '--edit', 'y'], '/r')).toThrow(/not both/)
    expect(() => parseMutateArgs(['--test', 't', '--delete', 'x'], '/r')).toThrow(/--file/)
    expect(() => parseMutateArgs(['--file', 'f', '--delete', 'x'], '/r')).toThrow(/--test/)
    expect(() => parseMutateArgs([...base, '--delete', ''], '/r')).toThrow(/empty/)
    expect(() => parseMutateArgs([...base, '--delete', 'x', '--timeout', '0'], '/r')).toThrow(/--timeout/)
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
  const assertion = (title: string, status: string, failureMessages: string[] = []) => ({
    ancestorTitles: ['mod'],
    title,
    status,
    failureMessages,
  })

  it('names the failing tests as the pins, with each first failure line', () => {
    const v = verdictOf(
      report([
        {
          name: file,
          status: 'failed',
          message: '',
          assertionResults: [assertion('a', 'passed'), assertion('b', 'failed', ['expected 1 to be 2\n  at x'])],
        },
      ]),
      file,
    )
    expect(v).toEqual({ kind: 'pinned', names: ['mod > b'], failures: ['mod > b: expected 1 to be 2'], passed: 1 })
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
    ).toMatchObject({ kind: 'none', reason: expect.stringMatching(/failed to load: Parse failure/), loadFailed: true })
    expect(
      verdictOf(report([{ name: file, status: 'passed', message: '', assertionResults: [assertion('a', 'skipped')] }]), file),
    ).toMatchObject({ kind: 'none', reason: expect.stringMatching(/no test ran/) })
    expect(verdictOf(report([]), file)).toMatchObject({ kind: 'none', reason: expect.stringMatching(/did not run/) })
  })
})

// Fixtures live outside any git repository on purpose: the helper must work
// with no git at all, and a fake `git` on PATH records any call it makes. Each
// fixture is its own checkout, so its lock and state live in its own tmp/.
describe('mutate end-to-end', { timeout: 60_000 }, () => {
  const script = fileURLToPath(new URL('./mutate.mjs', import.meta.url))
  const tmp = tempDirs()
  const GUARD = '  if (x === 0) return false // pinned guard\n'
  const UNPINNED = '  if (x === -5) return false // unpinned guard\n'
  const MOD = `export const ok = x => {\n${GUARD}${UNPINNED}  // uncommitted edit that must survive\n  return x > -1\n}\n`
  const MOD_TEST =
    "import { ok } from './mod.mjs'\n" +
    "describe('mod', () => {\n" +
    "  it('accepts positive', () => { expect(ok(1)).toBe(true) })\n" +
    "  it('rejects zero', () => { expect(ok(0)).toBe(false) })\n" +
    '})\n'

  const fixture = (testBody = MOD_TEST) => {
    const dir = tmp('mutate-fx-')
    writeFileSync(join(dir, 'vitest.config.mjs'), 'export default { test: { globals: true, include: ["**/*.test.mjs"] } }\n')
    writeFileSync(join(dir, 'mod.mjs'), MOD)
    writeFileSync(join(dir, 'mod.test.mjs'), testBody)
    mkdirSync(join(dir, 'fakebin'))
    writeFileSync(join(dir, 'fakebin', 'git'), `#!/bin/sh\necho "$@" >> "${join(dir, 'git-calls')}"\nexit 1\n`)
    chmodSync(join(dir, 'fakebin', 'git'), 0o755)
    return dir
  }
  const env = (dir: string) => {
    // INIT_CWD from an outer `pnpm test` would re-root the helper's relative paths.
    const rest = { ...process.env }
    delete rest.INIT_CWD
    return { ...rest, PATH: `${join(dir, 'fakebin')}:${process.env.PATH}` }
  }
  const argv = (dir: string, args: string[], file = 'mod.mjs') => [
    script,
    '--file',
    join(dir, file),
    '--test',
    join(dir, 'mod.test.mjs'),
    ...args,
  ]
  // The timeout turns a mutate that never exits into a failure, not a hung suite:
  // spawnSync blocks the worker, so vitest's own test timeout cannot fire. SIGKILL,
  // because a stuck mutate handles SIGTERM by waiting on the child it is stuck on.
  const mutate = (dir: string, args: string[], file?: string) =>
    spawnSync('node', argv(dir, args, file), {
      cwd: dir,
      env: env(dir),
      encoding: 'utf8',
      timeout: 40_000,
      killSignal: 'SIGKILL',
    })
  const lastLine = (s: string) => s.trim().split('\n').at(-1)
  const mod = (dir: string) => readFileSync(join(dir, 'mod.mjs'), 'utf8')
  const paths = (dir: string) => statePaths(dir, join(dir, 'mod.mjs'))

  it('reports PINNED with the failing test, restores the exact bytes, and never calls git', () => {
    const dir = fixture()
    const r = mutate(dir, ['--delete', GUARD])
    expect(r.status, r.stdout).toBe(0)
    expect(lastLine(r.stdout)).toBe('PINNED by: mod > rejects zero')
    expect(r.stdout).toContain('baseline: 2 passed, 0 failed')
    expect(r.stdout).toContain('- if (x === 0) return false // pinned guard')
    expect(r.stdout).toMatch(/mod > rejects zero: .*expected true to be false/i)
    expect(mod(dir)).toBe(MOD)
    expect(existsSync(join(dir, 'git-calls'))).toBe(false)
    expect(readdirSync(paths(dir).dir)).toEqual([]) // lock, journal and snapshot all removed
    expect(statSync(paths(dir).dir).mode & 0o777).toBe(0o700)
  })

  it('runs a shell edit with MUTATE_FILE, honours -t, and reports UNPINNED', () => {
    const dir = fixture()
    const edit = `perl -0pi -e 's/  if \\(x === 0\\) return false \\/\\/ pinned guard\\n//' "$MUTATE_FILE"`
    const r = mutate(dir, ['--edit', edit, '-t', 'accepts', '--no-baseline'])
    expect(r.status, r.stdout).toBe(1) // the pinning test is filtered out
    expect(lastLine(r.stdout)).toBe('UNPINNED: 1 passed, 0 failed')
    expect(mod(dir)).toBe(MOD)
  })

  it('gives no verdict when the tested file never loads the mutated one', () => {
    const dir = fixture()
    writeFileSync(join(dir, 'other.mjs'), 'export const unused = 1\n')
    const r = mutate(dir, ['--delete', 'export const unused = 1\n', '--no-baseline'], 'other.mjs')
    expect(r.status, r.stdout).toBe(2)
    expect(lastLine(r.stdout)).toMatch(/other\.mjs is not loaded by mod\.test\.mjs/)
    expect(readFileSync(join(dir, 'other.mjs'), 'utf8')).toBe('export const unused = 1\n')
  })

  it('gives no verdict when the edit changes nothing, or its command fails', () => {
    const dir = fixture()
    expect(lastLine(mutate(dir, ['--edit', 'true', '--no-baseline']).stdout)).toMatch(/did not change/)
    const failed = mutate(dir, ['--edit', 'exit 3', '--no-baseline'])
    expect(failed.status).toBe(2)
    expect(lastLine(failed.stdout)).toMatch(/--edit command exited 3/)
    expect(mod(dir)).toBe(MOD)
  })

  it('refuses an ambiguous --delete literal before any test run, never rewriting the file', () => {
    const dir = fixture()
    const before = statSync(join(dir, 'mod.mjs')).mtimeMs
    const r = mutate(dir, ['--delete', 'return false'])
    expect(r.status).toBe(2)
    expect(lastLine(r.stdout)).toMatch(/occurs 2 times/)
    expect(r.stdout).not.toContain('baseline:')
    expect(statSync(join(dir, 'mod.mjs')).mtimeMs).toBe(before)
  })

  it('gives no verdict for a path that does not exist or lies outside the checkout', () => {
    const dir = fixture()
    const missing = spawnSync('node', [script, '--file', join(dir, 'mod.mjs'), '--test', join(dir, 'nope.test.mjs'), '--delete', GUARD], {
      cwd: dir,
      env: env(dir),
      encoding: 'utf8',
    })
    expect(missing.status).toBe(2)
    expect(lastLine(missing.stdout)).toMatch(/nope\.test\.mjs does not exist/)
    const elsewhere = fixture()
    const outside = spawnSync('node', argv(elsewhere, ['--delete', GUARD]), { cwd: dir, env: env(dir), encoding: 'utf8' })
    expect(outside.status).toBe(2)
    expect(lastLine(outside.stdout)).toMatch(/is outside .*, the checkout vitest runs in/)
    expect(mod(elsewhere)).toBe(MOD)
  })

  it('refuses to mutate over a failing baseline or one that cannot load', () => {
    const dir = fixture()
    writeFileSync(join(dir, 'mod.mjs'), MOD.replace('return x > -1', 'return x < -1'))
    const failing = mutate(dir, ['--delete', GUARD])
    expect(failing.status).toBe(2)
    expect(failing.stdout).toMatch(/baseline: 1 passed, 1 failed/)
    expect(mod(dir)).toBe(MOD.replace('return x > -1', 'return x < -1'))

    const broken = fixture('this is not javascript (\n')
    const r = mutate(broken, ['--delete', GUARD])
    expect(lastLine(r.stdout)).toMatch(/^NO VERDICT: baseline: .*failed to load/)
    expect(r.stdout).not.toContain('edit:')
  })

  it('gives no verdict when vitest fails the run with every test passed', () => {
    const dir = fixture(
      "import { ok } from './mod.mjs'\n" +
        "it('passes, but leaks a rejection', () => { Promise.reject(new Error('leak')); expect(ok(1)).toBe(true) })\n",
    )
    const r = mutate(dir, ['--delete', UNPINNED, '--no-baseline'])
    expect(r.status, r.stdout).toBe(2)
    expect(lastLine(r.stdout)).toMatch(/^NO VERDICT: vitest exited 1 though no test failed/)
    expect(mod(dir)).toBe(MOD)
  })

  it('kills a run that outlives --timeout and restores the file', () => {
    const dir = fixture("import './mod.mjs'\nit('spins', () => { for (;;) {} })\n")
    const r = mutate(dir, ['--delete', UNPINNED, '--no-baseline', '--timeout', '1'])
    expect(r.status, r.stdout).toBe(2)
    expect(lastLine(r.stdout)).toMatch(/did not finish within 1s/)
    expect(mod(dir)).toBe(MOD)
  })

  it('saves bytes written during the run aside, restores, and exits 3', () => {
    const dir = fixture(
      "import { appendFileSync } from 'node:fs'\nimport './mod.mjs'\n" +
        "it('edits its own target', () => { appendFileSync(new URL('./mod.mjs', import.meta.url), '// during run\\n') })\n",
    )
    const r = mutate(dir, ['--delete', UNPINNED, '--no-baseline'])
    expect(r.status, r.stdout).toBe(3)
    expect(lastLine(r.stdout)).toMatch(/^CHANGED DURING RUN: mod\.mjs/)
    expect(mod(dir)).toBe(MOD)
    expect(readFileSync(paths(dir).duringRun, 'utf8')).toMatch(/\/\/ during run\n$/)

  })

  it('stops before an --edit when the baseline run changed the file', () => {
    // Only the first run of the test file (the baseline) writes the target.
    const dir = fixture(
      "import { appendFileSync, existsSync, writeFileSync } from 'node:fs'\nimport './mod.mjs'\n" +
        "const marker = new URL('./wrote-once', import.meta.url)\n" +
        "it('edits its target once', () => { if (!existsSync(marker)) { writeFileSync(marker, ''); appendFileSync(new URL('./mod.mjs', import.meta.url), '// during baseline\\n') } })\n",
    )
    const r = mutate(dir, ['--edit', 'printf "// mutated\\n" >> "$MUTATE_FILE"'])
    expect(r.status, r.stdout).toBe(3)
    expect(lastLine(r.stdout)).toMatch(/^CHANGED DURING RUN/)
    expect(r.stdout).not.toContain('edit:')
    expect(readFileSync(paths(dir).duringRun, 'utf8')).toMatch(/\/\/ during baseline\n$/)
    expect(mod(dir)).toBe(MOD)
  })

  it('exits 3 and keeps the snapshot when the restore cannot be verified', () => {
    const dir = fixture()
    try {
      const r = mutate(dir, ['--edit', 'printf x >> "$MUTATE_FILE" && chmod 444 "$MUTATE_FILE"', '--no-baseline'])
      expect(r.status).toBe(3)
      expect(lastLine(r.stdout)).toMatch(/^RESTORE FAILED/)
      expect(readFileSync(paths(dir).snapshot, 'utf8')).toBe(MOD)
      expect(existsSync(paths(dir).journal)).toBe(true)
    } finally {
      chmodSync(join(dir, 'mod.mjs'), 0o644)
    }
  })

  it('refuses while another live run holds the checkout, and takes over a dead one', () => {
    const dir = fixture()
    const { dir: stateDir, lock } = paths(dir)
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(lock, JSON.stringify({ pid: process.pid, started: 'now' }))
    const r = mutate(dir, ['--edit', 'true', '--no-baseline'])
    expect(r.status).toBe(2)
    expect(lastLine(r.stdout)).toContain(`another pnpm mutate (pid ${process.pid}`)

    writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 7, started: 'earlier' }))
    expect(lastLine(mutate(dir, ['--edit', 'true', '--no-baseline']).stdout)).toMatch(/did not change/)
    expect(existsSync(lock)).toBe(false)
  })

  it('refuses when an earlier run left its journal and the file differs from that snapshot', () => {
    const dir = fixture()
    const { dir: stateDir, journal, snapshot } = paths(dir)
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(snapshot, 'the real original\n')
    writeFileSync(journal, JSON.stringify({ pid: 2 ** 22 + 7, started: 'earlier' }))
    const r = mutate(dir, ['--delete', GUARD, '--no-baseline'])
    expect(r.status).toBe(2)
    expect(r.stdout).toContain(snapshot)
    expect(mod(dir)).toBe(MOD)
    expect(readFileSync(snapshot, 'utf8')).toBe('the real original\n')
  })

  it('clears a leftover journal whose snapshot matches the file, then runs', () => {
    const dir = fixture()
    const { dir: stateDir, journal, snapshot } = paths(dir)
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(snapshot, MOD)
    writeFileSync(journal, JSON.stringify({ pid: 2 ** 22 + 7, started: 'earlier' }))
    expect(lastLine(mutate(dir, ['--edit', 'true', '--no-baseline']).stdout)).toMatch(/did not change/)
    expect(existsSync(journal)).toBe(false)
  })

  it('restores the bytes when interrupted mid-run and exits 130', async () => {
    // Outlives this test's own timeout, so only a SIGINT forwarded to vitest's
    // whole process group ends it in time.
    const dir = fixture("it('slow', async () => { await new Promise(r => setTimeout(r, 120_000)) }, 200_000)\n")
    const child = spawn('node', argv(dir, ['--delete', GUARD, '--no-baseline']), { cwd: dir, env: env(dir), stdio: 'ignore' })
    const exited = new Promise<number | null>(res => child.on('exit', code => res(code)))
    await expect.poll(() => mod(dir) !== MOD, { timeout: 20_000, interval: 50 }).toBe(true)
    child.kill('SIGINT')
    expect(await exited).toBe(130)
    expect(mod(dir)).toBe(MOD)
  })
})
