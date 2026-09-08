/** The records the engine, the importers and the block readers agree on.
 *
 *  Free of any `@/` import: everything downstream of a block row is plain
 *  data, so the schedule, the derivations and the statistics are
 *  unit-testable in plain node.
 */

import type {Arm, NightRating, SessionMeasure, SessionSource} from '../km/fields'

export type {Arm, NightRating, SessionMeasure, SessionSource} from '../km/fields'

// ──── Schedule ────

export interface ScheduleSpec {
  /** Wake date (`YYYY-MM-DD`) of the first night of period 1. */
  startDate: string
  periodNights: number
  pairs: number
  /** PRNG seed; the same seed always yields the same order. */
  seed: number
}

export interface Period {
  /** 1-based. */
  index: number
  /** 1-based; periods 2k−1 and 2k form pair k. */
  pair: number
  arm: Arm
  /** Wake dates, inclusive. */
  from: string
  to: string
}

// ──── What the watch recorded ────

export type StageKind = 'awake' | 'light' | 'deep' | 'rem' | 'sleeping' | 'unknown' | 'out-of-bed'

export interface Stage {
  kind: StageKind
  start: Date
  end: Date
}

export interface Sample {
  at: Date
  value: number
}

/** One sleep session as an importer hands it over — the raw material the
 *  per-night numbers are derived from. Samples are the whole export's; the
 *  derivation keeps those inside the session's window. */
export interface ImportedSession {
  source: SessionSource
  externalId?: string
  start: Date
  end: Date
  stages: Stage[]
  heartRate: Sample[]
  /** RMSSD, ms. */
  hrv: Sample[]
  /** Percent. */
  spo2: Sample[]
  /** Delta from baseline, °C. */
  skinTemp: Sample[]
  respRate: Sample[]
  /** Numbers the source states itself, used when the stages cannot yield
   *  them (Samsung's own score; its efficiency when there are no stages). */
  stated?: Partial<Record<SessionMeasure, number>>
}

/** A session as read back from its block. */
export interface SessionRecord {
  id: string
  source: SessionSource
  externalId?: string
  start: Date
  end: Date
  main: boolean
  measures: Partial<Record<SessionMeasure, number>>
}

// ──── The experimental unit ────

export interface NightRecord {
  id: string
  /** Wake date. */
  date: string
  arm?: Arm
  experimentId?: string
  periodId?: string
  /** Copied off the period block the night points at, when it does. */
  periodIndex?: number
  pair?: number
  /** True on the first night of its period. */
  transition?: boolean
  ratings: Partial<Record<NightRating, number>>
  alcohol?: number
  caffeineLate: boolean
  lateMeal: boolean
  unusual: boolean
  unusualReason?: string
  /** `undefined` when the night has no dose block (control under
   *  open-label, or a baseline night). */
  doseTaken?: boolean
  /** Whether the protocol expects a dose this night: the intervention arm
   *  always, the control arm when the experiment's control is a placebo.
   *  Decided ONCE, here, for eligibility and adherence alike — the dose
   *  block's presence is not the rule, since a deleted one must still count
   *  as missing. */
  doseRequired: boolean
  main?: SessionRecord
  naps: SessionRecord[]
  /** A strength session was logged for the night's day. */
  trained: boolean
}

export interface ExperimentRecord {
  id: string
  intervention: string
  doseText: string
  control: 'nothing' | 'placebo'
  startDate: string
  periodNights: number
  pairs: number
  seed: number
  status: 'planned' | 'running' | 'done'
  periods: (Period & {id: string})[]
}

// ──── Analysis ────

/** Every outcome the dashboard can compare: the session measures plus the
 *  night ratings, under one name. */
export type Outcome = SessionMeasure | NightRating

/** `assigned`: every night by its arm, whatever was taken (intention to
 *  treat). `per-protocol`: a night that owes a dose (`doseRequired`) is in
 *  only when it was ticked. */
export type Population = 'assigned' | 'per-protocol'

export interface Comparison {
  outcome: Outcome
  population: Population
  nIntervention: number
  nControl: number
  meanIntervention?: number
  meanControl?: number
  /** intervention − control. */
  difference?: number
  /** Bootstrap 95% interval on the difference. */
  ci?: [number, number]
  /** Permutation p-value, labels shuffled within pairs. */
  p?: number
  /** Period means differenced within pairs, when both periods of a pair
   *  have data. */
  paired?: {pairs: number; difference: number; ci?: [number, number]}
}
