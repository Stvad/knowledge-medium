import {describe, expect, it} from 'vitest'

import {
  armForDate,
  buildSchedule,
  isTransitionNight,
  periodForDate,
  scheduleEnd,
  scheduleProgress,
} from '../src/engine/schedule'
import type {ScheduleSpec} from '../src/engine/types'

const spec = (overrides: Partial<ScheduleSpec> = {}): ScheduleSpec => ({
  startDate: '2026-01-01',
  periodNights: 3,
  pairs: 4,
  seed: 1,
  ...overrides,
})

describe('buildSchedule', () => {
  it('is deterministic for a given seed', () => {
    expect(buildSchedule(spec())).toEqual(buildSchedule(spec()))
  })

  it('produces a different order for a different seed', () => {
    // Not a mathematical guarantee for an arbitrary PRNG, but true for
    // mulberry32 at these two seeds — if this ever flakes, swap the seed.
    expect(buildSchedule(spec({seed: 1}))).not.toEqual(buildSchedule(spec({seed: 2})))
  })

  it('draws one coin flip per pair, matching mulberry32(1)', () => {
    // Locks the actual order down for seed 1 so a change to the draw
    // (e.g. reading two draws per pair, or flipping the comparison) is
    // caught rather than silently reshuffling every existing schedule.
    const periods = buildSchedule(spec())
    expect(periods.map(p => p.arm)).toEqual([
      'control', 'intervention', // pair 1: draw ≈ 0.627
      'intervention', 'control', // pair 2: draw ≈ 0.003
      'control', 'intervention', // pair 3: draw ≈ 0.527
      'control', 'intervention', // pair 4: draw ≈ 0.981
    ])
  })

  it('makes 2×pairs periods, each with one of each arm per pair', () => {
    const periods = buildSchedule(spec({pairs: 8}))
    expect(periods).toHaveLength(16)
    for (let pair = 1; pair <= 8; pair++) {
      const pairPeriods = periods.filter(p => p.pair === pair)
      expect(pairPeriods).toHaveLength(2)
      expect(new Set(pairPeriods.map(p => p.arm))).toEqual(new Set(['intervention', 'control']))
    }
  })

  it('numbers periods 1-based and contiguous, and pairs 1-based', () => {
    const periods = buildSchedule(spec({pairs: 2}))
    expect(periods.map(p => p.index)).toEqual([1, 2, 3, 4])
    expect(periods.map(p => p.pair)).toEqual([1, 1, 2, 2])
  })

  it('gives each period periodNights consecutive wake dates, inclusive', () => {
    const periods = buildSchedule(spec({periodNights: 3, pairs: 1}))
    expect(periods[0]).toMatchObject({from: '2026-01-01', to: '2026-01-03'})
    expect(periods[1]).toMatchObject({from: '2026-01-04', to: '2026-01-06'})
  })

  it('runs periods back-to-back with no gap and no overlap across a whole schedule', () => {
    const periods = buildSchedule(spec({periodNights: 3, pairs: 8}))
    for (let i = 1; i < periods.length; i++) {
      const prevTo = new Date(periods[i - 1].to)
      const from = new Date(periods[i].from)
      expect(from.getTime() - prevTo.getTime()).toBe(24 * 60 * 60 * 1000)
    }
  })

  it('spans a period length that survives a DST boundary correctly', () => {
    // US "spring forward" 2026-03-08 falls inside this period.
    const periods = buildSchedule(spec({startDate: '2026-03-06', periodNights: 5, pairs: 1}))
    expect(periods[0]).toMatchObject({from: '2026-03-06', to: '2026-03-10'})
  })

  it.each([
    ['periodNights', {periodNights: 0}],
    ['periodNights', {periodNights: -1}],
    ['periodNights', {periodNights: 1.5}],
    ['pairs', {pairs: 0}],
    ['pairs', {pairs: -2}],
  ])('rejects a bad %s', (_label, overrides) => {
    expect(() => buildSchedule(spec(overrides))).toThrow()
  })

  it.each([
    '2026-1-1',
    '2026-01-1',
    '01-01-2026',
    'not-a-date',
    '',
  ])('rejects a malformed startDate %j', bad => {
    expect(() => buildSchedule(spec({startDate: bad}))).toThrow()
  })
})

describe('periodForDate / armForDate / isTransitionNight', () => {
  const periods = buildSchedule(spec({periodNights: 3, pairs: 2}))

  it('finds the period containing a date', () => {
    expect(periodForDate(periods, '2026-01-05')).toMatchObject({index: 2})
  })

  it('is undefined before the schedule starts and after it ends', () => {
    expect(periodForDate(periods, '2025-12-31')).toBeUndefined()
    expect(periodForDate(periods, '2026-01-13')).toBeUndefined()
  })

  it('reads the arm for a date via its period', () => {
    expect(armForDate(periods, periods[0].from)).toBe(periods[0].arm)
    expect(armForDate(periods, '2099-01-01')).toBeUndefined()
  })

  it('flags only the first night of a period as transition', () => {
    const period = periods[0]
    expect(isTransitionNight(period, period.from)).toBe(true)
    expect(isTransitionNight(period, period.to)).toBe(false)
  })
})

describe('scheduleEnd', () => {
  it('is the last period\'s wake date', () => {
    const periods = buildSchedule(spec({periodNights: 3, pairs: 2}))
    expect(scheduleEnd(periods)).toBe(periods.at(-1)!.to)
  })

  it('is undefined for an empty schedule', () => {
    expect(scheduleEnd([])).toBeUndefined()
  })
})

describe('scheduleProgress', () => {
  const periods = buildSchedule(spec({periodNights: 3, pairs: 2})) // 12 nights total

  it('is night 1 of total on the first night', () => {
    expect(scheduleProgress(periods, '2026-01-01')).toEqual({night: 1, total: 12})
  })

  it('is night = total on the last night', () => {
    expect(scheduleProgress(periods, '2026-01-12')).toEqual({night: 12, total: 12})
  })

  it('counts a night in the middle correctly', () => {
    expect(scheduleProgress(periods, '2026-01-07')).toEqual({night: 7, total: 12})
  })

  it('is undefined before the schedule starts', () => {
    expect(scheduleProgress(periods, '2025-12-31')).toBeUndefined()
  })

  it('is undefined after the schedule ends', () => {
    expect(scheduleProgress(periods, '2026-01-13')).toBeUndefined()
  })

  it('is undefined for an empty schedule', () => {
    expect(scheduleProgress([], '2026-01-01')).toBeUndefined()
  })
})
