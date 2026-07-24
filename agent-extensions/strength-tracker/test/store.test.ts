import {describe, expect, it} from 'vitest'

import {buildHistory, buildLayoffs} from '../src/km/history'
import {dateToDay, dayToDate} from '../src/km/day'
import {FIELD, type StoredSet} from '../src/km/fields'
import {detectLeftRightAsymmetry, shoulderChecklist} from '../src/engine/shoulder'
import type {WorkoutRecord} from '../src/engine/types'

/** Build the encoded `properties` map a real row carries: dates as ISO
 *  strings, everything else identity. */
const encode = (pairs: Array<[string, unknown]>) => {
  const props: Record<string, unknown> = {}
  for (const [name, value] of pairs) {
    props[name] = value instanceof Date ? value.toISOString() : value
  }
  return props
}

const block = (id: string, parentId: string | null, orderKey: string, properties: Record<string, unknown>) => ({
  id, parentId, orderKey, properties,
})

describe('day round-trip', () => {
  it('survives Date ↔ day-string', () => {
    expect(dateToDay(dayToDate('2026-07-23'))).toBe('2026-07-23')
  })
})

describe('buildHistory', () => {
  it('assembles workouts and their exercise entries from encoded blocks', () => {
    const sets: StoredSet[] = [{weight: 135, reps: 10}, {weight: 135, reps: 10}, {weight: 135, reps: 10}]
    const workout = block('w1', 'page', 'a0', encode([
      [FIELD.session, 'A'],
      [FIELD.date, dayToDate('2026-07-16')],
    ]))
    const bench = block('e1', 'w1', 'a0', encode([
      [FIELD.exercise, 'Bench press'],
      [FIELD.sets, sets],
      [FIELD.prescribedSets, 3],
    ]))
    const row = block('e2', 'w1', 'a1', encode([
      [FIELD.exercise, 'Bent-over row'],
      [FIELD.sets, [{weight: 95, reps: 8}]],
    ]))

    const history = buildHistory([workout], [bench, row])
    expect(history).toHaveLength(1)
    expect(history[0].session).toBe('A')
    expect(dateToDay(new Date(history[0].date))).toBe('2026-07-16')
    expect(history[0].exercises.map(e => e.exercise)).toEqual(['Bench press', 'Bent-over row'])
    expect(history[0].exercises[0].sets).toEqual(sets)
    expect(history[0].exercises[0].prescribedSets).toBe(3)
  })

  it('orders workouts by logged date and entries by order key', () => {
    const mk = (id: string, day: string) => block(id, 'page', 'a0', encode([
      [FIELD.session, 'A'], [FIELD.date, dayToDate(day)],
    ]))
    const history = buildHistory([mk('w2', '2026-07-23'), mk('w1', '2026-07-16')], [])
    expect(history.map(w => w.id)).toEqual(['w1', 'w2'])
  })
})

describe('buildLayoffs', () => {
  it('reconstructs layoff records', () => {
    const layoff = block('l1', 'page', 'a0', encode([
      [FIELD.layoffFrom, dayToDate('2026-07-03')],
      [FIELD.layoffTo, dayToDate('2026-07-23')],
      [FIELD.layoffDays, 20],
      [FIELD.layoffTier, '2-4w'],
      [FIELD.layoffPct, 0.9],
    ]))
    expect(buildLayoffs([layoff])).toEqual([
      {id: 'l1', from: '2026-07-03', to: '2026-07-23', days: 20, tierId: '2-4w', pct: 0.9},
    ])
  })
})

describe('shoulder checklist', () => {
  const waiter = (l: number, r: number): WorkoutRecord => ({
    id: 'b', date: '2026-07-19T23:00:00', session: 'B',
    exercises: [{exercise: 'Waiter carry', sets: [
      {weight: l, reps: 4, side: 'L'},
      {weight: r, reps: 4, side: 'R'},
    ]}],
  })

  it('flags left/right asymmetry when the right outpaces the left', () => {
    expect(detectLeftRightAsymmetry([waiter(35, 45)])).toBe(true)
    expect(detectLeftRightAsymmetry([waiter(40, 40)])).toBe(false)
  })

  it('pre-checks the asymmetry trigger in the checklist', () => {
    const checklist = shoulderChecklist([waiter(35, 45)])
    expect(checklist.find(t => t.id === 'left-plateau')?.autoFlag).toBe(true)
    expect(checklist.every(t => t.id === 'left-plateau' || !t.autoFlag)).toBe(true)
  })
})
