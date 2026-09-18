// @vitest-environment happy-dom
/**
 * The dialog's pure parts, which the gate's integration tests reach only
 * through a claim row and a suspending render: the age it reports, and the
 * affordances each arm offers.
 */
import { describe, expect, it } from 'vitest'
import { __heldForTest as heldFor } from '../MigrationGateDialog.tsx'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

describe('the age a stranded claim reports', () => {
  const at = (delta: number): string => heldFor(1_000_000_000, 1_000_000_000 + delta)

  it('never rounds UP — an overstated age is an argument for killing a live run', () => {
    expect(at(95 * MINUTE)).toBe('at least 1 hour(s) ago')
    expect(at(59 * MINUTE + 59_000)).toBe('at least 59 minute(s) ago')
  })

  it('reads a claim from a clock AHEAD of ours as exactly that', () => {
    // `claimedAt` is the claiming device's `Date.now()` and there is no server
    // clock. Clamping this to "0 minute(s) ago" would be the strongest possible
    // argument against releasing, shown when the claimant is most likely dead.
    expect(at(-10 * MINUTE)).toMatch(/clock is ahead/)
  })

  it('tolerates the ordinary skew between two live devices', () => {
    // Half of all fresh claims land a few seconds negative; calling that a
    // clock fault would make the warning meaningless.
    expect(at(-5_000)).toBe('less than a minute ago')
    expect(at(0)).toBe('at least 0 minute(s) ago')
  })

  it('counts hours once there are hours', () => {
    expect(at(3 * HOUR + 40 * MINUTE)).toBe('at least 3 hour(s) ago')
  })
})
