// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createSweepProgressLine } from '../sweepProgress.ts'

/** A clock the test moves by hand, so a rate is a known number of blocks over a
 *  known number of seconds. */
const manualClock = (start = 1_000_000) => {
  let now = start
  return {now: () => now, advance: (ms: number) => { now += ms }}
}

describe('the migration progress line', () => {
  it('shows the rate and how long the sweep has left', () => {
    const clock = manualClock()
    const line = createSweepProgressLine(10_000, clock.now)

    clock.advance(10_000)
    expect(line({sweeps: 1, blocksScanned: 1_000}))
      .toBe('Migrating properties to blocks… sweep 1, 1,000/10,000 · 100 blocks/s, about 2 min left in this sweep')
  })

  it('times a later sweep from where the previous one ended, not from the start of the run', () => {
    const clock = manualClock()
    const line = createSweepProgressLine(10_000, clock.now)
    clock.advance(100_000)
    line({sweeps: 1, blocksScanned: 10_000})

    // Sweep 2 reports 5,000 blocks 10 s after sweep 1's last batch: 500/s.
    // Timed from the run's start it would read 45/s and ten times the wait.
    clock.advance(10_000)
    expect(line({sweeps: 2, blocksScanned: 5_000}))
      .toMatch(/sweep 2, 5,000\/10,000 · 500 blocks\/s, about 10 s left in this sweep$/)
  })

  it('reads hours and minutes for a long wait', () => {
    const clock = manualClock()
    const line = createSweepProgressLine(111_000, clock.now)

    clock.advance(60_000)
    expect(line({sweeps: 1, blocksScanned: 600})).toMatch(/10 blocks\/s, about 3 h 4 min left in this sweep$/)
  })

  it('drops the wait once the sweep has scanned everything it was told about', () => {
    const clock = manualClock()
    const line = createSweepProgressLine(1_000, clock.now)

    clock.advance(2_000)
    expect(line({sweeps: 1, blocksScanned: 1_200}))
      .toBe('Migrating properties to blocks… sweep 1, 1,200/1,200 · 600 blocks/s')
  })

  it('shows no rate before any time has passed', () => {
    const clock = manualClock()
    const line = createSweepProgressLine(1_000, clock.now)

    expect(line({sweeps: 1, blocksScanned: 10})).toBe('Migrating properties to blocks… sweep 1, 10/1,000')
  })

  it('shows no rate for a sweep that has scanned nothing, however long it has run', () => {
    // Blocks deleted since the survey can leave a converging sweep with nothing
    // to scan; a zero rate there would divide the wait by zero.
    const clock = manualClock()
    const line = createSweepProgressLine(1_000, clock.now)

    clock.advance(5_000)
    expect(line({sweeps: 1, blocksScanned: 0})).toBe('Migrating properties to blocks… sweep 1, 0/1,000')
  })

  it('keeps a slow rate readable and rounds the wait before choosing its unit', () => {
    const clock = manualClock()
    const line = createSweepProgressLine(1_000, clock.now)

    // 3 blocks in 10 s: 0.3/s, and 997 blocks left is 3323 s, about 55 min.
    clock.advance(10_000)
    expect(line({sweeps: 1, blocksScanned: 3})).toMatch(/0\.3 blocks\/s, about 55 min left/)

    // 10 blocks/s with 596 left is 59.6 s, which reads as a minute, not "60 s".
    const short = createSweepProgressLine(606, clock.now)
    clock.advance(1_000)
    expect(short({sweeps: 1, blocksScanned: 10})).toMatch(/10 blocks\/s, about 1 min left/)
  })
})
