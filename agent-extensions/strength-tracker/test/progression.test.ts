import {describe, expect, it} from 'vitest'

import {
  lastEntryFor,
  nextWeight,
  progressionSets,
  roundLoad,
  toppedOut,
  workingWeight,
} from '../src/engine/progression'
import type {ExerciseRecord, SetRecord, WorkoutRecord} from '../src/engine/types'

const bench = (sets: SetRecord[], prescribedSets?: number): ExerciseRecord => ({
  exercise: 'Bench press',
  prescribedSets,
  sets,
})

const CONFIG = {sets: 3, repMax: 10, freeform: false, increment: 5}

const at = (weight: number, ...reps: number[]): SetRecord[] =>
  reps.map(r => ({weight, reps: r}))

describe('lastEntryFor with a lift prescribed twice', () => {
  const twice = (): WorkoutRecord[] => [{
    id: 'w1', date: '2026-07-20T18:00:00.000Z', session: 'A',
    exercises: [
      {exercise: 'Squat', definitionId: 'def-squat', occurrence: 0, sets: at(225, 5, 5)},
      {exercise: 'Squat', definitionId: 'def-squat', occurrence: 1, sets: at(185, 8, 8)},
    ],
  }]

  it('gives each occurrence its own baseline', () => {
    // Both rows took the FIRST match, so the back-off row progressed off the
    // heavy row's weight — and reordering the finished entry blocks swapped
    // which weight both rows were built on.
    expect(workingWeight(lastEntryFor(twice(), 'Squat', 'def-squat', 0)!.entry)).toBe(225)
    expect(workingWeight(lastEntryFor(twice(), 'Squat', 'def-squat', 1)!.entry)).toBe(185)
  })

  it('is unmoved by the order the entries happen to be in', () => {
    const reordered = twice()
    reordered[0].exercises = [...reordered[0].exercises].reverse()
    expect(workingWeight(lastEntryFor(reordered, 'Squat', 'def-squat', 0)!.entry)).toBe(225)
    expect(workingWeight(lastEntryFor(reordered, 'Squat', 'def-squat', 1)!.entry)).toBe(185)
  })

  it('falls back to the first match for records written before the number existed', () => {
    const legacy: WorkoutRecord[] = [{
      id: 'w0', date: '2026-07-13T18:00:00.000Z', session: 'A',
      exercises: [{exercise: 'Squat', definitionId: 'def-squat', sets: at(205, 5)}],
    }]
    expect(workingWeight(lastEntryFor(legacy, 'Squat', 'def-squat', 1)!.entry)).toBe(205)
  })
})

describe('two sessions on one day', () => {
  // Every workout's `date` is pinned to LOCAL NOON of its training day (see
  // `dayToDate`), so a second session that day carries a byte-identical
  // timestamp. A strict `>` therefore never prefers it, and which one won was
  // decided by the order the query happened to return rows in — so tomorrow's
  // prescription could be built on the morning's warm-up instead of the
  // evening's real work, and could flip between reloads.
  const sameDay = (): WorkoutRecord[] => [
    {
      id: 'morning', date: '2026-07-20T12:00:00.000Z', session: 'A',
      recordedAt: Date.parse('2026-07-20T09:30:00.000Z'),
      exercises: [{exercise: 'Squat', definitionId: 'def-squat', occurrence: 0, sets: at(185, 5, 5)}],
    },
    {
      id: 'evening', date: '2026-07-20T12:00:00.000Z', session: 'A',
      recordedAt: Date.parse('2026-07-20T19:15:00.000Z'),
      exercises: [{exercise: 'Squat', definitionId: 'def-squat', occurrence: 0, sets: at(245, 5, 5)}],
    },
  ]

  it('takes the one performed later, whichever order they arrive in', () => {
    expect(lastEntryFor(sameDay(), 'Squat', 'def-squat', 0)!.workout.id).toBe('evening')
    expect(lastEntryFor([...sameDay()].reverse(), 'Squat', 'def-squat', 0)!.workout.id).toBe('evening')
  })

  it('still lets a later DAY win, however late in the day the earlier one ran', () => {
    // The day is the primary key and the timestamp only breaks ties within it.
    // Comparing timestamps outright would let a session finished at 19:15 on
    // Monday outrank one dated Tuesday but logged with no times at all.
    const nextDay: WorkoutRecord[] = [...sameDay(), {
      id: 'tuesday', date: '2026-07-21T12:00:00.000Z', session: 'A',
      exercises: [{exercise: 'Squat', definitionId: 'def-squat', occurrence: 0, sets: at(205, 5, 5)}],
    }]
    expect(lastEntryFor(nextDay, 'Squat', 'def-squat', 0)!.workout.id).toBe('tuesday')
  })

  it('does not let a session with no times lose to one that has them', () => {
    // A missing `recordedAt` is "unknown", not "the beginning of time". Read
    // as 0 it ranked FIRST, which is this comparison's own bug mirrored: sets
    // ticked from the OUTLINE go through the native todo checkbox, which
    // writes no `strength:completedAt` — so an evening session logged that way
    // lost to the morning's and handed tomorrow the lighter weights.
    const morningTimed = sameDay()[0]
    const eveningUntimed: WorkoutRecord = {...sameDay()[1], recordedAt: undefined}

    for (const history of [[morningTimed, eveningUntimed], [eveningUntimed, morningTimed]]) {
      // Unordered, so whichever arrives first stands — but the timestamped one
      // must not WIN on the strength of the other having none.
      const winner = lastEntryFor(history, 'Squat', 'def-squat', 0)!.workout.id
      expect(winner).toBe(history[0].id)
    }
  })

  it('leaves records with no times in the order they arrive', () => {
    // Nothing to order them by, so the answer must at least be stable rather
    // than turning on an undefined comparison.
    const untimed: WorkoutRecord[] = sameDay().map(w => ({...w, recordedAt: undefined}))
    expect(lastEntryFor(untimed, 'Squat', 'def-squat', 0)!.workout.id).toBe('morning')
  })
})

describe('lastEntryFor keeps looking for the occurrence it was asked about', () => {
  it('does not take a newer workout\'s other occurrence over an older exact one', () => {
    // Falling back per WORKOUT meant a newer session that only logged the
    // first Squat outranked an older one that logged both — so the back-off
    // row progressed off the heavy row's load again, by a different route.
    const history: WorkoutRecord[] = [
      {
        id: 'w-old', date: '2026-07-13T18:00:00.000Z', session: 'A',
        exercises: [
          {exercise: 'Squat', definitionId: 'def-squat', occurrence: 0, sets: at(225, 5)},
          {exercise: 'Squat', definitionId: 'def-squat', occurrence: 1, sets: at(185, 8)},
        ],
      },
      {
        id: 'w-new', date: '2026-07-20T18:00:00.000Z', session: 'A',
        exercises: [{exercise: 'Squat', definitionId: 'def-squat', occurrence: 0, sets: at(235, 5)}],
      },
    ]
    expect(workingWeight(lastEntryFor(history, 'Squat', 'def-squat', 0)!.entry)).toBe(235)
    expect(workingWeight(lastEntryFor(history, 'Squat', 'def-squat', 1)!.entry)).toBe(185)
  })
})

describe('workingWeight', () => {
  it('takes the modal weight', () => {
    expect(workingWeight(bench([...at(135, 10, 10), ...at(115, 12)]))).toBe(135)
  })

  it('breaks ties heavy', () => {
    expect(workingWeight(bench([...at(135, 8), ...at(140, 6)]))).toBe(140)
  })

  it('is undefined with no sets', () => {
    expect(workingWeight(bench([]))).toBeUndefined()
  })
})

describe('progressionSets', () => {
  it('passes through when nothing is sided', () => {
    const sets = at(135, 10, 10)
    expect(progressionSets(sets)).toEqual(sets)
  })

  it('judges single-arm work off the left side — left sets the reps', () => {
    const sets: SetRecord[] = [
      {weight: 35, reps: 8, side: 'L'},
      {weight: 35, reps: 10, side: 'R'},
    ]
    expect(progressionSets(sets)).toEqual([{weight: 35, reps: 8, side: 'L'}])
  })
})

describe('toppedOut', () => {
  it('is true when every prescribed set hit the top of the range', () => {
    expect(toppedOut(bench(at(135, 10, 10, 10)), CONFIG)).toBe(true)
  })

  it('is false when one set fell short', () => {
    expect(toppedOut(bench(at(135, 10, 10, 9)), CONFIG)).toBe(false)
  })

  it('is false when fewer than the prescribed sets were done', () => {
    expect(toppedOut(bench(at(135, 10, 10)), CONFIG)).toBe(false)
  })

  it('judges against the sets prescribed at the time, not today config', () => {
    // Two sets were prescribed (first session back from a layoff) and both
    // topped out — that counts, even though config now says three.
    expect(toppedOut(bench(at(135, 10, 10), 2), CONFIG)).toBe(true)
  })

  it('never fires for freeform work', () => {
    expect(toppedOut(bench(at(35, 2, 2)), {...CONFIG, freeform: true})).toBe(false)
  })
})

describe('nextWeight', () => {
  it('adds the increment once the range is cleared', () => {
    expect(nextWeight(bench(at(135, 10, 10, 10)), CONFIG)).toEqual({weight: 140, progressed: true})
  })

  it('repeats the weight otherwise', () => {
    expect(nextWeight(bench(at(135, 8, 9, 10)), CONFIG)).toEqual({weight: 135, progressed: false})
  })

  const CATCHUP = {sets: 2, repMax: 8, freeform: false, increment: 10, catchUpIncrement: 20, catchUpRpe: 7}
  const dl = (sets: SetRecord[]): ExerciseRecord => ({exercise: 'Deadlift', sets})
  const rep = (weight: number, reps: number, rpe: number): SetRecord => ({weight, reps, rpe})

  it('takes the bigger catch-up jump when topped and every set is RPE ≤ threshold', () => {
    expect(nextWeight(dl([rep(225, 8, 7), rep(225, 8, 6)]), CATCHUP)).toEqual({weight: 245, progressed: true})
  })

  it('takes only the normal jump when a set is above the RPE threshold', () => {
    expect(nextWeight(dl([rep(225, 8, 7), rep(225, 8, 8)]), CATCHUP)).toEqual({weight: 235, progressed: true})
  })

  it('takes only the normal jump when RPE is not logged (no evidence it was easy)', () => {
    expect(nextWeight(dl(at(225, 8, 8)), CATCHUP)).toEqual({weight: 235, progressed: true})
  })

  it('holds when the caller says to', () => {
    expect(nextWeight(bench(at(135, 10, 10, 10)), CONFIG, {hold: true}))
      .toEqual({weight: 135, progressed: false})
  })
})

describe('lastEntryFor', () => {
  it('picks the newest workout containing the exercise', () => {
    const history: WorkoutRecord[] = [
      {id: '1', date: '2026-07-09T23:00:00', session: 'A', exercises: [bench(at(130, 10, 10, 10))]},
      {id: '2', date: '2026-07-16T23:00:00', session: 'A', exercises: [bench(at(135, 8, 8, 8))]},
    ]
    expect(lastEntryFor(history, 'Bench press')?.workout.id).toBe('2')
    expect(lastEntryFor(history, 'Squat')).toBeUndefined()
  })

  it('skips entries with no logged sets', () => {
    const history: WorkoutRecord[] = [
      {id: '1', date: '2026-07-09T23:00:00', session: 'A', exercises: [bench(at(130, 10))]},
      {id: '2', date: '2026-07-16T23:00:00', session: 'A', exercises: [bench([])]},
    ]
    expect(lastEntryFor(history, 'Bench press')?.workout.id).toBe('1')
  })

  it('follows the plan block through a rename', () => {
    const history: WorkoutRecord[] = [{
      id: '1', date: '2026-07-09T23:00:00', session: 'A',
      exercises: [{...bench(at(130, 10)), definitionId: 'def-bench'}],
    }]
    // The plan block was renamed after this was logged; the id still matches.
    expect(lastEntryFor(history, 'Barbell bench press', 'def-bench')?.workout.id).toBe('1')
  })

  it('keeps two definitions that share a name on separate lines', () => {
    const history: WorkoutRecord[] = [{
      id: '1', date: '2026-07-09T23:00:00', session: 'A',
      exercises: [{...bench(at(130, 10)), definitionId: 'def-old'}],
    }]
    expect(lastEntryFor(history, 'Bench press', 'def-new')).toBeUndefined()
  })

  it('falls back to the name for entries logged before definition links', () => {
    const history: WorkoutRecord[] = [
      {id: '1', date: '2026-07-09T23:00:00', session: 'A', exercises: [bench(at(130, 10))]},
    ]
    expect(lastEntryFor(history, 'Bench press', 'def-bench')?.workout.id).toBe('1')
  })
})

describe('roundLoad', () => {
  it('rounds down onto loadable plates', () => {
    expect(roundLoad(121.5, 5)).toBe(120)
    expect(roundLoad(135, 5)).toBe(135)
  })
})
