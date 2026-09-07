/** Experiments: starting one stamps its whole schedule as period blocks;
 *  "tonight" reads that schedule and stamps the night.
 *
 *  Ordinary minted ids for the experiment and its periods: one gesture
 *  creates them, and a duplicate is visible in the outline and deletable —
 *  the bar the Strength Tracker settled on for visible records.
 */

import {ChangeScope, propertyValue} from '@/data/api/index.js'
import type {Repo} from '@/data/repo.js'
import {createTypedChild} from '@/data/typedRecords.js'

import {buildSchedule, periodForDate} from '../engine/schedule'
import type {Arm, ExperimentRecord, Period, ScheduleSpec} from '../engine/types'
import {dayToDate} from './day'
import {EXPERIMENT_TYPE, PERIOD_TYPE, type ControlKind} from './fields'
import {assignNightInTx, ensureDoseInTx, getOrCreateNightInTx} from './nights'
import {getOrCreateLabPage} from './page'
import {buildExperiments} from './records'
import {
  armProp, controlProp, doseTextProp, experimentStatusProp, fromProp, indexProp, interventionProp,
  pairProp, pairsProp, periodNightsProp, seedProp, startDateProp, toProp,
} from './schema'

export interface ExperimentSpec extends ScheduleSpec {
  intervention: string
  doseText: string
  control: ControlKind
}

const periodContent = (period: Period, spec: ExperimentSpec): string =>
  `Period ${period.index} · ${period.arm === 'intervention' ? spec.intervention : spec.control} · ${period.from} → ${period.to}`

/** The experiment block and one period block per schedule entry, in one
 *  transaction, so the schedule lands and undoes as one step. */
export const createExperiment = (repo: Repo, pageId: string, spec: ExperimentSpec): Promise<string> =>
  repo.tx(async tx => {
    const periods = buildSchedule(spec)
    const typeSnapshot = repo.snapshotTypeRegistries()
    const id = await createTypedChild(repo, tx, {
      parentId: pageId,
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
      position: {kind: 'first'},
      typeSnapshot,
    })
    for (const period of periods) {
      await createTypedChild(repo, tx, {
        parentId: id,
        content: periodContent(period, spec),
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
    return id
  }, {scope: ChangeScope.BlockDefault, description: `Start ${spec.intervention} experiment`})

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
