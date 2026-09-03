import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// A source check because the behaviour is platform-split: on Linux a child's
// queued pipe writes are dropped by `process.exit()`, on macOS they are not,
// so a behavioural test would pass on every dev machine and pin nothing.
// Measured in a node:26-slim container — the gate relaying a 4000-line failing
// task delivered 4000 lines via `process.exitCode` and 2031 via `process.exit`.
//
// It regressed twice: the gate lost its error block (CI reported "1 failed"
// with vitest's file list and no reason, four runs across three branches), and
// a sweep of the sibling hook script left one of its three exits behind.
describe('the check gate', () => {
  it('leaves through process.exitCode, never process.exit — it has relayed a task\'s whole output by then', () => {
    const calls = readFileSync('scripts/check.mjs', 'utf8').replace(/^\s*\/\/.*$/gm, '')
    expect(calls).not.toMatch(/process\.exit\(/)
  })
})
