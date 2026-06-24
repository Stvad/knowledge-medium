import { describe, expect, it } from 'vitest'
import {
  estimateSrsIntervalDays,
  getNewSrsParametersFromValues,
  scheduleSrsProperties,
  SrsSignal,
} from '../scheduler.ts'

const noJitter = () => 0.5
const may5 = new Date(2026, 4, 5)

describe('SRS scheduler', () => {
  it('schedules GOOD from default interval and factor', () => {
    expect(scheduleSrsProperties({interval: 2, factor: 2.5}, SrsSignal.GOOD, {
      now: may5,
      random: noJitter,
    })).toEqual({
      interval: 5,
      factor: 2.5,
      nextReviewDate: new Date(2026, 4, 10),
    })
  })

  it('updates existing interval and factor values', () => {
    expect(scheduleSrsProperties(
      {interval: 10, factor: 2},
      SrsSignal.HARD,
      {now: may5, random: noJitter},
    )).toEqual({
      interval: 13,
      factor: 1.85,
      nextReviewDate: new Date(2026, 4, 18),
    })
  })

  it('schedules SOONER from current values', () => {
    expect(scheduleSrsProperties(
      {interval: 2, factor: 2.5},
      SrsSignal.SOONER,
      {now: may5, random: noJitter},
    )).toEqual({
      interval: 1.5,
      factor: 2.5,
      nextReviewDate: new Date(2026, 4, 7),
    })
  })

  it('keeps the Anki lower ease bound for AGAIN', () => {
    expect(getNewSrsParametersFromValues(
      {interval: 5, factor: 1.35},
      SrsSignal.AGAIN,
      noJitter,
    )).toEqual({interval: 1, factor: 1.3})
  })

  it('estimates the next interval per signal without jitter', () => {
    const params = {interval: 4, factor: 2.5}
    // AGAIN resets to 1; HARD = interval * 1.3; GOOD/EASY = interval * factor.
    expect(estimateSrsIntervalDays(params, SrsSignal.AGAIN)).toBe(1)
    expect(estimateSrsIntervalDays(params, SrsSignal.HARD)).toBeCloseTo(5.2)
    expect(estimateSrsIntervalDays(params, SrsSignal.GOOD)).toBe(10)
    expect(estimateSrsIntervalDays(params, SrsSignal.EASY)).toBe(10)
  })

  it('EASY raises the ease factor above GOOD for the same card (SM-2.5 core)', () => {
    // GOOD and EASY produce the same next interval (interval * factor),
    // so the only thing separating them is the ease bump EASY applies.
    // If that bump regressed to 0 the two signals would be identical and
    // the estimate-interval test above would still pass — this pins the
    // distinction.
    const params = {interval: 4, factor: 2.5}
    const good = getNewSrsParametersFromValues(params, SrsSignal.GOOD, noJitter)
    const easy = getNewSrsParametersFromValues(params, SrsSignal.EASY, noJitter)

    expect(good.factor).toBe(2.5)
    expect(easy.factor).toBeCloseTo(2.65) // +0.15 FACTOR_MODIFIER
    expect(easy.factor).toBeGreaterThan(good.factor)
    expect(easy.interval).toBeCloseTo(good.interval) // same interval growth
  })

  it('clamps the ease factor to the 1.3 floor on HARD, not just AGAIN', () => {
    // factor 1.4 - 0.15 = 1.25, below the MIN_FACTOR floor → clamps to 1.3.
    const out = getNewSrsParametersFromValues(
      {interval: 5, factor: 1.4},
      SrsSignal.HARD,
      noJitter,
    )
    expect(out.factor).toBe(1.3)
    expect(out.interval).toBeCloseTo(6.5) // interval * HARD_FACTOR (1.3)
  })

  it('caps the interval at the 50-year ceiling', () => {
    // 20000 * 2.5 = 50000 days, well past MAX_INTERVAL (50 * 365 = 18250).
    const out = getNewSrsParametersFromValues(
      {interval: 20000, factor: 2.5},
      SrsSignal.GOOD,
      noJitter,
    )
    expect(out.interval).toBe(50 * 365)
  })
})
