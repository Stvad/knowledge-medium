/** Rows → records: the one place that knows how a night, a session, a dose,
 *  a period and an experiment are spelled on a block.
 *
 *  Structural row type rather than `BlockData`, so the readers are
 *  unit-testable on hand-built rows. Property values arrive codec-ENCODED:
 *  dates as ISO strings, refs as ids, everything else identity JSON.
 */

import {hasBlockType} from '@/data/properties.js'

import type {
  Arm, ExperimentRecord, NightRating, NightRecord, Period, SessionMeasure, SessionRecord, SessionSource,
} from '../engine/types'
import {dateToDay, storedDate} from './day'
import {
  DOSE_TYPE, EXPERIMENT_TYPE, FIELD, NIGHT_RATINGS, NIGHT_TYPE, PERIOD_TYPE, SESSION_MEASURES, SESSION_TYPE,
} from './fields'

export interface Row {
  id: string
  parentId: string | null
  orderKey: string
  properties: Record<string, unknown>
  deleted?: boolean
}

const usable = (row: Row | null | undefined, type: string): row is Row =>
  row !== null && row !== undefined && !row.deleted && hasBlockType(row, type)

const num = (row: Row, name: string): number | undefined =>
  typeof row.properties[name] === 'number' ? row.properties[name] as number : undefined

const text = (row: Row, name: string): string | undefined =>
  typeof row.properties[name] === 'string' && row.properties[name] !== ''
    ? row.properties[name] as string
    : undefined

const bool = (row: Row, name: string): boolean => row.properties[name] === true

/** A stored instant, or undefined when missing or unreadable. */
const instant = (row: Row, name: string): Date | undefined => {
  const raw = row.properties[name]
  const parsed = typeof raw === 'string' ? new Date(raw) : null
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : undefined
}

/** A stored wake date as `YYYY-MM-DD`, through `storedDate` so an
 *  editor-typed UTC-midnight value names the day meant. */
const day = (row: Row, name: string): string | undefined => {
  const parsed = instant(row, name)
  return parsed ? dateToDay(storedDate(parsed)) : undefined
}

const isArm = (value: unknown): value is Arm => value === 'intervention' || value === 'control'

const byOrderKey = (a: Row, b: Row): number =>
  a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : a.id < b.id ? -1 : 1

// ──── Experiment + period ────

export type PeriodRow = Period & {id: string; experimentId: string}

export const asPeriod = (row: Row | null | undefined): PeriodRow | null => {
  if (!usable(row, PERIOD_TYPE) || row.parentId === null) return null
  const arm = row.properties[FIELD.arm]
  const index = num(row, FIELD.index)
  const pair = num(row, FIELD.pair)
  const from = day(row, FIELD.from)
  const to = day(row, FIELD.to)
  if (!isArm(arm) || index === undefined || pair === undefined || from === undefined || to === undefined) return null
  return {id: row.id, experimentId: row.parentId, index, pair, arm, from, to}
}

export const asExperiment = (row: Row | null | undefined): Omit<ExperimentRecord, 'periods'> | null => {
  if (!usable(row, EXPERIMENT_TYPE)) return null
  const control = row.properties[FIELD.control]
  const status = row.properties[FIELD.experimentStatus]
  return {
    id: row.id,
    intervention: text(row, FIELD.intervention) ?? '',
    doseText: text(row, FIELD.doseText) ?? '',
    control: control === 'placebo' ? 'placebo' : 'nothing',
    startDate: day(row, FIELD.startDate) ?? '',
    periodNights: num(row, FIELD.periodNights) ?? 3,
    pairs: num(row, FIELD.pairs) ?? 8,
    seed: num(row, FIELD.seed) ?? 0,
    status: status === 'planned' || status === 'done' ? status : 'running',
  }
}

export const buildExperiments = (rows: readonly Row[]): ExperimentRecord[] => {
  const periods = new Map<string, PeriodRow[]>()
  for (const row of rows) {
    const period = asPeriod(row)
    if (!period) continue
    const list = periods.get(period.experimentId) ?? []
    list.push(period)
    periods.set(period.experimentId, list)
  }
  return rows
    .map(asExperiment)
    .filter((experiment): experiment is Omit<ExperimentRecord, 'periods'> => experiment !== null)
    .map(experiment => ({
      ...experiment,
      periods: (periods.get(experiment.id) ?? []).sort((a, b) => a.index - b.index),
    }))
    .sort((a, b) => (a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : 0))
}

// ──── Session + dose ────

export type SessionRow = SessionRecord & {nightId: string | null}

const isSource = (value: unknown): value is SessionSource =>
  value === 'health-connect' || value === 'samsung-export' || value === 'manual'

export const asSession = (row: Row | null | undefined): SessionRow | null => {
  if (!usable(row, SESSION_TYPE)) return null
  const start = instant(row, FIELD.start)
  const end = instant(row, FIELD.end)
  if (!start || !end) return null
  const measures: Partial<Record<SessionMeasure, number>> = {}
  for (const measure of SESSION_MEASURES) {
    const value = num(row, FIELD[measure])
    if (value !== undefined) measures[measure] = value
  }
  const source = row.properties[FIELD.source]
  return {
    id: row.id,
    nightId: row.parentId,
    source: isSource(source) ? source : 'manual',
    externalId: text(row, FIELD.externalId),
    start,
    end,
    main: bool(row, FIELD.main),
    measures,
  }
}

export interface DoseRow {
  id: string
  nightId: string | null
  /** The composed todo's status — the ONLY thing that says taken. */
  taken: boolean
  takenAt: number | undefined
}

export const asDose = (row: Row | null | undefined): DoseRow | null => {
  if (!usable(row, DOSE_TYPE)) return null
  return {
    id: row.id,
    nightId: row.parentId,
    taken: row.properties[FIELD.todoStatus] === 'done',
    takenAt: num(row, FIELD.takenAt),
  }
}

// ──── Night ────

/** What the night block itself says, before its children are joined in. */
export type NightBase = Omit<NightRecord, 'main' | 'naps' | 'trained' | 'doseTaken' | 'periodIndex' | 'pair' | 'transition'>

export const asNight = (row: Row | null | undefined): NightBase | null => {
  if (!usable(row, NIGHT_TYPE)) return null
  const date = day(row, FIELD.date)
  if (date === undefined) return null
  const arm = row.properties[FIELD.arm]
  const ratings: Partial<Record<NightRating, number>> = {}
  for (const rating of NIGHT_RATINGS) {
    const value = num(row, FIELD[rating])
    if (value !== undefined) ratings[rating] = value
  }
  return {
    id: row.id,
    date,
    arm: isArm(arm) ? arm : undefined,
    experimentId: text(row, FIELD.experiment),
    periodId: text(row, FIELD.period),
    ratings,
    alcohol: num(row, FIELD.alcohol),
    caffeineLate: bool(row, FIELD.caffeineLate),
    lateMeal: bool(row, FIELD.lateMeal),
    unusual: bool(row, FIELD.unusual),
    unusualReason: text(row, FIELD.unusualReason),
  }
}

// The Strength Tracker's own spelling of a finished workout, mirrored here
// because the two extensions are separate bundles and cannot import each
// other. Read-only: a strength session on the night's day is a covariate.
const STRENGTH_WORKOUT_TYPE = 'strength-workout'
const STRENGTH_DATE = 'strength:date'
const STRENGTH_STATUS = 'strength:status'

/** The wake dates on which a finished strength session was logged. */
export const trainedDays = (rows: readonly Row[]): Set<string> => {
  const days = new Set<string>()
  for (const row of rows) {
    if (!usable(row, STRENGTH_WORKOUT_TYPE) || row.properties[STRENGTH_STATUS] !== 'done') continue
    const on = day(row, STRENGTH_DATE)
    if (on !== undefined) days.add(on)
  }
  return days
}

/** Nights with their sessions, dose and period joined in, oldest first.
 *
 *  Sessions and doses join by PARENTAGE (they live under their night);
 *  periods join by the night's ref. A night whose ref points at a period
 *  that is gone keeps its `arm` — the arm was copied at assignment for
 *  exactly this — and simply has no pair. */
export const buildNights = (rows: readonly Row[], trained: ReadonlySet<string> = new Set()): NightRecord[] => {
  const sessions = new Map<string, SessionRow[]>()
  const doses = new Map<string, DoseRow[]>()
  const periods = new Map<string, PeriodRow>()
  for (const row of [...rows].sort(byOrderKey)) {
    const session = asSession(row)
    if (session?.nightId) {
      sessions.set(session.nightId, [...(sessions.get(session.nightId) ?? []), session])
      continue
    }
    const dose = asDose(row)
    if (dose?.nightId) {
      doses.set(dose.nightId, [...(doses.get(dose.nightId) ?? []), dose])
      continue
    }
    const period = asPeriod(row)
    if (period) periods.set(period.id, period)
  }

  return rows
    .map(asNight)
    .filter((night): night is NightBase => night !== null)
    .map(night => {
      const own = sessions.get(night.id) ?? []
      const period = night.periodId ? periods.get(night.periodId) : undefined
      const nightDoses = doses.get(night.id) ?? []
      return {
        ...night,
        ...(period ? {periodIndex: period.index, pair: period.pair, transition: night.date === period.from} : {}),
        // Any dose ticked counts; a second dose block is a duplicate, not a
        // second requirement.
        doseTaken: nightDoses.length === 0 ? undefined : nightDoses.some(dose => dose.taken),
        main: own.find(session => session.main),
        naps: own.filter(session => !session.main),
        trained: trained.has(night.date),
      }
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
}
