/** Block schema for Sleep Lab.
 *
 *  Everything the extension records is a plain block with typed properties,
 *  so the data stays queryable via SQL, hand-editable in the outline, and
 *  meaningful with the extension uninstalled. Tree and identities: README.
 */

import {ChangeScope, seedProperty, seedType} from '@/data/api/index.js'
import {
  extensionPropertySeedKey,
  extensionTypeSeedKey,
} from '@/extensions/dynamicExtensionSeeds.js'

import {
  DOSE_TYPE,
  EXPERIMENT_TYPE,
  FIELD,
  LAB_TYPE,
  NIGHT_TYPE,
  PERIOD_TYPE,
  SESSION_TYPE,
  type Arm,
  type ControlKind,
  type ExperimentStatus,
  type SessionSource,
} from './fields'

export {
  DOSE_TYPE, EXPERIMENT_TYPE, FIELD, LAB_TYPE, NIGHT_TYPE, PERIOD_TYPE, SESSION_TYPE,
} from './fields'

const scope = ChangeScope.BlockDefault

const optionalNumber = (seed: string, name: string) => seedProperty({
  seedKey: extensionPropertySeedKey(seed),
  revision: 1,
  name,
  preset: 'optional-number',
  defaultValue: undefined,
  changeScope: scope,
})

const flag = (seed: string, name: string) => seedProperty({
  seedKey: extensionPropertySeedKey(seed),
  revision: 1,
  name,
  preset: 'boolean',
  defaultValue: false,
  changeScope: scope,
})

const day = (seed: string, name: string) => seedProperty({
  seedKey: extensionPropertySeedKey(seed),
  revision: 1,
  name,
  preset: 'date',
  defaultValue: undefined,
  changeScope: scope,
})

// ──── Experiment ────

export const interventionProp = seedProperty({
  seedKey: extensionPropertySeedKey('intervention'),
  revision: 1,
  name: FIELD.intervention,
  preset: 'string',
  defaultValue: '',
  changeScope: scope,
})

export const doseTextProp = seedProperty({
  seedKey: extensionPropertySeedKey('dose-text'),
  revision: 1,
  name: FIELD.doseText,
  preset: 'string',
  defaultValue: '',
  changeScope: scope,
})

export const controlProp = seedProperty<ControlKind>({
  seedKey: extensionPropertySeedKey('control'),
  revision: 1,
  name: FIELD.control,
  preset: 'strict-enum',
  config: {options: [
    {value: 'nothing', label: 'Nothing (open-label)'},
    {value: 'placebo', label: 'Placebo'},
  ]},
  defaultValue: 'nothing',
  changeScope: scope,
})

export const startDateProp = day('start-date', FIELD.startDate)

export const periodNightsProp = seedProperty({
  seedKey: extensionPropertySeedKey('period-nights'),
  revision: 1,
  name: FIELD.periodNights,
  preset: 'number',
  defaultValue: 3,
  changeScope: scope,
})

export const pairsProp = seedProperty({
  seedKey: extensionPropertySeedKey('pairs'),
  revision: 1,
  name: FIELD.pairs,
  preset: 'number',
  defaultValue: 8,
  changeScope: scope,
})

export const seedProp = seedProperty({
  seedKey: extensionPropertySeedKey('seed'),
  revision: 1,
  name: FIELD.seed,
  preset: 'number',
  defaultValue: 0,
  changeScope: scope,
})

export const experimentStatusProp = seedProperty<ExperimentStatus>({
  seedKey: extensionPropertySeedKey('experiment-status'),
  revision: 1,
  name: FIELD.experimentStatus,
  preset: 'strict-enum',
  config: {options: [
    {value: 'planned', label: 'Planned'},
    {value: 'running', label: 'Running'},
    {value: 'done', label: 'Done'},
  ]},
  defaultValue: 'running',
  changeScope: scope,
})

// ──── Period ────

export const indexProp = seedProperty({
  seedKey: extensionPropertySeedKey('index'),
  revision: 1,
  name: FIELD.index,
  preset: 'number',
  defaultValue: 0,
  changeScope: scope,
})

export const pairProp = seedProperty({
  seedKey: extensionPropertySeedKey('pair'),
  revision: 1,
  name: FIELD.pair,
  preset: 'number',
  defaultValue: 0,
  changeScope: scope,
})

/** On a period: what the schedule says. On a night: what was assigned when
 *  it was stamped — a copy, so a schedule edit after the fact does not
 *  silently relabel nights already slept. */
export const armProp = seedProperty<Arm>({
  seedKey: extensionPropertySeedKey('arm'),
  revision: 1,
  name: FIELD.arm,
  preset: 'strict-enum',
  config: {options: [
    {value: 'intervention', label: 'Intervention'},
    {value: 'control', label: 'Control'},
  ]},
  defaultValue: 'control',
  changeScope: scope,
})

export const fromProp = day('from', FIELD.from)
export const toProp = day('to', FIELD.to)

// ──── Night ────

export const dateProp = day('date', FIELD.date)

/** Refs, not id strings: the experiment's backlinks are its nights, and the
 *  link survives a rename. Optional — a baseline night belongs to no
 *  experiment. */
export const experimentProp = seedProperty({
  seedKey: extensionPropertySeedKey('experiment'),
  revision: 1,
  name: FIELD.experiment,
  preset: 'optional-ref',
  config: {targetTypes: [EXPERIMENT_TYPE]},
  defaultValue: undefined,
  changeScope: scope,
})

export const periodProp = seedProperty({
  seedKey: extensionPropertySeedKey('period'),
  revision: 1,
  name: FIELD.period,
  preset: 'optional-ref',
  config: {targetTypes: [PERIOD_TYPE]},
  defaultValue: undefined,
  changeScope: scope,
})

export const qualityProp = optionalNumber('quality', FIELD.quality)
export const restedProp = optionalNumber('rested', FIELD.rested)
export const easeProp = optionalNumber('ease', FIELD.ease)
export const sleepinessProp = optionalNumber('sleepiness', FIELD.sleepiness)
export const alcoholProp = optionalNumber('alcohol', FIELD.alcohol)
export const caffeineLateProp = flag('caffeine-late', FIELD.caffeineLate)
export const lateMealProp = flag('late-meal', FIELD.lateMeal)
export const unusualProp = flag('unusual', FIELD.unusual)

export const unusualReasonProp = seedProperty({
  seedKey: extensionPropertySeedKey('unusual-reason'),
  revision: 1,
  name: FIELD.unusualReason,
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: scope,
})

// ──── Session ────

export const sourceProp = seedProperty<SessionSource>({
  seedKey: extensionPropertySeedKey('source'),
  revision: 1,
  name: FIELD.source,
  preset: 'strict-enum',
  config: {options: [
    {value: 'health-connect', label: 'Health Connect'},
    {value: 'samsung-export', label: 'Samsung Health export'},
    {value: 'manual', label: 'Manual'},
  ]},
  defaultValue: 'manual',
  changeScope: scope,
})

export const externalIdProp = seedProperty({
  seedKey: extensionPropertySeedKey('external-id'),
  revision: 1,
  name: FIELD.externalId,
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: scope,
})

/** Real instants (not local-noon days): when the session began and ended. */
export const startProp = day('start', FIELD.start)
export const endProp = day('end', FIELD.end)
export const mainProp = flag('main', FIELD.main)

export const onsetMinutesProp = optionalNumber('onset-minutes', FIELD.onsetMinutes)
export const sleepMinutesProp = optionalNumber('sleep-minutes', FIELD.sleepMinutes)
export const inBedMinutesProp = optionalNumber('in-bed-minutes', FIELD.inBedMinutes)
export const efficiencyProp = optionalNumber('efficiency', FIELD.efficiency)
export const deepMinutesProp = optionalNumber('deep-minutes', FIELD.deepMinutes)
export const remMinutesProp = optionalNumber('rem-minutes', FIELD.remMinutes)
export const lightMinutesProp = optionalNumber('light-minutes', FIELD.lightMinutes)
export const awakeMinutesProp = optionalNumber('awake-minutes', FIELD.awakeMinutes)
export const awakeningsProp = optionalNumber('awakenings', FIELD.awakenings)
export const hrMeanProp = optionalNumber('hr-mean', FIELD.hrMean)
export const hrMinProp = optionalNumber('hr-min', FIELD.hrMin)
export const hrvProp = optionalNumber('hrv', FIELD.hrv)
export const spo2Prop = optionalNumber('spo2', FIELD.spo2)
export const skinTempProp = optionalNumber('skin-temp', FIELD.skinTemp)
export const respRateProp = optionalNumber('resp-rate', FIELD.respRate)
export const scoreProp = optionalNumber('score', FIELD.score)

/** Keyed by the measure name the importer and the analysis use, so a new
 *  measure is one entry here plus one in `SESSION_MEASURES`. */
export const MEASURE_PROPS = {
  onsetMinutes: onsetMinutesProp,
  sleepMinutes: sleepMinutesProp,
  inBedMinutes: inBedMinutesProp,
  efficiency: efficiencyProp,
  deepMinutes: deepMinutesProp,
  remMinutes: remMinutesProp,
  lightMinutes: lightMinutesProp,
  awakeMinutes: awakeMinutesProp,
  awakenings: awakeningsProp,
  hrMean: hrMeanProp,
  hrMin: hrMinProp,
  hrv: hrvProp,
  spo2: spo2Prop,
  skinTemp: skinTempProp,
  respRate: respRateProp,
  score: scoreProp,
} as const

export const RATING_PROPS = {
  quality: qualityProp,
  rested: restedProp,
  ease: easeProp,
  sleepiness: sleepinessProp,
} as const

// ──── Dose ────

export const takenAtProp = optionalNumber('taken-at', FIELD.takenAt)

// ──── Types ────

export const labType = seedType({
  seedKey: extensionTypeSeedKey('lab'),
  revision: 1,
  id: LAB_TYPE,
  label: 'Sleep Lab',
  description: 'The page that holds sleep experiments and nights.',
  hideFromCompletion: true,
})

export const experimentType = seedType({
  seedKey: extensionTypeSeedKey('experiment'),
  revision: 1,
  id: EXPERIMENT_TYPE,
  label: 'Sleep experiment',
  description: 'An intervention under test: dose, schedule, status. Its children are its periods.',
  properties: [
    interventionProp, doseTextProp, controlProp, startDateProp,
    periodNightsProp, pairsProp, seedProp, experimentStatusProp,
  ],
})

export const periodType = seedType({
  seedKey: extensionTypeSeedKey('period'),
  revision: 1,
  id: PERIOD_TYPE,
  label: 'Experiment period',
  description: 'Consecutive nights on one arm; part of a randomized pair.',
  hideFromCompletion: true,
  properties: [indexProp, pairProp, armProp, fromProp, toProp],
})

export const nightType = seedType({
  seedKey: extensionTypeSeedKey('night'),
  revision: 1,
  id: NIGHT_TYPE,
  label: 'Night',
  description: 'One night of sleep, keyed by the date you woke: assignment, ratings, covariates.',
  properties: [
    dateProp, experimentProp, periodProp, armProp,
    qualityProp, restedProp, easeProp, sleepinessProp,
    alcoholProp, caffeineLateProp, lateMealProp, unusualProp, unusualReasonProp,
  ],
})

export const sessionType = seedType({
  seedKey: extensionTypeSeedKey('session'),
  revision: 1,
  id: SESSION_TYPE,
  label: 'Sleep session',
  description: 'What the watch recorded for one sleep, with the per-night numbers derived from it.',
  hideFromCompletion: true,
  properties: [
    sourceProp, externalIdProp, startProp, endProp, mainProp,
    ...Object.values(MEASURE_PROPS),
  ],
})

export const doseType = seedType({
  seedKey: extensionTypeSeedKey('dose'),
  revision: 1,
  id: DOSE_TYPE,
  label: 'Dose',
  description: 'The dose for a night; a todo, so ticking it is adherence.',
  hideFromCompletion: true,
  properties: [takenAtProp],
})

export const SLEEPLAB_TYPES = [labType, experimentType, periodType, nightType, sessionType, doseType]

export const SLEEPLAB_PROPS = [
  interventionProp, doseTextProp, controlProp, startDateProp,
  periodNightsProp, pairsProp, seedProp, experimentStatusProp,
  indexProp, pairProp, armProp, fromProp, toProp,
  dateProp, experimentProp, periodProp,
  qualityProp, restedProp, easeProp, sleepinessProp,
  alcoholProp, caffeineLateProp, lateMealProp, unusualProp, unusualReasonProp,
  sourceProp, externalIdProp, startProp, endProp, mainProp,
  ...Object.values(MEASURE_PROPS),
  takenAtProp,
]
