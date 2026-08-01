import {describe, expect, it} from 'vitest'

import {buildAltChoices, buildHistory, buildLayoffs} from '../src/km/history'
import {dateToDay, dayToDate} from '../src/km/day'
import {FIELD} from '../src/km/fields'
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
    // Each carries a done set, because a closed workout with none is not
    // history at all — see the test below.
    const mk = (id: string, day: string) => block(id, 'page', 'a0', encode([
      [FIELD.session, 'A'], [FIELD.date, dayToDate(day)], [FIELD.status, 'done'],
    ]))
    const history = buildHistory(
      [mk('w2', '2026-07-23'), mk('w1', '2026-07-16')],
      [block('e1', 'w1', 'a0', encode([[FIELD.exercise, 'Bench press']])),
       block('e2', 'w2', 'a0', encode([[FIELD.exercise, 'Bench press']]))],
      [setBlock('s1', 'e1', 'a0', 135, 5), setBlock('s2', 'e2', 'a0', 135, 5)])
    expect(history.map(w => w.id)).toEqual(['w1', 'w2'])
  })

  it('excludes a closed workout that has no done sets left', () => {
    // Finish refuses to close one, so this is a CORRECTION after the fact —
    // unticking everything, which means "I did not actually do that". It must
    // leave history rather than merely lose its progression baseline:
    // `fullSessionDays` counts a record by its session TYPE alone, so an
    // emptied A/B session would still reset the layoff gap and increment
    // `sessionsBack`, and `resolveSession` would still read it as "A was done
    // recently" when choosing what to prescribe next.
    const emptied = block('w1', 'page', 'a0', encode([
      [FIELD.session, 'A'], [FIELD.date, dayToDate('2026-07-16')], [FIELD.status, 'done'],
    ]))
    const bench = block('e1', 'w1', 'a0', encode([[FIELD.exercise, 'Bench press']]))
    const untickedSet = block('s1', 'e1', 'a0',
      encode([[FIELD.weight, 135], [FIELD.reps, 5], [FIELD.todoStatus, 'open']]))

    expect(buildHistory([emptied], [bench], [untickedSet])).toHaveLength(0)
    // …and one set left ticked is still a training day: the rule is "no work
    // performed", not "the ticks were edited".
    expect(buildHistory([emptied], [bench], [setBlock('s1', 'e1', 'a0', 135, 5)])).toHaveLength(1)
  })

  it('keeps a session where one lift was done and another skipped entirely', () => {
    // EVERY entry, not some. Skipping a lift outright — no set ticked on it —
    // is an ordinary night, and reading the rule as "any empty entry" would
    // drop the whole session from history over the accessory you left out,
    // taking the working lift's progression with it.
    const workout = block('w1', 'page', 'a0', encode([
      [FIELD.session, 'A'], [FIELD.date, dayToDate('2026-07-16')], [FIELD.status, 'done'],
    ]))
    const done = block('e1', 'w1', 'a0', encode([[FIELD.exercise, 'Bench press']]))
    const skipped = block('e2', 'w1', 'a1', encode([[FIELD.exercise, 'Face pulls']]))

    const history = buildHistory([workout], [done, skipped], [
      setBlock('s1', 'e1', 'a0', 135, 5),
      block('s2', 'e2', 'a0', encode([[FIELD.weight, 30], [FIELD.reps, 15], [FIELD.todoStatus, 'open']])),
    ])

    expect(history).toHaveLength(1)
    // The skipped lift stays in the record as an entry with no sets — it was
    // prescribed and not performed, and `lastEntryFor` keeps looking past it.
    expect(history[0].exercises.map(e => e.sets.length)).toEqual([1, 0])
  })
})

describe('buildAltChoices', () => {
  it('maps each answered or-group to its tracked option', () => {
    const choice = (id: string, group: string, option: string) =>
      block(id, 'settings', id, encode([[FIELD.choiceGroup, group], [FIELD.choiceOption, option]]))
    expect(buildAltChoices([choice('c1', 'g1', 'opt-rdl'), choice('c2', 'g2', 'opt-ohp')]))
      .toEqual({g1: 'opt-rdl', g2: 'opt-ohp'})
  })

  it('ignores a half-written choice rather than guessing', () => {
    const orphan = block('c1', 'settings', 'a0', encode([[FIELD.choiceGroup, 'g1']]))
    expect(buildAltChoices([orphan])).toEqual({})
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
