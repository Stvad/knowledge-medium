// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  backoffMs,
  computeVolume,
  DAY_MS,
  HOUR_MS,
  isAttemptDue,
  submissionBudget,
} from '../rateLimit.ts'

const NOW = new Date('2026-07-30T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms)

const submitted = (at: Date | undefined, status = 'submitted') =>
  ({submittedAt: at, status})

describe('computeVolume', () => {
  it('counts only records that were actually submitted', () => {
    const stats = computeVolume([
      submitted(ago(5 * 60_000)),
      submitted(undefined, 'pending'),
      submitted(undefined, 'pending'),
    ], NOW)
    expect(stats.total).toBe(1)
    expect(stats.lastHour).toBe(1)
    expect(stats.pending).toBe(2)
  })

  it('splits the rolling hour from the rolling day', () => {
    const stats = computeVolume([
      submitted(ago(30 * 60_000)),
      submitted(ago(2 * HOUR_MS)),
      submitted(ago(10 * HOUR_MS)),
      submitted(ago(2 * DAY_MS)),
    ], NOW)
    expect(stats).toMatchObject({total: 4, lastHour: 1, lastDay: 3})
  })

  it('treats the window edges as inclusive', () => {
    const stats = computeVolume([submitted(ago(HOUR_MS)), submitted(ago(DAY_MS))], NOW)
    expect(stats).toMatchObject({lastHour: 1, lastDay: 2})
  })

  // A peer device with a fast clock must not be able to make us under-count
  // and therefore over-submit.
  it('counts a future timestamp toward the window', () => {
    const stats = computeVolume([submitted(new Date(NOW.getTime() + 60_000))], NOW)
    expect(stats).toMatchObject({total: 1, lastHour: 1, lastDay: 1})
  })

  it('tallies the lifecycle buckets', () => {
    const stats = computeVolume([
      submitted(undefined, 'pending'),
      submitted(ago(60_000), 'submitted'),
      submitted(ago(60_000), 'archived'),
      submitted(ago(60_000), 'failed'),
    ], NOW)
    expect(stats).toMatchObject({pending: 1, awaitingSnapshot: 1, failed: 1, total: 3})
  })
})

describe('submissionBudget', () => {
  it('reports the room left under the tighter of the two limits', () => {
    expect(submissionBudget({lastHour: 10, lastDay: 10}, {hourlyLimit: 60, dailyLimit: 500}))
      .toEqual({remaining: 50, blockedBy: undefined})
    expect(submissionBudget({lastHour: 10, lastDay: 495}, {hourlyLimit: 60, dailyLimit: 500}))
      .toEqual({remaining: 5, blockedBy: undefined})
  })

  it('names which ceiling is binding when there is no room', () => {
    expect(submissionBudget({lastHour: 60, lastDay: 100}, {hourlyLimit: 60, dailyLimit: 500}))
      .toEqual({remaining: 0, blockedBy: 'hourly'})
    expect(submissionBudget({lastHour: 1, lastDay: 500}, {hourlyLimit: 60, dailyLimit: 500}))
      .toEqual({remaining: 0, blockedBy: 'daily'})
  })

  it('never goes negative when a limit is lowered below current usage', () => {
    expect(submissionBudget({lastHour: 90, lastDay: 90}, {hourlyLimit: 10, dailyLimit: 500}))
      .toEqual({remaining: 0, blockedBy: 'hourly'})
  })

  it('treats a zero limit as an off switch', () => {
    expect(submissionBudget({lastHour: 0, lastDay: 0}, {hourlyLimit: 0, dailyLimit: 500}).remaining)
      .toBe(0)
  })
})

describe('backoff', () => {
  it('grows exponentially and caps at an hour', () => {
    expect(backoffMs(1)).toBe(60_000)
    expect(backoffMs(2)).toBe(240_000)
    expect(backoffMs(3)).toBe(960_000)
    expect(backoffMs(9)).toBe(HOUR_MS)
  })

  it('lets a never-attempted record through immediately', () => {
    expect(isAttemptDue({attempts: 0, lastAttemptAt: undefined}, NOW)).toBe(true)
  })

  it('holds a record back until its backoff has elapsed', () => {
    expect(isAttemptDue({attempts: 1, lastAttemptAt: ago(30_000)}, NOW)).toBe(false)
    expect(isAttemptDue({attempts: 1, lastAttemptAt: ago(61_000)}, NOW)).toBe(true)
  })

  // Without this, a future `lastAttemptAt` makes `elapsed` negative, which is
  // still >= 0 only if the comparison is written backwards — the failure mode
  // is a hot retry loop against someone else's server.
  it('does not treat a future last-attempt stamp as due', () => {
    expect(isAttemptDue({attempts: 1, lastAttemptAt: new Date(NOW.getTime() + 60_000)}, NOW))
      .toBe(false)
  })
})
