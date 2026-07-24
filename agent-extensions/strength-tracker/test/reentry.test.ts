import {describe, expect, it} from 'vitest'

import {
  detectPendingLayoff,
  layoffAlreadyRecorded,
  layoffFromPending,
  resolveReentry,
  tierFor,
} from '../src/engine/reentry'
import {DEFAULT_CONFIG} from '../src/program/defaults'
import type {LayoffRecord, SessionType, WorkoutRecord} from '../src/engine/types'

const workout = (date: string, session: SessionType = 'A'): WorkoutRecord => ({
  id: date,
  date: `${date}T23:00:00`,
  session,
  exercises: [],
})

describe('tierFor', () => {
  it('maps gaps onto the plan rows', () => {
    expect(tierFor(3, DEFAULT_CONFIG.reentry)?.id).toBe('on-schedule')
    // A single skipped session (one weekly cadence) stays on schedule —
    // "repeat, no jump" is handled per lift, not as a recorded layoff.
    expect(tierFor(8, DEFAULT_CONFIG.reentry)?.id).toBe('on-schedule')
    expect(tierFor(14, DEFAULT_CONFIG.reentry)?.id).toBe('1-2w')
    expect(tierFor(20, DEFAULT_CONFIG.reentry)?.id).toBe('2-4w')
    expect(tierFor(45, DEFAULT_CONFIG.reentry)?.id).toBe('1-2mo')
    expect(tierFor(400, DEFAULT_CONFIG.reentry)?.id).toBe('2mo+')
  })

  it('classifies correctly even if the table was hand-reordered', () => {
    const shuffled = [...DEFAULT_CONFIG.reentry].reverse()
    expect(tierFor(20, shuffled)?.id).toBe('2-4w')
  })
})

describe('detectPendingLayoff', () => {
  it('returns null on schedule', () => {
    const history = [workout('2026-07-19', 'B')]
    expect(detectPendingLayoff(history, '2026-07-23', DEFAULT_CONFIG)).toBeNull()
  })

  it('returns null with no history at all', () => {
    expect(detectPendingLayoff([], '2026-07-23', DEFAULT_CONFIG)).toBeNull()
  })

  it('measures the gap from the last FULL session, ignoring minis', () => {
    const history = [workout('2026-07-03', 'A'), workout('2026-07-21', 'mini')]
    const pending = detectPendingLayoff(history, '2026-07-23', DEFAULT_CONFIG)
    expect(pending).toMatchObject({from: '2026-07-03', to: '2026-07-23', days: 20})
    expect(pending?.tier.id).toBe('2-4w')
  })

  it('does not fire when tonight is already logged', () => {
    const history = [workout('2026-07-23', 'A')]
    expect(detectPendingLayoff(history, '2026-07-23', DEFAULT_CONFIG)).toBeNull()
  })
})

describe('resolveReentry', () => {
  it('is undefined when training is on schedule', () => {
    expect(resolveReentry([workout('2026-07-19', 'B')], [], '2026-07-23', DEFAULT_CONFIG))
      .toBeUndefined()
  })

  it('reports the pending tier on the first night back', () => {
    const status = resolveReentry([workout('2026-07-03')], [], '2026-07-23', DEFAULT_CONFIG)
    expect(status).toMatchObject({
      gapDays: 20,
      sessionsBack: 0,
      factor: 0.9,
      pending: true,
      from: '2026-07-03',
    })
    expect(status?.tier.id).toBe('2-4w')
    expect(status?.banner).toContain('90% of pre-break weights')
    expect(status?.banner).toContain('first session back')
  })

  it('keeps the tier live across the comeback, counted from the recorded layoff', () => {
    const layoff: LayoffRecord = {
      id: 'l1', from: '2026-07-03', to: '2026-07-19', days: 16, tierId: '2-4w', pct: 0.9,
    }
    const afterOne = [workout('2026-07-03'), workout('2026-07-19', 'B')]
    const status = resolveReentry(afterOne, [layoff], '2026-07-23', DEFAULT_CONFIG)
    expect(status).toMatchObject({sessionsBack: 1, factor: 0.9, pending: false})

    // Two full sessions back → the 2–4 week row's ramp is finished.
    const afterTwo = [...afterOne, workout('2026-07-23')]
    expect(resolveReentry(afterTwo, [layoff], '2026-07-26', DEFAULT_CONFIG)).toBeUndefined()
  })

  it('ramps the percentage on the longer rows', () => {
    const layoff: LayoffRecord = {
      id: 'l2', from: '2026-05-01', to: '2026-06-20', days: 50, tierId: '1-2mo', pct: 0.8,
    }
    const factorAfter = (sessions: number): number | undefined => {
      const history = [
        workout('2026-05-01'),
        ...Array.from({length: sessions}, (_, i) => workout(`2026-06-${String(20 + i).padStart(2, '0')}`)),
      ]
      // Kept close to the last session so no *new* gap is pending — this
      // exercises the recorded-layoff ramp, not fresh detection.
      return resolveReentry(history, [layoff], '2026-06-26', DEFAULT_CONFIG)?.factor
    }
    expect(factorAfter(1)).toBeCloseTo(0.85)
    expect(factorAfter(2)).toBeCloseTo(0.9)
    expect(factorAfter(4)).toBeCloseTo(1)
    // Ramp complete — back to plain double progression.
    expect(factorAfter(5)).toBeUndefined()
  })

  it('prefers a fresh gap over a stale recorded layoff', () => {
    const stale: LayoffRecord = {
      id: 'l3', from: '2026-01-01', to: '2026-02-01', days: 31, tierId: '2-4w', pct: 0.9,
    }
    const status = resolveReentry([workout('2026-05-01')], [stale], '2026-07-23', DEFAULT_CONFIG)
    expect(status?.pending).toBe(true)
    expect(status?.gapDays).toBe(83)
    expect(status?.tier.id).toBe('2mo+')
  })
})

describe('layoff records', () => {
  it('rounds a pending gap into a writable record', () => {
    const pending = detectPendingLayoff([workout('2026-07-03')], '2026-07-23', DEFAULT_CONFIG)!
    expect(layoffFromPending(pending)).toEqual({
      from: '2026-07-03', to: '2026-07-23', days: 20, tierId: '2-4w', pct: 0.9,
    })
  })

  it('recognises an already-written layoff so it is not duplicated', () => {
    const pending = detectPendingLayoff([workout('2026-07-03')], '2026-07-23', DEFAULT_CONFIG)!
    const existing: LayoffRecord = {
      id: 'l', from: '2026-07-03', to: '2026-07-23', days: 20, tierId: '2-4w', pct: 0.9,
    }
    expect(layoffAlreadyRecorded(pending, [existing])).toBe(true)
    expect(layoffAlreadyRecorded(pending, [])).toBe(false)
  })
})
