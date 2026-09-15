import {describe, expect, it} from 'vitest'

import {
  compareAll,
  compareArms,
  eligibleNights,
  OUTCOME_LABELS,
  outcomeValue,
  PRIMARY_OUTCOMES,
} from '../src/engine/stats'
import {NIGHT_RATINGS, SESSION_MEASURES} from '../src/km/fields'
import type {NightRecord, Outcome, SessionMeasure, SessionRecord} from '../src/engine/types'

let nightIdCounter = 0

const night = (overrides: Partial<NightRecord> = {}): NightRecord => ({
  id: overrides.id ?? `night-${nightIdCounter++}`,
  date: '2026-01-01',
  // Open-label by default: only the intervention arm owes a dose.
  doseRequired: overrides.arm === 'intervention',
  ratings: {},
  caffeineLate: false,
  lateMeal: false,
  unusual: false,
  naps: [],
  trained: false,
  ...overrides,
})

const session = (measures: Partial<Record<SessionMeasure, number>>): SessionRecord => ({
  id: 'session',
  source: 'health-connect',
  start: new Date('2026-01-01T23:00:00'),
  end: new Date('2026-01-02T07:00:00'),
  main: true,
  measures,
})

describe('outcomeValue', () => {
  it('reads a rating from night.ratings', () => {
    expect(outcomeValue(night({ratings: {quality: 4}}), 'quality')).toBe(4)
  })

  it('reads a measure from night.main.measures', () => {
    expect(outcomeValue(night({main: session({onsetMinutes: 12})}), 'onsetMinutes')).toBe(12)
  })

  it('is undefined when the night has no main session and the outcome is a measure', () => {
    expect(outcomeValue(night(), 'onsetMinutes')).toBeUndefined()
  })

  it('is undefined when the rating was never recorded', () => {
    expect(outcomeValue(night({ratings: {}}), 'rested')).toBeUndefined()
  })
})

describe('eligibleNights', () => {
  it('drops a night with no arm assigned', () => {
    const withArm = night({arm: 'intervention', ratings: {quality: 3}})
    const noArm = night({ratings: {quality: 3}}) // otherwise identical
    expect(eligibleNights([withArm, noArm], 'quality', 'assigned')).toEqual([withArm])
  })

  it('drops an unusual night by default, and keeps it when excludeUnusual is disabled', () => {
    const usual = night({arm: 'control', ratings: {quality: 3}, unusual: false})
    const unusual = night({arm: 'control', ratings: {quality: 3}, unusual: true})
    expect(eligibleNights([usual, unusual], 'quality', 'assigned')).toEqual([usual])
    expect(eligibleNights([usual, unusual], 'quality', 'assigned', {excludeUnusual: false}))
      .toEqual([usual, unusual])
  })

  it('per-protocol keeps only nights whose dose was ticked, on either arm; an open-label control has no dose and stays', () => {
    const notTaken = night({arm: 'intervention', ratings: {quality: 3}, doseTaken: false})
    const takenUndefined = night({arm: 'intervention', ratings: {quality: 3}}) // no dose block: adherence unknown
    const taken = night({arm: 'intervention', ratings: {quality: 3}, doseTaken: true})
    const control = night({arm: 'control', ratings: {quality: 3}}) // open-label: nothing to take
    // A placebo control owes a dose too (`doseRequired`), whether its block
    // was left unticked or is missing altogether.
    const placeboSkipped = night({arm: 'control', ratings: {quality: 3}, doseRequired: true, doseTaken: false})
    const placeboMissing = night({arm: 'control', ratings: {quality: 3}, doseRequired: true})
    const placeboTaken = night({arm: 'control', ratings: {quality: 3}, doseRequired: true, doseTaken: true})
    const nights = [notTaken, takenUndefined, taken, control, placeboSkipped, placeboMissing, placeboTaken]
    expect(eligibleNights(nights, 'quality', 'assigned')).toEqual(nights) // assigned: all in
    expect(eligibleNights(nights, 'quality', 'per-protocol')).toEqual([taken, control, placeboTaken])
  })

  it('drops a night with no value for the requested outcome, but keeps it for one it has', () => {
    const n = night({arm: 'control', ratings: {rested: 4}}) // no `quality`
    expect(eligibleNights([n], 'quality', 'assigned')).toEqual([])
    expect(eligibleNights([n], 'rested', 'assigned')).toEqual([n])
  })

  it('keeps a transition night by default, and drops it when excludeTransition is set', () => {
    const transition = night({arm: 'intervention', ratings: {quality: 3}, transition: true})
    expect(eligibleNights([transition], 'quality', 'assigned')).toEqual([transition])
    expect(eligibleNights([transition], 'quality', 'assigned', {excludeTransition: true})).toEqual([])
  })

  it('drops a night over the alcohol cap, keeps one at or under it, and keeps one with no alcohol logged', () => {
    const over = night({arm: 'control', ratings: {quality: 3}, alcohol: 3})
    const atCap = night({arm: 'control', ratings: {quality: 3}, alcohol: 2})
    const unlogged = night({arm: 'control', ratings: {quality: 3}})
    const nights = [over, atCap, unlogged]
    expect(eligibleNights(nights, 'quality', 'assigned', {maxAlcohol: 2})).toEqual([atCap, unlogged])
  })
})

/** A perfectly-paired dataset: `pairs` pairs of `periodNights` nights each,
 *  one period per arm, `main.measures.onsetMinutes` set from the supplied
 *  per-night value arrays (indexed pair-major, then within-period). */
const pairedDataset = (
  interventionValues: readonly number[],
  controlValues: readonly number[],
  pairs: number,
  periodNights: number,
): NightRecord[] => {
  const nights: NightRecord[] = []
  let i = 0
  for (let pair = 1; pair <= pairs; pair++) {
    for (let n = 0; n < periodNights; n++, i++) {
      nights.push(night({
        arm: 'intervention',
        pair,
        transition: n === 0,
        main: session({onsetMinutes: interventionValues[i]}),
      }))
    }
  }
  i = 0
  for (let pair = 1; pair <= pairs; pair++) {
    for (let n = 0; n < periodNights; n++, i++) {
      nights.push(night({
        arm: 'control',
        pair,
        transition: n === 0,
        main: session({onsetMinutes: controlValues[i]}),
      }))
    }
  }
  return nights
}

describe('compareArms', () => {
  it('finds a CI clear of zero and a small p-value on a dataset with a real, consistent difference', () => {
    const pairs = 8
    const periodNights = 3
    const n = pairs * periodNights
    // Intervention consistently ~20 minutes shorter, with mild jitter so
    // the arms aren't perfectly separable by variance alone.
    const jitter = (i: number): number => (i % 5) - 2 // -2..2
    const intervention = Array.from({length: n}, (_, i) => 15 + jitter(i))
    const control = Array.from({length: n}, (_, i) => 35 + jitter(i))
    const nights = pairedDataset(intervention, control, pairs, periodNights)

    const result = compareArms(nights, 'onsetMinutes', 'assigned')
    expect(result.nIntervention).toBe(n)
    expect(result.nControl).toBe(n)
    expect(result.difference).toBeCloseTo(-20, 0)
    expect(result.ci).toBeDefined()
    const [lo, hi] = result.ci!
    expect(lo).toBeLessThan(0)
    expect(hi).toBeLessThan(0) // clear of zero, on the "shorter onset" side
    expect(result.p).toBeDefined()
    expect(result.p!).toBeLessThan(0.01)
  })

  it('finds a large p-value and a CI straddling zero on a null dataset', () => {
    const pairs = 8
    const periodNights = 3
    const n = pairs * periodNights
    // Same values regardless of arm: the true difference is exactly 0.
    const jitter = (i: number): number => (i % 5) - 2
    const values = Array.from({length: n}, (_, i) => 20 + jitter(i))
    const nights = pairedDataset(values, values, pairs, periodNights)

    const result = compareArms(nights, 'onsetMinutes', 'assigned')
    expect(result.difference).toBe(0)
    expect(result.p).toBeDefined()
    expect(result.p!).toBeGreaterThan(0.9)
    expect(result.ci).toBeDefined()
    const [lo, hi] = result.ci!
    expect(lo).toBeLessThanOrEqual(0)
    expect(hi).toBeGreaterThanOrEqual(0)
  })

  it('is deterministic for a seed when every night belongs to a pair', () => {
    const pairs = 6
    const periodNights = 3
    const n = pairs * periodNights
    const intervention = Array.from({length: n}, (_, i) => 10 + (i % 3))
    const control = Array.from({length: n}, (_, i) => 12 + (i % 3))
    const nights = pairedDataset(intervention, control, pairs, periodNights)

    const first = compareArms(nights, 'onsetMinutes', 'assigned', {seed: 7})
    const second = compareArms(nights, 'onsetMinutes', 'assigned', {seed: 7})
    expect(second).toEqual(first)
  })

  it('leaves ci/p/paired undefined when either arm has fewer than 2 nights', () => {
    const nights = pairedDataset([10], [20], 1, 1)
    const result = compareArms(nights, 'onsetMinutes', 'assigned')
    expect(result.nIntervention).toBe(1)
    expect(result.nControl).toBe(1)
    expect(result.difference).toBe(-10)
    expect(result.ci).toBeUndefined()
    expect(result.p).toBeUndefined()
    expect(result.paired).toBeUndefined()
  })

  describe('paired estimate', () => {
    it('reports the pair count and the mean of within-pair differences', () => {
      const pairs = 4
      const periodNights = 3
      const n = pairs * periodNights
      // Every pair has the exact same +10 intervention-minus-control gap.
      const intervention = Array.from({length: n}, () => 20)
      const control = Array.from({length: n}, () => 10)
      const nights = pairedDataset(intervention, control, pairs, periodNights)

      const result = compareArms(nights, 'onsetMinutes', 'assigned')
      expect(result.paired).toBeDefined()
      expect(result.paired!.pairs).toBe(pairs)
      expect(result.paired!.difference).toBe(10)
    })

    it('omits the paired CI below 3 pairs, and includes it at 3 or more', () => {
      const periodNights = 3
      const make = (pairs: number): NightRecord[] => {
        const n = pairs * periodNights
        const intervention = Array.from({length: n}, (_, i) => 20 + (i % 3))
        const control = Array.from({length: n}, (_, i) => 10 + (i % 3))
        return pairedDataset(intervention, control, pairs, periodNights)
      }

      const twoPairs = compareArms(make(2), 'onsetMinutes', 'assigned')
      expect(twoPairs.paired?.pairs).toBe(2)
      expect(twoPairs.paired?.ci).toBeUndefined()

      const threePairs = compareArms(make(3), 'onsetMinutes', 'assigned')
      expect(threePairs.paired?.pairs).toBe(3)
      expect(threePairs.paired?.ci).toBeDefined()
    })

    it('excludes a pair missing data on either arm from the paired estimate', () => {
      const nights: NightRecord[] = [
        // Pair 1 and pair 2: both arms present.
        night({arm: 'intervention', pair: 1, main: session({onsetMinutes: 20})}),
        night({arm: 'control', pair: 1, main: session({onsetMinutes: 10})}),
        night({arm: 'intervention', pair: 2, main: session({onsetMinutes: 22})}),
        night({arm: 'control', pair: 2, main: session({onsetMinutes: 11})}),
        // Pair 3 is control-only for this outcome (e.g. the intervention
        // period's watch data never arrived) — it must not contribute a
        // within-pair difference.
        night({arm: 'control', pair: 3, main: session({onsetMinutes: 10})}),
      ]
      const result = compareArms(nights, 'onsetMinutes', 'assigned')
      expect(result.paired?.pairs).toBe(2)
    })
  })
})

describe('compareAll', () => {
  it('returns one comparison per outcome, in the same order as the outcome lists', () => {
    const nights = pairedDataset([10, 11, 12], [20, 21, 22], 1, 3)
    const results = compareAll(nights, 'assigned')
    const expectedOutcomes: Outcome[] = [...SESSION_MEASURES, ...NIGHT_RATINGS]
    expect(results.map(r => r.outcome)).toEqual(expectedOutcomes)
    expect(results).toHaveLength(SESSION_MEASURES.length + NIGHT_RATINGS.length)
  })
})

describe('PRIMARY_OUTCOMES / OUTCOME_LABELS', () => {
  it('pre-registers exactly the three PROTOCOL.md §6 primaries', () => {
    expect(PRIMARY_OUTCOMES).toEqual(['onsetMinutes', 'deepMinutes', 'quality'])
  })

  it('labels every outcome the engine can compare', () => {
    const allOutcomes: Outcome[] = [...SESSION_MEASURES, ...NIGHT_RATINGS]
    for (const outcome of allOutcomes) {
      expect(typeof OUTCOME_LABELS[outcome]).toBe('string')
      expect(OUTCOME_LABELS[outcome].length).toBeGreaterThan(0)
    }
  })
})
