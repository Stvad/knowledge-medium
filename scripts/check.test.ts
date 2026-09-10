import { afterAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

// Far past what a pipe holds before the reader takes it: at 200 lines a gate
// that exits on its own output still delivers all of them, and the test loses
// its teeth without saying so.
const RELAYED_LINES = 4000

// A PATH-fronted `pnpm`, so the real gate runs its real control flow over a
// task that fails: `run test` prints RELAYED_LINES lines and exits 1, every
// other task exits 0. `process.exitCode` in the shim so the shim is not itself
// the thing that truncates.
const bin = mkdtempSync(join(tmpdir(), 'check-gate-'))
writeFileSync(
  join(bin, 'pnpm'),
  `#!/usr/bin/env node
if (process.argv.slice(2).join(' ') === 'run test') {
  for (let i = 0; i < ${RELAYED_LINES}; i++) process.stdout.write(\`line \${i} \${'x'.repeat(60)}\\n\`)
  process.exitCode = 1
}
`,
)
chmodSync(join(bin, 'pnpm'), 0o755)
afterAll(() => rmSync(bin, { recursive: true, force: true }))

const runGate = () =>
  new Promise<{ status: number | null; relayed: number }>((resolve) => {
    const child = spawn(process.execPath, ['scripts/check.mjs'], {
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    // Deliberately slow: a writer's queued pipe writes only outlive it when the
    // reader is behind, which in CI is just a loaded box. Draining eagerly
    // hides the truncation this asserts against.
    child.stdout.on('data', (d) => {
      const until = Date.now() + 30
      while (Date.now() < until) { /* burn the slice */ }
      out += d
    })
    // Drained, not read: an unread pipe fills and would block the gate.
    child.stderr.resume()
    child.on('close', (status) =>
      resolve({ status, relayed: out.split('\n').filter((l) => l.startsWith('line ')).length }),
    )
  })

describe('the check gate', () => {
  // Skipped on Windows rather than supported there: the gate looks for
  // `pnpm.cmd`, which needs a batch wrapper this repo has no CI or developer to
  // run. Skipping is also the safe direction — a shim that fails to front the
  // gate lets the real `pnpm run test` re-enter this file and spawn gates
  // without bound.
  it.skipIf(process.platform === 'win32')('reports a failing task with a non-zero status and its whole output', async () => {
    const { status, relayed } = await runGate()
    expect(status).not.toBe(0)
    expect(relayed).toBe(RELAYED_LINES)
  }, 30_000)
})
