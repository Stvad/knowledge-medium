import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { acquireSlot, loadVerdict, placeOrder, unaccounted, type SlotHolder } from './check.mjs'

// Far past what a pipe holds before the reader takes it: at 200 lines a gate
// that exits on its own output still delivers all of them, and the test loses
// its teeth without saying so.
const RELAYED_LINES = 4000

const temps: string[] = []
const tempDir = (prefix: string) => {
  temps.push(mkdtempSync(join(tmpdir(), prefix)))
  return temps.at(-1)!
}
afterAll(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const holder = (pid = process.pid, worktree = 'this-wt', branch = 'this-branch'): SlotHolder =>
  ({ pid, worktree, branch, startedAt: Date.now() })
const quiet = () => {}
const writeTicket = (dir: string, number: number, record: SlotHolder) =>
  writeFileSync(join(dir, `${number}-${randomUUID()}.ticket`), JSON.stringify(record))
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid

// A PATH-fronted `pnpm`, so the real gate runs its real control flow over
// tasks whose behaviour each test picks through SHIM_MODE. Every task not
// named below exits 0. `process.exitCode` in the shim so the shim is not
// itself the thing that truncates.
const bin = tempDir('check-gate-')
writeFileSync(
  join(bin, 'pnpm'),
  `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require('node:fs')
// Tells a test this task can now take a signal its own way.
const ready = () => process.env.SHIM_READY && writeFileSync(process.env.SHIM_READY, '')
const [, script, ...files] = process.argv.slice(2)
const mode = process.env.SHIM_MODE
// The line vitest prints last, once a run finishes.
const summary = (failed, total) =>
  process.stdout.write(\` Test Files  \${failed} failed\${total > failed ? \` | \${total - failed} passed\` : ''} (\${total})\\n\`)
if (script === 'test' && mode?.startsWith('flood')) {
  const out = mode === 'flood-stderr' ? process.stderr : process.stdout
  for (let i = 0; i < ${RELAYED_LINES}; i++) out.write(\`line \${i} \${'x'.repeat(60)}\\n\`)
  process.exitCode = 1
}
if (script === 'test' && mode === 'slow') {
  appendFileSync(process.env.SHIM_LOG, 'start\\n')
  setTimeout(() => appendFileSync(process.env.SHIM_LOG, 'end\\n'), 1500)
}
if (script === 'test' && mode === 'mixed') {
  // The whole suite fails a load-only file and a real one; re-run one file at
  // a time, only the real one still fails.
  const alone = files.includes('--no-file-parallelism')
  const failing = alone ? ['scripts/real.test.ts'] : ['scripts/slow.test.ts', 'scripts/real.test.ts']
  for (const file of failing) process.stdout.write(\` FAIL  \${file} > a test\\nError: boom\\n\`)
  summary(failing.length, 2)
  process.exitCode = 1
}
if (script === 'test' && mode === 'many') {
  for (let i = 0; i < 26; i++) process.stdout.write(\` FAIL  scripts/f\${i}.test.ts > a test\\n\`)
  summary(26, 26)
  process.exitCode = 1
}
if (mode === 'interrupt-install' && process.argv[2] === 'install') {
  // Outlives the gate's SIGTERM and exits 0, as pnpm does when its script does.
  const keepAlive = setTimeout(() => {}, 10_000)
  process.on('SIGTERM', () => clearTimeout(keepAlive))
  ready()
}
if (mode === 'interrupt') {
  // The suite fails at once, while lint can be made to wind down slowly; the
  // re-run would take a while.
  if (script === 'test' && !files.length) {
    process.stdout.write(' FAIL  scripts/slow.test.ts > a test\\n')
    summary(1, 1)
    process.exitCode = 1
  } else if (script === 'lint' || script === 'test') {
    const keepAlive = setTimeout(() => {}, 10_000)
    if (script === 'lint') {
      // Only where a test needs the gate still running after its interrupt.
      const linger = process.env.SHIM_LINGER ? 3_000 : 0
      process.on('SIGTERM', () => setTimeout(() => clearTimeout(keepAlive), linger))
      ready()
    }
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
    expect(out).toContain('no verdict: the test run did not finish')
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
    expect(gates.filter((g) => g.out.includes('waiting behind')).length).toBe(1)
    // Handed over by release, not by the waiter reclaiming a dead holder's slot.
    expect(gates.some((g) => g.out.includes('no longer running'))).toBe(false)
    // Interleaved (start, start, end, end) when both ran their tests at once.
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['start', 'end', 'start', 'end'])
  }, 30_000)

  it('re-runs the failing test files alone and says which fail without load', async () => {
    const { status, out } = await runGate({ SHIM_MODE: 'mixed' })
    expect(status).not.toBe(0)
    expect(out).toContain('pnpm run test --no-file-parallelism scripts/slow.test.ts scripts/real.test.ts')
    expect(out).toContain('fails alone too: scripts/real.test.ts; passed alone: scripts/slow.test.ts')
    expect(out).toMatch(/verdict: .*\(re-run at load average [\d.]+ on \d+ cores\)/)
    expect(lastLine(out)).toBe('check: FAIL (test)')
  }, 30_000)

  it('does not re-run more failing files than a suite run would cost', async () => {
    const { out } = await runGate({ SHIM_MODE: 'many' })
    expect(out).toContain('no verdict: 26 test files failed, too many to re-run alone')
    expect(out).not.toContain('failing files, alone')
  }, 30_000)

  it.each(['-1', '0.5', '1.5', '1oops'])('takes the nonsense slot count %s as the default', async (slots) => {
    const dir = tempDir('check-slots-')
    writeTicket(dir, 1, holder())
    const { status, out } = await runGate({ KM_CHECK_SLOTS: slots, KM_CHECK_SLOT_DIR: dir })
    expect(out).not.toContain('waiting behind')
    expect([status, lastLine(out)]).toEqual([0, 'check: PASS'])
  }, 30_000)

  it('runs without a slot when it cannot set the cap up', async () => {
    const { status, out } = await runGate({ KM_CHECK_SLOT_DIR: '/dev/null/slots' })
    expect(out).toContain('running without a gate slot')
    expect([status, lastLine(out)]).toEqual([0, 'check: PASS'])
  }, 30_000)

  // One SIGINT once `stream` shows `marker`.
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

  // SIGINT once the task under test writes its ready file, so the signal lands
  // in the task's handler rather than before node installed it.
  const interruptWhenReady = (againAfterMs?: number) => {
    const file = join(tempDir('check-ready-'), 'ready')
    const onSpawn = (gate: Gate) => {
      const poll = setInterval(() => {
        if (!existsSync(file)) return
        clearInterval(poll)
        gate.kill('SIGINT')
        if (againAfterMs !== undefined) setTimeout(() => gate.kill('SIGINT'), againAfterMs)
      }, 10)
      gate.on('close', () => clearInterval(poll))
    }
    return { env: { SHIM_READY: file }, onSpawn }
  }

  it('takes a second copy of the interrupt as the same one, and still releases and reports', async () => {
    const dir = tempDir('check-slots-')
    // Lint lingers 3s after its SIGTERM, so the second copy lands mid-shutdown.
    const { env, onSpawn } = interruptWhenReady(100)
    const { status, out } = await runGate({ SHIM_MODE: 'interrupt', SHIM_LINGER: '1', KM_CHECK_SLOT_DIR: dir, ...env }, { onSpawn })
    expect([status, lastLine(out)]).toEqual([130, 'check: FAIL (interrupted)'])
    expect(readdirSync(dir)).toEqual([])
  }, 30_000)

  it('stops at an interrupt even when the task it lands in exits 0', async () => {
    const { env, onSpawn } = interruptWhenReady()
    const { status, out } = await runGate({ SHIM_MODE: 'interrupt-install', ...env }, { onSpawn })
    expect(out).not.toContain('starting compile')
    expect([status, lastLine(out)]).toEqual([130, 'check: FAIL (interrupted)'])
  }, 30_000)

  it('starts no re-run once interrupted', async () => {
    const { status, out } = await runGate({ SHIM_MODE: 'interrupt', SHIM_LINGER: '1' }, { onSpawn: interruptOn('stderr', '[check] test failed') })
    expect(out).not.toContain('failing files, alone')
    expect([status, lastLine(out)]).toEqual([130, 'check: FAIL (interrupted)'])
  }, 30_000)

  it('stops waiting for a slot once interrupted', async () => {
    const dir = tempDir('check-slots-')
    writeTicket(dir, 1, holder())
    const { status, out } = await runGate(
      { KM_CHECK_SLOTS: '1', KM_CHECK_SLOT_DIR: dir },
      { onSpawn: interruptOn('stdout', 'waiting behind') },
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
  const tickets = () => readdirSync(dir).filter((name) => name.endsWith('.ticket')).sort()
  const ticketPids = () => tickets().map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')).pid)

  it('takes a ticket, and release gives it up', async () => {
    const slot = await acquireSlot({ dir, slots: 1, holder: holder(), log: quiet })
    expect(readdirSync(dir)).toEqual([expect.stringMatching(/^1-[\w-]+\.ticket$/)])
    slot!.release()
    expect(readdirSync(dir)).toEqual([])
  })

  it('waits while the slots are taken, naming the gates ahead, and proceeds when one leaves', async () => {
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
    expect(tickets()).toHaveLength(2)
  })

  it('takes a number above every ticket in view', async () => {
    writeTicket(dir, 7, holder())
    await acquireSlot({ dir, slots: 2, holder: holder(), log: quiet })
    expect(tickets()).toEqual([expect.stringMatching(/^7-/), expect.stringMatching(/^8-/)])
  })

  it('serves waiting gates in the order they arrived', async () => {
    const first = await acquireSlot({ dir, slots: 1, holder: holder(), log: quiet })
    const admitted: string[] = []
    const lateLines: string[] = []
    const early = acquireSlot({ dir, slots: 1, holder: holder(), pollMs: 10, log: quiet })
      .then((slot) => { admitted.push('early'); return slot })
    const late = acquireSlot({ dir, slots: 1, holder: holder(), pollMs: 10, log: (l) => lateLines.push(l) })
      .then((slot) => { admitted.push('late'); return slot })

    first!.release()
    // `late` has looked again since `first` left, and stayed behind `early`.
    await vi.waitFor(() => expect(lateLines).toContainEqual(expect.stringContaining('waiting behind 1 gate(s)')))
    expect(admitted).toEqual(['early'])
    ;(await early)!.release()
    expect(await late).not.toBeNull()
  })

  it('drops the ticket of a gate that is no longer running', async () => {
    writeTicket(dir, 1, holder(deadPid()))
    expect(await acquireSlot({ dir, slots: 1, holder: holder(), maxWaitMs: 0, log: quiet })).not.toBeNull()
    expect(ticketPids()).toEqual([process.pid])
  })

  it('counts a gate it may not signal as still running', async () => {
    // pid 1 is root's: signalling it from here fails with EPERM, not ESRCH.
    writeTicket(dir, 1, holder(1))
    expect(await acquireSlot({ dir, slots: 1, holder: holder(), maxWaitMs: 0, log: quiet })).toBeNull()
    expect(ticketPids()).toEqual([1])
  })

  it('skips a ticket whose record is unreadable', async () => {
    writeFileSync(join(dir, `1-${randomUUID()}.ticket`), 'not json')
    expect(await acquireSlot({ dir, slots: 1, holder: holder(), maxWaitMs: 0, log: quiet })).not.toBeNull()
  })

  it('holds its count while another gate is still taking a number', async () => {
    writeFileSync(join(dir, `${process.pid}-${randomUUID()}.choosing`), '')
    expect(await acquireSlot({ dir, slots: 1, holder: holder(), maxWaitMs: 50, pollMs: 10, log: quiet })).toBeNull()
  })

  it('looks again soon once a gate has finished taking its number', async () => {
    const marker = join(dir, `${process.pid}-${randomUUID()}.choosing`)
    writeFileSync(marker, '')
    setTimeout(() => rmSync(marker), 50)
    // A full poll here would outlast the test.
    expect(await acquireSlot({ dir, slots: 1, holder: holder(), pollMs: 60_000, log: quiet })).not.toBeNull()
  })

  it('ignores the number-taking marker of a gate that is no longer running', async () => {
    writeFileSync(join(dir, `${deadPid()}-${randomUUID()}.choosing`), '')
    expect(await acquireSlot({ dir, slots: 1, holder: holder(), maxWaitMs: 0, log: quiet })).not.toBeNull()
    expect(readdirSync(dir).filter((name) => name.endsWith('.choosing'))).toEqual([])
  })

  it('leaves no marker behind when taking a number throws', async () => {
    // A directory where a ticket should be: the dead-ticket cleanup throws on it.
    mkdirSync(join(dir, `1-${randomUUID()}.ticket`))
    await expect(acquireSlot({ dir, slots: 1, holder: holder(), log: quiet })).rejects.toThrow()
    expect(readdirSync(dir).filter((name) => name.endsWith('.choosing'))).toEqual([])
  })

  it('stops waiting when the gate is interrupted, and gives up its ticket', async () => {
    await acquireSlot({ dir, slots: 1, holder: holder(), log: quiet })
    const abort = new AbortController()
    const waiting = acquireSlot({ dir, slots: 1, holder: holder(), pollMs: 60_000, signal: abort.signal, log: quiet })
    abort.abort()
    expect(await waiting).toBeNull()
    expect(tickets()).toHaveLength(1)
  })
})

describe('placeOrder', () => {
  it('orders by number, then by id between gates that drew the same number', () => {
    const places = [{ number: 2, id: 'a' }, { number: 1, id: 'b' }, { number: 1, id: 'a' }]
    expect(places.sort(placeOrder)).toEqual([{ number: 1, id: 'a' }, { number: 1, id: 'b' }, { number: 2, id: 'a' }])
  })
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

describe('unaccounted', () => {
  const named = ['scripts/zz-probe2.test.ts', 'scripts/zz-probe.test.ts']

  it('accounts for a finished run that names every file it failed', () => {
    expect(unaccounted(summary, named)).toBeNull()
  })

  it('refuses a run that never printed its summary', () => {
    expect(unaccounted(summary.slice(0, summary.indexOf(' Test Files')), named)).toBe('the test run did not finish')
  })

  it('refuses a run with unhandled errors, which belong to no file', () => {
    expect(unaccounted(`${summary}      Errors  1 error\n`, named)).toMatch(/unhandled errors/)
  })

  it('refuses a run that counted more failing files than it named', () => {
    expect(unaccounted(summary, named.slice(1))).toBe('vitest counted 2 failing files but named 1')
  })
})

describe('loadVerdict', () => {
  const failed = ['a.test.ts', 'b.test.ts']

  it('says the failure was load when every file passes alone', () => {
    expect(loadVerdict(failed, { code: 0, output: '' })).toBe('failed only under load, passed alone: a.test.ts, b.test.ts')
  })

  it('names the files that fail alone, and the rest separately', () => {
    expect(loadVerdict(failed, { code: 1, output: ' FAIL  b.test.ts > it\n Test Files  1 failed | 1 passed (2)\n' }))
      .toBe('fails alone too: b.test.ts; passed alone: a.test.ts')
  })

  it('reads the failing files out of a real vitest summary', () => {
    expect(loadVerdict(['scripts/zz-probe.test.ts', 'scripts/zz-probe2.test.ts', 'a.test.ts'], { code: 1, output: summary }))
      .toBe('fails alone too: scripts/zz-probe2.test.ts, scripts/zz-probe.test.ts; passed alone: a.test.ts')
  })

  it('reads .spec files, which the vitest config also runs', () => {
    expect(loadVerdict(['a.spec.ts', 'b.spec.tsx'], { code: 1, output: ' FAIL  b.spec.tsx > it\n Test Files  1 failed | 1 passed (2)\n' }))
      .toBe('fails alone too: b.spec.tsx; passed alone: a.spec.ts')
  })

  it('blames every file when the re-run does not account for its failures', () => {
    const unfinished = ' FAIL  b.test.ts > it\n'
    expect(loadVerdict(failed, { code: 1, output: unfinished })).toBe('fails alone too: a.test.ts, b.test.ts')
  })

  it('blames every file when the re-run fails without naming one', () => {
    expect(loadVerdict(failed, { code: 1, output: 'Unhandled Rejection\n' })).toBe('fails alone too: a.test.ts, b.test.ts')
  })
})
