/** The two rules `asWorkout` states that a reader is most likely to get wrong
 *  on its own — both of which have been wrong in a shipped reader before.
 *
 *  Not a walk through every field: the rest of the lens is exercised by the
 *  readers built on it, and mutation-testing confirms the type gate is pinned
 *  by eight integration tests. What is here is what those did NOT catch.
 */

import {describe, expect, it} from 'vitest'

import {dateToDay} from '../src/km/day'
import {FIELD, SET_TYPE, WORKOUT_TYPE} from '../src/km/fields'
import {asSet, asWorkout} from '../src/km/records'

const row = (types: string[], properties: Record<string, unknown> = {}) =>
  ({id: 'b', properties: {types, ...properties}})

describe('asWorkout', () => {
  it('does not call a workout live when its status is absent', () => {
    // `strength:status` has a schema DEFAULT of `in-progress`, so a reader
    // going through the schema gets the opposite answer to this one. That is
    // not hypothetical: `WorkoutFooter` did exactly that, and offered Finish
    // and Discard on a block both writers then refused as `gone` — three
    // readers, three answers, two controls that could never succeed.
    const workout = asWorkout(row([WORKOUT_TYPE]))

    expect(workout).not.toBeNull()
    expect(workout?.live).toBe(false)
    expect(workout?.closed).toBe(false)
    expect(workout?.status).toBeUndefined()
  })

  it('reads a date typed into the property editor as the day it says', () => {
    // The app's `DatePropertyEditor` commits `new Date('YYYY-MM-DD')`, which is
    // UTC MIDNIGHT, while this extension writes local NOON — so west of UTC the
    // instant's local day is the day BEFORE the one typed. Pinned HERE, through
    // the lens every reader now goes through, rather than only on `storedDate`:
    // with the normalisation removed from the lens, `storedDate`'s own tests
    // all still passed, which is precisely the shape of a guard that regresses
    // silently. The suite pins `America/Los_Angeles` — see the vitest configs,
    // where that is load-bearing rather than tidiness.
    const workout = asWorkout(row([WORKOUT_TYPE], {[FIELD.date]: '2026-08-01T00:00:00.000Z'}))

    expect(workout?.on).not.toBeNull()
    expect(dateToDay(workout!.on!)).toBe('2026-08-01')
  })

  it('is null for a block that is not one of ours, however it is broken', () => {
    expect(asWorkout(null)).toBeNull()
    expect(asWorkout(undefined)).toBeNull()
    expect(asWorkout({...row([WORKOUT_TYPE]), deleted: true})).toBeNull()
    expect(asWorkout(row([]))).toBeNull()
    expect(asWorkout(row([SET_TYPE]))).toBeNull()
  })

  it('reports an unreadable date as absent rather than as an invalid instant', () => {
    // `strength:date` is hand-editable, and every caller branches on `on ===
    // null`. Handing back an `Invalid Date` instead would pass that check and
    // then compare as never-equal, which reads as "a different day" rather than
    // "no day at all" — the difference between `undated` and a wrong answer.
    expect(asWorkout(row([WORKOUT_TYPE], {[FIELD.date]: 'not a date'}))?.on).toBeNull()
    expect(asWorkout(row([WORKOUT_TYPE], {[FIELD.date]: 12345}))?.on).toBeNull()
  })
})

describe('asSet', () => {
  it('reads done-ness from the composed todo status, not from existence', () => {
    // A set block's EXISTENCE means prescribed; only the checkbox means
    // performed. Getting that backwards would file every stamped set as work
    // done.
    expect(asSet(row([SET_TYPE]))?.done).toBe(false)
    expect(asSet(row([SET_TYPE], {[FIELD.todoStatus]: 'done'}))?.done).toBe(true)
  })
})
