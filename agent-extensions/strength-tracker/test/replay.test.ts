/** The live program's shapes, replayed through parser + engine together.
 *
 *  The unit suites build configs by hand, which is how a typed `kind` that
 *  silently switched progression off got past them: every hand-built pull-up
 *  config said `freeform: false`, and only the parser ever said otherwise.
 *  These fixtures copy the typed blocks as they sit in the outline, so a rule
 *  that reads a property differently shows up as a wrong prescription.
 */

import {describe, expect, it} from 'vitest'

import {prescribe} from '../src/engine/prescribe'
import type {SetRecord, WorkoutRecord} from '../src/engine/types'
import {EXERCISE_DEF_TYPE, FIELD} from '../src/km/fields'
import {configFromPlan, type PlanNode} from '../src/program/planParser'

const def = (id: string, content: string, properties: Record<string, unknown>): PlanNode => ({
  id,
  content,
  children: [],
  properties: {[FIELD.blockTypes]: [EXERCISE_DEF_TYPE], ...properties},
})

const section = (content: string, children: PlanNode[]): PlanNode => ({id: content, content, children})

const PULL_UPS = def(
  'def-pullups',
  'Pull-ups — 3 sets, add weight at 3×8 (+5 lb). 2026-09-24: hit 3×8 @+5 four sessions running without a bump',
  {[FIELD.kind]: 'bodyweight', [FIELD.targetSets]: 3},
)

const plan = (): PlanNode => section('**Strength Plan v2**', [
  section('**Session B (Sun late, lower-lean)**', [
    section('Warm-up: same 3–5 min shoulder prep', []),
    PULL_UPS,
  ]),
])

const at = (weight: number, ...reps: number[]): SetRecord[] => reps.map(r => ({weight, reps: r}))

const sessionB = (day: string, exercises: WorkoutRecord['exercises']): WorkoutRecord => ({
  id: day, date: `${day}T12:00:00`, session: 'B', exercises,
})

const pullUps = (day: string, sets: SetRecord[]): WorkoutRecord =>
  sessionB(day, [{exercise: 'Pull-ups', definitionId: 'def-pullups', occurrence: 0, prescribedSets: 3, sets}])

const prescribeB = (history: WorkoutRecord[], now: string) => {
  const {config} = configFromPlan(plan())
  return prescribe({history, layoffs: [], config, now, session: 'B'})
}

describe('replaying the live log', () => {
  it('adds weight to a bodyweight lift once every set reaches 3×8', () => {
    const history = [
      pullUps('2026-08-16', at(5, 8, 8, 8)),
      pullUps('2026-08-23', at(5, 8, 8, 8)),
      pullUps('2026-09-06', at(5, 8, 8, 8)),
      pullUps('2026-09-13', at(5, 8, 8, 8)),
    ]
    const row = prescribeB(history, '2026-09-20T23:00:00').exercises.find(e => e.exercise === 'Pull-ups')!
    expect(row.weight).toBe(10)
  })

  it('starts adding weight from bodyweight', () => {
    const row = prescribeB([pullUps('2026-09-13', at(0, 8, 8, 8))], '2026-09-20T23:00:00')
      .exercises.find(e => e.exercise === 'Pull-ups')!
    expect(row.weight).toBe(5)
  })
})
