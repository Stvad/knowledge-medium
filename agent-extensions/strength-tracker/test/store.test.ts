import {describe, expect, it} from 'vitest'

import {buildHistory, buildLayoffs, buildLiveWorkouts} from '../src/km/history'
import {dateToDay, dayToDate} from '../src/km/day'
import {FIELD} from '../src/km/fields'
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

const setBlock = (id: string, parentId: string, orderKey: string, weight: number, reps: number, extra: Array<[string, unknown]> = []) =>
  block(id, parentId, orderKey, encode([[FIELD.weight, weight], [FIELD.reps, reps], [FIELD.todoStatus, 'done'], ...extra]))

describe('buildHistory', () => {
  it('assembles workouts, exercise entries, and their done set blocks', () => {
    const workout = block('w1', 'page', 'a0', encode([
      [FIELD.session, 'A'],
      [FIELD.date, dayToDate('2026-07-16')],
      [FIELD.status, 'done'],
    ]))
    const bench = block('e1', 'w1', 'a0', encode([[FIELD.exercise, 'Bench press'], [FIELD.prescribedSets, 3]]))
    const row = block('e2', 'w1', 'a1', encode([[FIELD.exercise, 'Bent-over row']]))
    const sets = [
      setBlock('s1', 'e1', 'a0', 135, 10),
      setBlock('s2', 'e1', 'a1', 135, 10),
      setBlock('s3', 'e2', 'a0', 95, 8),
      // an un-accepted set is ignored
      block('s4', 'e1', 'a2', encode([[FIELD.weight, 135], [FIELD.reps, 4], [FIELD.todoStatus, 'open']])),
    ]

    const history = buildHistory([workout], [bench, row], sets)
    expect(history).toHaveLength(1)
    expect(history[0].session).toBe('A')
    expect(dateToDay(new Date(history[0].date))).toBe('2026-07-16')
    expect(history[0].exercises.map(e => e.exercise)).toEqual(['Bench press', 'Bent-over row'])
    expect(history[0].exercises[0].sets).toEqual([{weight: 135, reps: 10}, {weight: 135, reps: 10}])
    expect(history[0].exercises[0].prescribedSets).toBe(3)
  })

  it('carries the definition link so progression can follow a renamed lift', () => {
    const workout = block('w1', 'page', 'a0', encode([
      [FIELD.session, 'A'], [FIELD.date, dayToDate('2026-07-16')], [FIELD.status, 'done'],
    ]))
    const bench = block('e1', 'w1', 'a0', encode([
      [FIELD.exercise, 'Bench press'], [FIELD.definition, 'def-bench'],
    ]))
    const history = buildHistory([workout], [bench], [setBlock('s1', 'e1', 'a0', 135, 10)])
    expect(history[0].exercises[0].definitionId).toBe('def-bench')
  })

  it('excludes in-progress workouts from history', () => {
    const wip = block('w1', 'page', 'a0', encode([
      [FIELD.session, 'A'], [FIELD.date, dayToDate('2026-07-16')], [FIELD.status, 'in-progress'],
    ]))
    expect(buildHistory([wip], [], [])).toHaveLength(0)
  })

  it('orders workouts by logged date', () => {
    const mk = (id: string, day: string) => block(id, 'page', 'a0', encode([
      [FIELD.session, 'A'], [FIELD.date, dayToDate(day)], [FIELD.status, 'done'],
    ]))
    const history = buildHistory([mk('w2', '2026-07-23'), mk('w1', '2026-07-16')], [], [])
    expect(history.map(w => w.id)).toEqual(['w1', 'w2'])
  })
})

describe('buildLiveWorkouts', () => {
  it('surfaces only in-progress workouts, keeping every set (done or not) with its id', () => {
    const wip = block('w9', 'page', 'a0', encode([
      [FIELD.session, 'B'], [FIELD.date, dayToDate('2026-07-19')], [FIELD.status, 'in-progress'],
    ]))
    const squat = block('e9', 'w9', 'a0', encode([[FIELD.exercise, 'Squat'], [FIELD.unit, 'lb']]))
    const sets = [
      setBlock('s1', 'e9', 'a0', 185, 8),
      block('s2', 'e9', 'a1', encode([[FIELD.weight, 185], [FIELD.reps, 8], [FIELD.todoStatus, 'open']])),
    ]
    const live = buildLiveWorkouts([wip], [squat], sets)
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({id: 'w9', day: '2026-07-19', session: 'B'})
    expect(live[0].exercises[0].id).toBe('e9')
    expect(live[0].exercises[0].sets.map(s => [s.id, s.done])).toEqual([['s1', true], ['s2', false]])
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
