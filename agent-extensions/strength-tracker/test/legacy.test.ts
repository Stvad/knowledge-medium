import {describe, expect, it} from 'vitest'

import {readLegacySets} from '../src/km/legacy'

describe('reading the legacy sets cell', () => {
  it('reads the encoded string a json property actually holds', () => {
    expect(readLegacySets(JSON.stringify([
      {weight: 185, reps: 8, rpe: 7, completedAt: 1_700_000_000_000},
      {weight: 185, reps: 6, side: 'L'},
    ]))).toEqual([
      {weight: 185, reps: 8, done: true, rpe: 7, completedAt: 1_700_000_000_000},
      {weight: 185, reps: 6, done: true, side: 'L'},
    ])
  })

  it('reads an already-decoded array too', () => {
    expect(readLegacySets([{weight: 45, reps: 12}]))
      .toEqual([{weight: 45, reps: 12, done: true}])
  })

  it('marks every legacy set done', () => {
    // The old writer only ever wrote at the END of a session, so there is no
    // pre-filled row in that data. Recorded as open todos, this whole history
    // would be invisible to `buildHistory` — which counts done sets only —
    // and the migration would silently erase years of training.
    const sets = readLegacySets([{weight: 100, reps: 5}, {weight: 100, reps: 5}])!
    expect(sets.every(s => s.done)).toBe(true)
  })

  it('refuses the whole entry when any set is unreadable', () => {
    // Half-converting a training record is worse than leaving it: the half
    // that lands looks complete to every reader, and the other half is only
    // findable by noticing the numbers are wrong months later.
    expect(readLegacySets([{weight: 185, reps: 8}, {weight: 'heavy', reps: 8}])).toBeUndefined()
    expect(readLegacySets([{weight: 185}])).toBeUndefined()
    expect(readLegacySets([null])).toBeUndefined()
  })

  it('says nothing to do for an absent, empty or unparseable cell', () => {
    expect(readLegacySets(undefined)).toBeUndefined()
    expect(readLegacySets(null)).toBeUndefined()
    expect(readLegacySets('[]')).toBeUndefined()
    expect(readLegacySets([])).toBeUndefined()
    expect(readLegacySets('not json')).toBeUndefined()
    expect(readLegacySets(42)).toBeUndefined()
  })

  it('drops a field it cannot read rather than the set that carries it', () => {
    // rpe/side/completedAt are texture, not the record. An entry whose rpe is
    // a string is still a set that was performed.
    expect(readLegacySets([{weight: 185, reps: 8, rpe: 'hard', side: 'X', completedAt: 'noon'}]))
      .toEqual([{weight: 185, reps: 8, done: true}])
  })
})
