/** The comparison a protocol page pre-registers (README, "Writing the
 *  protocol page"): eligibility, means,
 *  bootstrap CI, a pair-respecting permutation p-value, and the paired
 *  (within-pair) estimate as a check.
 *
 *  Seeded throughout (`mulberry32`) so a given seed reproduces the same CI
 *  and p-value on every device — the same reason the schedule itself is
 *  seeded.
 */

import {NIGHT_RATINGS, SESSION_MEASURES} from '../km/fields'
import {mulberry32} from './prng'
import type {Arm, Comparison, NightRating, NightRecord, Outcome, Population, SessionMeasure} from './types'

const BOOTSTRAP_DRAWS = 2000
const PERMUTATION_DRAWS = 2000

const round3 = (n: number): number => Math.round(n * 1000) / 1000
const mean = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0) / values.length

const isNightRating = (outcome: Outcome): outcome is NightRating =>
  (NIGHT_RATINGS as readonly string[]).includes(outcome)

export const outcomeValue = (night: NightRecord, outcome: Outcome): number | undefined =>
  isNightRating(outcome) ? night.ratings[outcome] : night.main?.measures[outcome as SessionMeasure]

export interface EligibilityOptions {
  /** Drop the first night of each period. Off by default — the primary
   *  analysis keeps transition nights; dropping them is a sensitivity check. */
  excludeTransition?: boolean
  /** Drop nights whose logged alcohol count exceeds this. Nights with no
   *  alcohol logged are never dropped by this option alone. */
  maxAlcohol?: number
  /** Drop nights flagged `unusual`. On by default — it's a pre-registered
   *  exclusion, not a sensitivity toggle. */
  excludeUnusual?: boolean
}

export const eligibleNights = (
  nights: readonly NightRecord[],
  outcome: Outcome,
  population: Population,
  options: EligibilityOptions = {},
): NightRecord[] => {
  const {excludeTransition = false, maxAlcohol, excludeUnusual = true} = options
  return nights.filter(night => {
    // No arm means the night predates the experiment's first period (a
    // baseline night) or was never assigned — excluded either way.
    if (night.arm === undefined) return false
    if (excludeUnusual && night.unusual) return false
    // Per protocol: a night with a dose block counts only if it was ticked —
    // on BOTH arms, since a placebo control has one too. An intervention
    // night with no dose block at all has unknown adherence and is dropped;
    // an open-label control night has nothing to take and stays.
    if (population === 'per-protocol') {
      if (night.doseTaken === false) return false
      if (night.arm === 'intervention' && night.doseTaken === undefined) return false
    }
    if (outcomeValue(night, outcome) === undefined) return false
    if (excludeTransition && night.transition === true) return false
    if (maxAlcohol !== undefined && night.alcohol !== undefined && night.alcohol > maxAlcohol) return false
    return true
  })
}

export interface CompareOptions extends EligibilityOptions {
  /** PRNG seed for the bootstrap/permutation draws. Fixed default so a bare
   *  call is still reproducible. */
  seed?: number
}

const resample = (values: readonly number[], rng: () => number): number[] =>
  values.map(() => values[Math.floor(rng() * values.length)])

/** Linear-interpolated percentile of an already-sorted array. */
const percentile = (sorted: readonly number[], p: number): number => {
  const index = p * (sorted.length - 1)
  const lo = Math.floor(index)
  const hi = Math.ceil(index)
  if (lo === hi) return sorted[lo]
  const frac = index - lo
  return sorted[lo] * (1 - frac) + sorted[hi] * frac
}

const bootstrapCI = (
  interventionValues: readonly number[],
  controlValues: readonly number[],
  rng: () => number,
): [number, number] => {
  const diffs = Array.from(
    {length: BOOTSTRAP_DRAWS},
    () => mean(resample(interventionValues, rng)) - mean(resample(controlValues, rng)),
  ).sort((a, b) => a - b)
  return [round3(percentile(diffs, 0.025)), round3(percentile(diffs, 0.975))]
}

const flipArm = (arm: Arm): Arm => (arm === 'intervention' ? 'control' : 'intervention')

/** One permutation of arm labels, respecting the randomization actually
 *  done: nights sharing a `pair` are swapped (or not) as a block — the
 *  whole pair keeps whichever assignment it "would have" drawn — since
 *  that's the only relabeling consistent with how the schedule was
 *  randomized. Nights with no pair (e.g. carried over from a differently
 *  shaped schedule) are shuffled freely among themselves instead. */
const permuteLabels = (labeled: readonly {arm: Arm; pair?: number}[], rng: () => number): Arm[] => {
  const byPair = new Map<number, number[]>()
  const unpairedIndices: number[] = []
  labeled.forEach((item, index) => {
    if (item.pair === undefined) {
      unpairedIndices.push(index)
      return
    }
    const indices = byPair.get(item.pair) ?? []
    indices.push(index)
    byPair.set(item.pair, indices)
  })

  const arms = labeled.map(l => l.arm)

  // Map iteration is insertion order, so this consumes the rng in a fixed
  // order for a given input — required for the draws to be reproducible.
  for (const indices of byPair.values()) {
    if (rng() < 0.5) {
      for (const index of indices) arms[index] = flipArm(labeled[index].arm)
    }
  }

  const unpairedArms = unpairedIndices.map(i => labeled[i].arm)
  for (let i = unpairedArms.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[unpairedArms[i], unpairedArms[j]] = [unpairedArms[j], unpairedArms[i]]
  }
  unpairedIndices.forEach((index, i) => { arms[index] = unpairedArms[i] })

  return arms
}

const permutationP = (
  eligible: readonly NightRecord[],
  outcome: Outcome,
  observedDifference: number,
  rng: () => number,
): number => {
  const labeled = eligible.map(n => ({value: outcomeValue(n, outcome) as number, arm: n.arm as Arm, pair: n.pair}))
  let count = 0
  let valid = 0
  for (let i = 0; i < PERMUTATION_DRAWS; i++) {
    const arms = permuteLabels(labeled, rng)
    const interventionValues = labeled.filter((_, idx) => arms[idx] === 'intervention').map(l => l.value)
    const controlValues = labeled.filter((_, idx) => arms[idx] === 'control').map(l => l.value)
    // A degenerate split (every night landed on one arm) can't be compared
    // and is not a draw: it leaves the denominator as well as the numerator.
    if (interventionValues.length === 0 || controlValues.length === 0) continue
    valid += 1
    const diff = mean(interventionValues) - mean(controlValues)
    if (Math.abs(diff) >= Math.abs(observedDifference)) count++
  }
  // Add-one smoothing: a p-value of exactly 0 would overstate the evidence
  // a finite number of permutations can provide.
  return (count + 1) / (valid + 1)
}

const pairedEstimate = (
  eligible: readonly NightRecord[],
  outcome: Outcome,
  rng: () => number,
): Comparison['paired'] => {
  const byPair = new Map<number, NightRecord[]>()
  for (const night of eligible) {
    if (night.pair === undefined) continue
    const nights = byPair.get(night.pair) ?? []
    nights.push(night)
    byPair.set(night.pair, nights)
  }

  const pairDifferences: number[] = []
  for (const nights of byPair.values()) {
    const interventionValues = nights.filter(n => n.arm === 'intervention').map(n => outcomeValue(n, outcome) as number)
    const controlValues = nights.filter(n => n.arm === 'control').map(n => outcomeValue(n, outcome) as number)
    if (interventionValues.length === 0 || controlValues.length === 0) continue
    pairDifferences.push(mean(interventionValues) - mean(controlValues))
  }
  if (pairDifferences.length === 0) return undefined

  const result: {pairs: number; difference: number; ci?: [number, number]} = {
    pairs: pairDifferences.length,
    difference: round3(mean(pairDifferences)),
  }

  if (pairDifferences.length >= 3) {
    const diffs = Array.from({length: BOOTSTRAP_DRAWS}, () => mean(resample(pairDifferences, rng))).sort((a, b) => a - b)
    result.ci = [round3(percentile(diffs, 0.025)), round3(percentile(diffs, 0.975))]
  }

  return result
}

export const compareArms = (
  nights: readonly NightRecord[],
  outcome: Outcome,
  population: Population,
  options: CompareOptions = {},
): Comparison => {
  const {seed = 1} = options
  const eligible = eligibleNights(nights, outcome, population, options)
  const interventionValues = eligible.filter(n => n.arm === 'intervention').map(n => outcomeValue(n, outcome) as number)
  const controlValues = eligible.filter(n => n.arm === 'control').map(n => outcomeValue(n, outcome) as number)

  const comparison: Comparison = {
    outcome,
    population,
    nIntervention: interventionValues.length,
    nControl: controlValues.length,
  }
  if (interventionValues.length > 0) comparison.meanIntervention = round3(mean(interventionValues))
  if (controlValues.length > 0) comparison.meanControl = round3(mean(controlValues))
  if (interventionValues.length > 0 && controlValues.length > 0) {
    comparison.difference = round3(mean(interventionValues) - mean(controlValues))
  }

  // Below n=2 on either arm, a resampled mean is either undefined or a
  // single repeated point — not a real interval. Distinct rng streams per
  // draw kind (seed, seed+1, seed+2) so adding the paired estimate later
  // never shifts the bootstrap/permutation sequences already published.
  if (interventionValues.length >= 2 && controlValues.length >= 2) {
    comparison.ci = bootstrapCI(interventionValues, controlValues, mulberry32(seed))
    comparison.p = round3(
      permutationP(eligible, outcome, mean(interventionValues) - mean(controlValues), mulberry32(seed + 1)),
    )
    const paired = pairedEstimate(eligible, outcome, mulberry32(seed + 2))
    if (paired) comparison.paired = paired
  }

  return comparison
}

export const compareAll = (
  nights: readonly NightRecord[],
  population: Population,
  options: CompareOptions = {},
): Comparison[] =>
  ([...SESSION_MEASURES, ...NIGHT_RATINGS] as Outcome[]).map(outcome => compareArms(nights, outcome, population, options))

/** The three primaries of the glycine protocol — the ones the dashboard
 *  marks; every other outcome is shown as secondary. */
export const PRIMARY_OUTCOMES: Outcome[] = ['onsetMinutes', 'deepMinutes', 'quality']

export const OUTCOME_LABELS: Record<Outcome, string> = {
  onsetMinutes: 'Onset latency (min)',
  sleepMinutes: 'Total sleep time (min)',
  inBedMinutes: 'Time in bed (min)',
  efficiency: 'Efficiency',
  deepMinutes: 'Deep sleep (min)',
  remMinutes: 'REM sleep (min)',
  lightMinutes: 'Light sleep (min)',
  awakeMinutes: 'Awake after onset (min)',
  awakenings: 'Awakenings (count)',
  hrMean: 'Mean heart rate (bpm)',
  hrMin: 'Min heart rate (bpm)',
  hrv: 'HRV RMSSD (ms)',
  spo2: 'SpO2 (%)',
  skinTemp: 'Skin temp Δ (°C)',
  respRate: 'Respiratory rate (br/min)',
  score: 'Samsung score',
  quality: 'Sleep quality (1–5)',
  rested: 'Restedness (1–5)',
  ease: 'Ease of falling asleep (1–5)',
  sleepiness: 'Afternoon sleepiness (KSS 1–9)',
}
