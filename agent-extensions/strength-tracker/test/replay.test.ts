/** The live program's shapes, replayed through parser + engine together.
 *
 *  The unit suites build configs by hand; these fixtures copy the typed
 *  blocks' shapes as they sit in the outline, so a rule that reads a property
 *  differently shows up as a wrong prescription.
 */

import {describe, expect, it} from 'vitest'

import {prescribe} from '../src/engine/prescribe'
import type {SetRecord, WorkoutRecord} from '../src/engine/types'
import {ALT_GROUP_TYPE, EXERCISE_DEF_TYPE, FIELD} from '../src/km/fields'
import {configFromPlan, type PlanNode} from '../src/program/planParser'

const def = (id: string, content: string, properties: Record<string, unknown>): PlanNode => ({
  id,
  content,
  children: [],
  properties: {[FIELD.blockTypes]: [EXERCISE_DEF_TYPE], ...properties},
})

const section = (content: string, children: PlanNode[]): PlanNode => ({id: content, content, children})

const group = (id: string, content: string, defaultId: string, options: PlanNode[]): PlanNode => ({
  id,
  content,
  children: options,
  properties: {[FIELD.blockTypes]: [ALT_GROUP_TYPE], [FIELD.kind]: 'alt-group', [FIELD.altDefault]: defaultId},
})

const MAIN = (sets: number, repMin: number, repMax: number, increment: number) => ({
  [FIELD.kind]: 'main', [FIELD.targetSets]: sets, [FIELD.repMin]: repMin, [FIELD.repMax]: repMax, [FIELD.increment]: increment,
})

const PULL_UPS = def(
  'def-pullups',
  'Pull-ups — 3 sets, add weight at 3×8 (+5 lb)',
  {[FIELD.kind]: 'bodyweight', [FIELD.targetSets]: 3},
)

const plan = (): PlanNode => section('**Strength Plan v2**', [
  section('**Session A (Thu, upper-lean)**', [
    section('Warm-up: 3–5 min shoulder prep', []),
    def('def-bench', 'Bench press — 3×6–10, double progression', MAIN(3, 6, 10, 5)),
    def('def-ohp-light', 'Overhead press (light) — 2×8–12, start @ 70', {...MAIN(2, 8, 12, 5), [FIELD.startWeight]: 70}),
    def('def-row', 'Bent-over row — 3×6–10', MAIN(3, 6, 10, 5)),
  ]),
  section('**Session B (Sun late, lower-lean)**', [
    section('Warm-up: same 3–5 min shoulder prep', []),
    group('group-ohp', 'Overhead press — 3×6–10, FIRST in Session B', 'def-ohp', [
      def('def-ohp', 'Overhead press', {...MAIN(3, 6, 10, 5), [FIELD.totalRepsThreshold]: 26, [FIELD.microIncrement]: 2}),
      def('def-landmine', 'Landmine press', MAIN(3, 6, 10, 5)),
    ]),
    def('def-squat', 'Squat — 3×6–10, double progression', MAIN(3, 6, 10, 10)),
    PULL_UPS,
    def(
      'def-waiter',
      'Waiter carry (one arm, overhead) — 2 lengths per side; start left, match right',
      // The list editor writes text.
      {[FIELD.kind]: 'carry', [FIELD.perSide]: true, [FIELD.ladder]: ['20', '25', '35', '53']},
    ),
  ]),
])

const at = (weight: number, ...reps: number[]): SetRecord[] => reps.map(r => ({weight, reps: r}))

const sessionB = (day: string, exercises: WorkoutRecord['exercises']): WorkoutRecord => ({
  id: day, date: `${day}T12:00:00`, session: 'B', exercises,
})

const pullUps = (day: string, sets: SetRecord[]): WorkoutRecord =>
  sessionB(day, [{exercise: 'Pull-ups', definitionId: 'def-pullups', occurrence: 0, prescribedSets: 3, sets}])

const prescribeFor = (session: 'A' | 'B') => (history: WorkoutRecord[], now: string) => {
  const {config} = configFromPlan(plan())
  return prescribe({history, layoffs: [], config, now, session})
}
const prescribeA = prescribeFor('A')
const prescribeB = prescribeFor('B')

const ohp = (day: string, sets: SetRecord[]): WorkoutRecord =>
  sessionB(day, [{exercise: 'Overhead press', definitionId: 'def-ohp', occurrence: 0, prescribedSets: 3, sets}])

const waiter = (day: string, weight: number): WorkoutRecord => sessionB(day, [{
  exercise: 'Waiter carry',
  definitionId: 'def-waiter',
  occurrence: 0,
  prescribedSets: 2,
  sets: [{weight, reps: 0, side: 'L'}, {weight, reps: 0, side: 'R'}, {weight, reps: 0, side: 'L'}, {weight, reps: 0, side: 'R'}],
}])

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

  it('takes the micro step when the sets total the threshold but one fell short of the top', () => {
    const row = prescribeB([ohp('2026-09-20', at(85, 10, 8, 8))], '2026-09-27T23:00:00')
      .exercises.find(e => e.defId === 'def-ohp')!
    expect(row.weight).toBe(87)
    expect(row.rationale).toContain('26')
  })

  it('totals only the sets it counts, and lists those', () => {
    // A back-off set at another load is not part of the total, so it is not
    // part of the sum shown either.
    const row = prescribeB([ohp('2026-09-20', [...at(85, 10, 7, 6), ...at(65, 12)])], '2026-09-27T23:00:00')
      .exercises.find(e => e.defId === 'def-ohp')!
    expect(row.rationale).toContain('last: 10, 7, 6 = 23')
  })

  it('cuts a laddered lift onto a rung after a layoff', () => {
    const history = [waiter('2026-08-02', 53)]
    const row = prescribeB(history, '2026-08-30T23:00:00').exercises.find(e => e.defId === 'def-waiter')!
    // 28 days off is the 90% row: 47.7 is no kettlebell, 35 is.
    expect(row.weight).toBe(35)
  })

  it('turns the total-reps rule off, and says so, when its step is not smaller than the increment', () => {
    // A micro step of 10 on a +5 lift would pay 10/8/8 more than 10/10/10.
    const tree = plan()
    const sessionB = tree.children[1]
    const group = sessionB.children[1]
    const ohpDef = group.children[0]
    ohpDef.properties = {...ohpDef.properties, [FIELD.microIncrement]: 10}
    const {config, warnings} = configFromPlan(tree)
    expect(warnings.some(w => w.includes(FIELD.microIncrement))).toBe(true)
    const row = prescribe({
      history: [ohp('2026-09-20', at(85, 10, 8, 8))], layoffs: [], config, now: '2026-09-27T23:00:00', session: 'B',
    }).exercises.find(e => e.defId === 'def-ohp')!
    expect(row.weight).toBe(85)
  })

  it('holds the press below the threshold, and says how far off it was', () => {
    const row = prescribeB([ohp('2026-09-20', at(85, 10, 7, 6))], '2026-09-27T23:00:00')
      .exercises.find(e => e.defId === 'def-ohp')!
    expect(row.weight).toBe(85)
    expect(row.rationale).toContain('23')
  })

  it('prescribes the press first in Session B, in outline order', () => {
    const names = prescribeB([], '2026-09-27T23:00:00').exercises.map(e => e.defId)
    expect(names).toEqual(['def-ohp', 'def-squat', 'def-pullups', 'def-waiter'])
  })

  it('starts the new light press at its stated weight, after bench', () => {
    const rows = prescribeA([], '2026-09-24T23:00:00').exercises
    expect(rows.map(e => e.defId)).toEqual(['def-bench', 'def-ohp-light', 'def-row'])
    expect(rows[1].weight).toBe(70)
  })

  it('does not let the heavy press history stand in for the light press', () => {
    const rows = prescribeA([ohp('2026-09-20', at(85, 10, 7, 6))], '2026-09-24T23:00:00').exercises
    expect(rows.find(e => e.defId === 'def-ohp-light')!.weight).toBe(70)
  })

  it('nudges a carry stuck at one weight toward the next rung of its ladder', () => {
    const history = ['2026-08-02', '2026-08-16', '2026-08-23', '2026-09-06', '2026-09-13', '2026-09-20']
      .map(day => waiter(day, 30))
    const row = prescribeB(history, '2026-09-27T23:00:00').exercises.find(e => e.defId === 'def-waiter')!
    // Still the load you carried — a carry is stepped up by hand.
    expect(row.weight).toBe(30)
    expect(row.rationale).toContain('6 sessions')
    expect(row.rationale).toContain('35')
  })
})
