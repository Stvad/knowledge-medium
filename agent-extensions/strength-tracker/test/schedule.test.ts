import {describe, expect, it} from 'vitest'

import {DEFAULT_CONFIG} from '../src/program/defaults'
import {
  daysBetween,
  fullSessionDays,
  resolveSession,
  scheduledSession,
  trainingDay,
  weekdayOfDay,
} from '../src/engine/schedule'
import type {WorkoutRecord} from '../src/engine/types'

const workout = (date: string, session: WorkoutRecord['session']): WorkoutRecord => ({
  id: date,
  date,
  session,
  exercises: [],
})

describe('trainingDay', () => {
  it('keeps an evening session on its own calendar day', () => {
    expect(trainingDay('2026-07-23T23:30:00', 4)).toBe('2026-07-23')
  })

  it('assigns a past-midnight session to the night it started', () => {
    // Session B is "Sunday late" — 00:40 Monday is still Sunday's session.
    expect(trainingDay('2026-07-20T00:40:00', 4)).toBe('2026-07-19')
    expect(trainingDay('2026-07-20T01:10:00', 4)).toBe('2026-07-19')
  })

  it('rolls over once past the configured hour', () => {
    expect(trainingDay('2026-07-20T04:30:00', 4)).toBe('2026-07-20')
  })
})

describe('daysBetween', () => {
  it('counts whole days', () => {
    expect(daysBetween('2026-07-16', '2026-07-23')).toBe(7)
    expect(daysBetween('2026-06-25', '2026-07-23')).toBe(28)
  })

  it('is unaffected by a DST boundary', () => {
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2)
    expect(daysBetween('2026-10-31', '2026-11-02')).toBe(2)
  })
})

describe('weekly template', () => {
  it('maps Thursday to A and Sunday to B', () => {
    expect(weekdayOfDay('2026-07-23')).toBe(4)
    expect(scheduledSession('2026-07-23', DEFAULT_CONFIG.weeklyTemplate)).toBe('A')
    expect(scheduledSession('2026-07-19', DEFAULT_CONFIG.weeklyTemplate)).toBe('B')
    expect(scheduledSession('2026-07-21', DEFAULT_CONFIG.weeklyTemplate)).toBe('mini')
    expect(scheduledSession('2026-07-22', DEFAULT_CONFIG.weeklyTemplate)).toBeUndefined()
  })
})

describe('resolveSession', () => {
  it('follows the template on a scheduled night', () => {
    expect(resolveSession('2026-07-23', [], DEFAULT_CONFIG)).toEqual({session: 'A', offSchedule: false})
  })

  it('picks the more overdue full session off-template', () => {
    const history = [workout('2026-07-19T23:00:00', 'B'), workout('2026-07-16T23:00:00', 'A')]
    // Wednesday: nothing scheduled. A is older than B, so A is due.
    expect(resolveSession('2026-07-22', history, DEFAULT_CONFIG)).toEqual({session: 'A', offSchedule: true})
  })

  it('starts with A when there is no history', () => {
    expect(resolveSession('2026-07-22', [], DEFAULT_CONFIG)).toEqual({session: 'A', offSchedule: true})
  })
})

describe('fullSessionDays', () => {
  it('ignores mini days — they do not reset the gap clock', () => {
    const history = [
      workout('2026-07-16T23:00:00', 'A'),
      workout('2026-07-21T22:00:00', 'mini'),
      workout('2026-07-19T23:30:00', 'B'),
    ]
    expect(fullSessionDays(history, 4)).toEqual(['2026-07-16', '2026-07-19'])
  })
})
