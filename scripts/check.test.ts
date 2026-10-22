import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { acquireSlot, clearStaleSlot, loadVerdict, type SlotHolder } from './check.mjs'

// Far past what a pipe holds before the reader takes it: at 200 lines a gate
// that exits on its own output still delivers all of them, and the test loses
// its teeth without saying so.
const RELAYED_LINES = 4000

// A PATH-fronted `pnpm`, so the real gate runs its real control flow over
// tasks whose behaviour each test picks through SHIM_MODE. Every task not
// named below exits 0. `process.exitCode` in the shim so the shim is not
// itself the thing that truncates.
const temps: string[] = []
const tempDir = (prefix: string) => {
  temps.push(mkdtempSync(join(tmpdir(), prefix)))
  return temps.at(-1)!
}
afterAll(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const holder = (pid = process.pid, worktree = 'this-wt', branch = 'this-branch'): SlotHolder =>
  ({ pid, worktree, branch, startedAt: Date.now() })
const quiet = () => {}
const slotFile = (dir: string, i = 0) => join(dir, `slot-${i}`)
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid

const bin = tempDir('check-gate-')
writeFileSync(
  join(bin, 'pnpm'),
  `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const [cmd, ...files] = process.argv.slice(2).join(' ').startsWith('run test')
  ? ['run test', ...process.argv.slice(4)]
  : [process.argv.slice(2).join(' ')]
const mode = process.env.SHIM_MODE
if (cmd === 'run test' && mode?.startsWith('flood')) {
  const out = mode === 'flood-stderr' ? process.stderr : process.stdout
  for (let i = 0; i < ${RELAYED_LINES}; i++) out.write(\`line \${i} \${'x'.repeat(60)}\\n\`)
  process.exitCode = 1
}
if (cmd === 'run test' && mode === 'slow') {
  appendFileSync(process.env.SHIM_LOG, 'start\\n')
  setTimeout(() => appendFileSync(process.env.SHIM_LOG, 'end\\n'), 1500)
}
if (cmd === 'run test' && mode === 'mixed') {
  // The whole suite fails a load-only file and a real one; re-run one file at
  // a time, only the real one still fails.
  const alone = files.includes('--no-file-parallelism')
  const failing = alone ? ['scripts/real.test.ts'] : ['scripts/slow.test.ts', 'scripts/real.test.ts']
  for (const file of failing) process.stdout.write(\` FAIL  \${file} > a test\\nError: boom\\n\`)
  process.exitCode = 1
}
if (cmd === 'run test' && mode === 'many' && !files.length) {
  for (let i = 0; i < 26; i++) process.stdout.write(\` FAIL  scripts/f\${i}.test.ts > a test\\n\`)
  process.exitCode = 1
}
if (mode === 'interrupt') {
  // The suite fails at once while lint is still winding down; the re-run would
  // take a while.
  if (cmd === 'run test' && !files.length) {
    process.stdout.write(' FAIL  scripts/slow.test.ts > a test\\n')
    process.exitCode = 1
  } else if (cmd === 'run lint' || cmd === 'run test') {
    const keepAlive = setTimeout(() => {}, 10_000)
    if (cmd === 'run lint') process.on('SIGTERM', () => setTimeout(() => clearTimeout(keepAlive), 3_000))
  }
}
`,
)
chmodSync(join(bin, 'pnpm'), 0o755)

// Deliberately slow: a writer's queued pipe writes only outlive it when the
// reader is behind, which in CI is just a loaded box. Draining eagerly hides
// the truncation and reordering these assert against.
const slowly = (d: string) => {
  const until = Date.now() + 30
  while (Date.now() < until) { /* burn the slice */ }
  return d
}

type Gate = ReturnType<typeof spawn>

const runGate = (
  env: Record<string, string>,
  {
    onStdout = (d: string) => d,
    mergeStderr = false,
    onSpawn = (() => {}) as (gate: Gate) => void,
  } = {},
) =>
  new Promise<{ status: number | null; out: string }>((resolve) => {
    const gate = [process.execPath, 'scripts/check.mjs']
    const [command, args] = mergeStderr
      ? ['/bin/sh', ['-c', `"${gate[0]}" ${gate[1]} 2>&1`]]
      : [gate[0], gate.slice(1)]
    const child = spawn(command, args, {
      // A slot directory of the test's own: the default is the repo's shared
      // one, where the gate running this very file holds a slot.
      env: {
        ...process.env,
        KM_CHECK_SLOT_DIR: tempDir('check-slots-'),
        ...env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    onSpawn(child)
    let out = ''
    child.stdout.on('data', (d) => {
      out += onStdout(String(d))
    })
    // Drained, not read: an unread pipe fills and would block the gate.
    child.stderr.resume()
    child.on('close', (status) => resolve({ status, out }))
  })

const lastLine = (out: string) => out.trimEnd().split('\n').at(-1)

// Skipped on Windows rather than supported there: the gate looks for
// `pnpm.cmd`, which needs a batch wrapper this repo has no CI or developer to
// run. Skipping is also the safe direction — a shim that fails to front the
// gate lets the real `pnpm run test` re-enter this file and spawn gates
// without bound.
describe.skipIf(process.platform === 'win32')('the check gate', () => {
  it('reports a failing task with a non-zero status and its whole output', async () => {
    const { status, out } = await runGate({ SHIM_MODE: 'flood' }, { onStdout: slowly })
    expect(status).not.toBe(0)
    expect(out.split('\n').filter((l) => l.startsWith('line ')).length).toBe(RELAYED_LINES)
    expect(lastLine(out)).toBe('check: FAIL (test)')
  }, 30_000)

  it('ends with its verdict line even when stderr shares the pipe', async () => {
    const { out } = await runGate({ SHIM_MODE: 'flood-stderr' }, { onStdout: slowly, mergeStderr: true })
    // Bytes, not lines: in one shared pipe the two streams' partial writes
    // interleave mid-line under backpressure.
    expect(out.length).toBeGreaterThan(RELAYED_LINES * 60)
    expect(lastLine(out)).toBe('check: FAIL (test)')
  }, 30_000)

  it('runs one gate at a time through a single slot, and the waiter says so', async () => {
    const log = join(tempDir('check-log-'), 'tests')
    const env = { SHIM_MODE: 'slow', SHIM_LOG: log, KM_CHECK_SLOTS: '1', KM_CHECK_SLOT_DIR: tempDir('check-slots-') }
    const gates = await Promise.all([runGate(env), runGate(env)])

    expect(gates.map((g) => [g.status, lastLine(g.out)])).toEqual([[0, 'check: PASS'], [0, 'check: PASS']])
    expect(gates.filter((g) => g.out.includes('gate slot(s) are taken')).length).toBe(1)
    // Handed over by release, not by the waiter reclaiming a dead holder's slot.
    expect(gates.some((g) => g.out.includes('reclaimed'))).toBe(false)
    // Interleaved (start, start, end, end) when both ran their tests at once.
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['start', 'end', 'start', 'end'])
  }, 30_000)

  it('re-runs the failing test files alone and says which fail without load', async () => {
    const { status, out } = await runGate({ SHIM_MODE: 'mixed' })
    expect(status).not.toBe(0)
    expect(out).toContain('fails alone too: scripts/real.test.ts; passed alone: scripts/slow.test.ts')
    expect(lastLine(out)).toBe('check: FAIL (test)')
  }, 30_000)

  it('does not re-run more failing files than a suite run would cost', async () => {
    const { out } = await runGate({ SHIM_MODE: 'many' })
    expect(out).toContain('26 test files failed; too many to re-run alone')
    expect(out).not.toContain('failing files, alone')
  }, 30_000)

  it.each(['-1', '0.5', '1.5', '1oops'])('takes the nonsense slot count %s as the default', async (slots) => {
    const dir = tempDir('check-slots-')
    writeFileSync(slotFile(dir), JSON.stringify(holder()))
    const { status, out } = await runGate({ KM_CHECK_SLOTS: slots, KM_CHECK_SLOT_DIR: dir })
    expect(out).not.toContain('are taken')
    expect([status, lastLine(out)]).toEqual([0, 'check: PASS'])
  }, 30_000)

  it('runs without a slot when it cannot set the cap up', async () => {
    const { status, out } = await runGate({ KM_CHECK_SLOT_DIR: '/dev/null/slots' })
    expect(out).toContain('running without a gate slot')
    expect([status, lastLine(out)]).toEqual([0, 'check: PASS'])
  }, 30_000)

  // One SIGINT once `stream` shows `marker`: a second one kills the gate outright.
  const interruptOn = (stream: 'stdout' | 'stderr', marker: string) => (gate: Gate) => {
    let seen = ''
    const watch = (d: Buffer) => {
      seen += d
      if (!seen.includes(marker)) return
      gate[stream]!.off('data', watch)
      gate.kill('SIGINT')
    }
    gate[stream]!.on('data', watch)
  }

  it('starts no re-run once interrupted', async () => {
    const { status, out } = await runGate({ SHIM_MODE: 'interrupt' }, { onSpawn: interruptOn('stderr', '[check] test failed') })
    expect(out).not.toContain('failing files, alone')
    expect([status, lastLine(out)]).toEqual([130, 'check: FAIL (interrupted)'])
  }, 30_000)

  it('stops waiting for a slot once interrupted', async () => {
    const dir = tempDir('check-slots-')
    writeFileSync(join(dir, 'slot-0'), JSON.stringify(holder()))
    const { status, out } = await runGate(
      { KM_CHECK_SLOTS: '1', KM_CHECK_SLOT_DIR: dir },
      { onSpawn: interruptOn('stdout', 'gate slot(s) are taken') },
    )
    expect(out).not.toContain('in parallel')
    expect([status, lastLine(out)]).toEqual([130, 'check: FAIL (interrupted)'])
  }, 30_000)

  it('gives no verdict for an interrupted re-run', async () => {
    const { status, out } = await runGate({ SHIM_MODE: 'interrupt' }, { onSpawn: interruptOn('stdout', 'failing files, alone') })
    expect(out).not.toContain('verdict')
    expect([status, lastLine(out)]).toEqual([130, 'check: FAIL (interrupted)'])
  }, 30_000)
})

describe('acquireSlot', () => {
  let dir: string
  beforeEach(() => {
    dir = tempDir('check-slots-')
  })

  it('takes a free slot, and release frees it', async () => {
    const slot = await acquireSlot({ dir, slots: 1, holder: holder(), log: quiet })
    expect(readdirSync(dir)).toEqual(['slot-0'])
    slot!.release()
    expect(readdirSync(dir)).toEqual([])
  })

  it('waits while every slot is held, naming the holders, and proceeds when one frees', async () => {
    const first = await acquireSlot({ dir, slots: 1, holder: holder(process.pid, 'other-wt', 'claude/other'), log: quiet })
    const lines: string[] = []
    let settled = false
    const second = acquireSlot({ dir, slots: 1, holder: holder(), pollMs: 10, log: (l) => lines.push(l) })
      .finally(() => { settled = true })

    await vi.waitFor(() => expect(lines.join('\n')).toContain('other-wt (claude/other'))
    expect(settled).toBe(false)
    first!.release()
    expect(await second).not.toBeNull()
  })

  it('admits as many gates as there are slots, and runs the next anyway once its wait is up', async () => {
    expect(await acquireSlot({ dir, slots: 2, holder: holder(), log: quiet })).not.toBeNull()
    expect(await acquireSlot({ dir, slots: 2, holder: holder(), log: quiet })).not.toBeNull()
    const lines: string[] = []
    expect(await acquireSlot({ dir, slots: 2, holder: holder(), maxWaitMs: 50, pollMs: 10, log: (l) => lines.push(l) }))
      .toBeNull()
    expect(lines.at(-1)).toMatch(/running anyway/)
  })

  it('reclaims a slot whose holder is no longer running', async () => {
    writeFileSync(slotFile(dir), JSON.stringify(holder(deadPid())))
    const slot = await acquireSlot({ dir, slots: 1, holder: holder(), maxWaitMs: 0, log: quiet })
    expect(slot).not.toBeNull()
    expect(JSON.parse(readFileSync(slotFile(dir), 'utf8')).pid).toBe(process.pid)
  })

  it('reclaims a slot whose record is unreadable', async () => {
    writeFileSync(slotFile(dir), 'not json')
    expect(await acquireSlot({ dir, slots: 1, holder: holder(), maxWaitMs: 0, log: quiet })).not.toBeNull()
  })

  it('release leaves a slot that another gate has since taken', async () => {
    const slot = await acquireSlot({ dir, slots: 1, holder: holder(), log: quiet })
    writeFileSync(slotFile(dir), JSON.stringify(holder(process.ppid)))
    slot!.release()
    expect(existsSync(slotFile(dir))).toBe(true)
  })

  it('leaves a live holder\'s record untouched while it waits', async () => {
    writeFileSync(slotFile(dir), JSON.stringify(holder()))
    const before = statSync(slotFile(dir), { bigint: true }).ctimeNs
    expect(await acquireSlot({ dir, slots: 1, holder: holder(), maxWaitMs: 0, log: quiet })).toBeNull()
    // A rename or link would have touched it.
    expect(statSync(slotFile(dir), { bigint: true }).ctimeNs).toBe(before)
  })

  it('puts back a live holder that a waiter moved aside as stale', () => {
    writeFileSync(slotFile(dir), JSON.stringify(holder()))
    clearStaleSlot(slotFile(dir), join(dir, 'scratch'))
    expect(readdirSync(dir)).toEqual(['slot-0'])
    expect(JSON.parse(readFileSync(slotFile(dir), 'utf8')).pid).toBe(process.pid)
  })

  it('leaves a slot another waiter already cleared', () => {
    expect(() => clearStaleSlot(slotFile(dir), join(dir, 'scratch'))).not.toThrow()
  })

  it('stops waiting when the gate is interrupted', async () => {
    await acquireSlot({ dir, slots: 1, holder: holder(), log: quiet })
    const abort = new AbortController()
    const waiting = acquireSlot({ dir, slots: 1, holder: holder(), pollMs: 60_000, signal: abort.signal, log: quiet })
    abort.abort()
    expect(await waiting).toBeNull()
  })
})

describe('loadVerdict', () => {
  const failed = ['a.test.ts', 'b.test.ts']

  it('says the failure was load when every file passes alone', () => {
    expect(loadVerdict(failed, { code: 0, output: '' })).toBe('failed only under load, passed alone: a.test.ts, b.test.ts')
  })

  it('names the files that fail alone, and the rest separately', () => {
    expect(loadVerdict(failed, { code: 1, output: ' FAIL  b.test.ts > it\n' }))
      .toBe('fails alone too: b.test.ts; passed alone: a.test.ts')
  })

  // Vitest's summary as both its default and agent reporters print it, with a
  // test that failed and a file that failed to load.
  const summary = `
 ❯ scripts/zz-probe2.test.ts (0 test)
 ❯ scripts/zz-probe.test.ts (3 tests | 2 failed) 108ms
   × times out 105ms
   × asserts 3ms

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  scripts/zz-probe2.test.ts [ scripts/zz-probe2.test.ts ]
Error: Cannot find module './does-not-exist.mjs' imported from scripts/zz-probe2.test.ts

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  scripts/zz-probe.test.ts > times out
Error: Test timed out in 100ms.

 FAIL  scripts/zz-probe.test.ts > asserts
AssertionError: expected 1 to be 2 // Object.is equality

 Test Files  2 failed (2)
      Tests  2 failed | 1 passed (3)
`

  it('reads the failing files out of a real vitest summary', () => {
    expect(loadVerdict(['scripts/zz-probe.test.ts', 'scripts/zz-probe2.test.ts', 'a.test.ts'], { code: 1, output: summary }))
      .toBe('fails alone too: scripts/zz-probe2.test.ts, scripts/zz-probe.test.ts; passed alone: a.test.ts')
  })

  it('reads .spec files, which the vitest config also runs', () => {
    expect(loadVerdict(['a.spec.ts', 'b.spec.tsx'], { code: 1, output: ' FAIL  b.spec.tsx > it\n' }))
      .toBe('fails alone too: b.spec.tsx; passed alone: a.spec.ts')
  })

  it('blames every file when the re-run fails without naming one', () => {
    expect(loadVerdict(failed, { code: 1, output: 'Unhandled Rejection\n' })).toBe('fails alone too: a.test.ts, b.test.ts')
  })
})
