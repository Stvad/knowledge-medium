/** Experiments: starting one stamps its whole schedule as period blocks;
 *  "tonight" reads that schedule and stamps the night.
 *
 *  Ordinary minted ids for the experiment and its periods: one gesture
 *  creates them, and a duplicate is visible in the outline and deletable —
 *  the bar the Strength Tracker settled on for visible records.
 */

import {ChangeScope, propertyValue, type Tx} from '@/data/api/index.js'
import {hasBlockType} from '@/data/properties.js'
import type {Repo} from '@/data/repo.js'
import {createTypedChild} from '@/data/typedRecords.js'

import {buildSchedule, periodForDate} from '../engine/schedule'
import type {Arm, ExperimentRecord, Period, ScheduleSpec} from '../engine/types'
import {dayToDate} from './day'
import {EXPERIMENT_TYPE, PERIOD_TYPE, type ControlKind} from './fields'
import {assignNightInTx, ensureDoseInTx, getOrCreateNightInTx} from './nights'
import {getOrCreateLabPage} from './page'
import {asExperiment, buildExperiments} from './records'
import {
  armProp, controlProp, doseTextProp, experimentStatusProp, fromProp, indexProp, interventionProp,
  pairProp, pairsProp, periodNightsProp, seedProp, startDateProp, toProp,
} from './schema'

export interface ExperimentSpec extends ScheduleSpec {
  intervention: string
  doseText: string
  control: ControlKind
}

/** "control", not the control KIND: "Period 1 · nothing" reads as a gap. */
const periodContent = (period: Period, intervention: string, control: ControlKind): string =>
  `Period ${period.index} · ${period.arm === 'intervention' ? intervention : control === 'placebo' ? 'placebo' : 'control'} · ${period.from} → ${period.to}`

/** Where a new experiment block lands: under `parentId`, first or last. The
 *  lab page's button files it on the page; the "here" action files it where
 *  the cursor is — inside the protocol notes, which is where it belongs. */
export interface ExperimentPlacement {
  parentId: string
  position: {kind: 'first'} | {kind: 'last'}
}

type TypeSnapshot = ReturnType<Repo['snapshotTypeRegistries']>

/** One period block per schedule entry, under `experimentId`. */
const stampPeriodsInTx = async (
  repo: Repo,
  tx: Tx,
  experimentId: string,
  spec: ExperimentSpec,
  typeSnapshot: TypeSnapshot,
): Promise<number> => {
  const periods = buildSchedule(spec)
  for (const period of periods) {
    await createTypedChild(repo, tx, {
      parentId: experimentId,
      content: periodContent(period, spec.intervention, spec.control),
      types: [PERIOD_TYPE],
      properties: [
        propertyValue(indexProp, period.index),
        propertyValue(pairProp, period.pair),
        propertyValue(armProp, period.arm),
        propertyValue(fromProp, dayToDate(period.from)),
        propertyValue(toProp, dayToDate(period.to)),
      ],
      typeSnapshot,
    })
  }
  return periods.length
}

/** The experiment block and one period block per schedule entry, in one
 *  transaction, so the schedule lands and undoes as one step. */
export const createExperimentAt = (repo: Repo, placement: ExperimentPlacement, spec: ExperimentSpec): Promise<string> =>
  repo.tx(async tx => {
    const typeSnapshot = repo.snapshotTypeRegistries()
    const id = await createTypedChild(repo, tx, {
      parentId: placement.parentId,
      content: `${spec.intervention} experiment`,
      types: [EXPERIMENT_TYPE],
      properties: [
        propertyValue(interventionProp, spec.intervention),
        propertyValue(doseTextProp, spec.doseText),
        propertyValue(controlProp, spec.control),
        propertyValue(startDateProp, dayToDate(spec.startDate)),
        propertyValue(periodNightsProp, spec.periodNights),
        propertyValue(pairsProp, spec.pairs),
        propertyValue(seedProp, spec.seed),
        propertyValue(experimentStatusProp, 'running'),
      ],
      position: placement.position,
      typeSnapshot,
    })
    await stampPeriodsInTx(repo, tx, id, spec, typeSnapshot)
    return id
  }, {scope: ChangeScope.BlockDefault, description: `Start ${spec.intervention} experiment`})

/** On the lab page, newest first. */
export const createExperiment = (repo: Repo, pageId: string, spec: ExperimentSpec): Promise<string> =>
  createExperimentAt(repo, {parentId: pageId, position: {kind: 'first'}}, spec)

export type StampScheduleOutcome =
  | {status: 'stamped'; periods: number}
  /** The block already has period children; nothing was written. */
  | {status: 'already'}
  /** Not an experiment block, deleted, or its properties do not describe a
   *  schedule (no start date). */
  | {status: 'unreadable'; reason: string}

/** Stamp the schedule under an experiment block the user typed by hand —
 *  the protocol lives in the notes, and this is how a typed block becomes a
 *  running experiment. Refuses if any period is already there: a second
 *  schedule under one experiment would double every night's assignment. */
export const stampSchedule = (repo: Repo, experimentId: string): Promise<StampScheduleOutcome> =>
  repo.tx(async tx => {
    const block = await tx.get(experimentId)
    const experiment = asExperiment(block && !block.deleted ? {...block, orderKey: block.orderKey} : null)
    if (!experiment) return {status: 'unreadable' as const, reason: 'This is not an experiment block.'}
    if (experiment.startDate === '') return {status: 'unreadable' as const, reason: 'Set a start date first.'}
    const existing = (await tx.childrenOf(experimentId, undefined, {hidePropertyChildren: true}))
      .some(child => !child.deleted && hasBlockType(child, PERIOD_TYPE))
    if (existing) return {status: 'already' as const}
    const spec: ExperimentSpec = {
      intervention: experiment.intervention || 'intervention',
      doseText: experiment.doseText,
      control: experiment.control,
      startDate: experiment.startDate,
      periodNights: experiment.periodNights,
      pairs: experiment.pairs,
      seed: experiment.seed,
    }
    const periods = await stampPeriodsInTx(repo, tx, experimentId, spec, repo.snapshotTypeRegistries())
    if (experiment.status !== 'running') await tx.setProperty(experimentId, experimentStatusProp, 'running')
    return {status: 'stamped' as const, periods}
  }, {scope: ChangeScope.BlockDefault, description: 'Stamp experiment schedule'})

export const readExperiments = async (repo: Repo, workspaceId: string): Promise<ExperimentRecord[]> =>
  buildExperiments(await repo.queryBlocks({workspaceId, types: [EXPERIMENT_TYPE, PERIOD_TYPE]}))

/** The experiment tonight belongs to: running, and newest-started first
 *  when two are. */
export const runningExperiment = (experiments: readonly ExperimentRecord[]): ExperimentRecord | undefined =>
  experiments.find(experiment => experiment.status === 'running')

/** Whether a night on `arm` gets a dose todo: the intervention always, the
 *  control only when it is a placebo. */
export const doseTextFor = (experiment: ExperimentRecord, arm: Arm): string | undefined =>
  arm === 'intervention' ? experiment.doseText
    : experiment.control === 'placebo' ? 'Placebo dose' : undefined

export interface StampedNight {
  nightId: string
  /** The night's arm after the stamp — what it already had, or what the
   *  schedule gave it. Absent when no running experiment covers the date. */
  arm?: Arm
  doseId?: string
  experiment?: ExperimentRecord
  assignment: 'assigned' | 'already' | 'none'
}

/** The night block for `date`, assigned from the running experiment's
 *  schedule if one covers it, with its dose beneath. Idempotent: a second
 *  call finds the same block and changes nothing. */
export const stampNight = async (repo: Repo, workspaceId: string, date: string): Promise<StampedNight> => {
  const page = await getOrCreateLabPage(repo, workspaceId)
  const experiment = runningExperiment(await readExperiments(repo, workspaceId))
  const period = experiment ? periodForDate(experiment.periods, date) : undefined

  return repo.tx(async tx => {
    const typeSnapshot = repo.snapshotTypeRegistries()
    const nightId = await getOrCreateNightInTx(repo, tx, {workspaceId, pageId: page.id, date, typeSnapshot})
    if (!experiment || !period) return {nightId, assignment: 'none' as const}

    // The schedule was read before this transaction; the period must still
    // be there before the night is bound to it.
    const periodRow = await tx.get(period.id)
    if (!periodRow || periodRow.deleted) return {nightId, assignment: 'none' as const}

    const assigned = await assignNightInTx(tx, nightId, {experimentId: experiment.id, periodId: period.id, arm: period.arm})
    if (assigned === 'gone') return {nightId, assignment: 'none' as const}
    const night = await tx.get(nightId)
    const raw = night?.properties[armProp.name]
    const arm: Arm = raw === 'intervention' || raw === 'control' ? raw : period.arm
    const text = doseTextFor(experiment, arm)
    const doseId = text === undefined ? undefined : await ensureDoseInTx(repo, tx, {nightId, text, typeSnapshot})
    return {nightId, arm, doseId, experiment, assignment: assigned}
  }, {scope: ChangeScope.BlockDefault, description: `Night of ${date}`})
}
