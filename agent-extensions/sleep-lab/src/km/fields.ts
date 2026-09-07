/** Type ids and property names as plain constants — the one source of truth
 *  shared by the seed declarations (`schema.ts`) and the pure read path.
 *
 *  Free of any `@/` import on purpose: the readers, the engine and the
 *  importers only need the names, and keeping them here is what lets those
 *  be unit-tested in plain node while `schema.ts` pulls in the runtime
 *  seeding machinery.
 *
 *  Everything is namespaced `sleeplab`: type ids and property names share
 *  one global namespace with every plugin and extension in the workspace.
 */

/** The page that holds experiments and nights — a kernel page, one per
 *  workspace. */
export const LAB_TYPE = 'sleeplab-lab'
/** One experiment: an intervention, a dose, a schedule. Its children are
 *  its periods. */
export const EXPERIMENT_TYPE = 'sleeplab-experiment'
/** One run of consecutive nights on one arm. Child of its experiment, so
 *  parentage says which experiment without a ref. */
export const PERIOD_TYPE = 'sleeplab-period'
/** The experimental unit: one night, keyed by the date you woke up. Child
 *  of the lab page; id derived from the date so the evening gesture, the
 *  morning check-in and the importer converge on one block. */
export const NIGHT_TYPE = 'sleeplab-night'
/** What the watch recorded — one per sleep session, child of its night.
 *  Naps are sessions too, with `main` false. */
export const SESSION_TYPE = 'sleeplab-session'
/** The dose to take, child of its night. Composes the built-in todo: the
 *  checkbox is adherence. */
export const DOSE_TYPE = 'sleeplab-dose'

export type Arm = 'intervention' | 'control'
export type ControlKind = 'nothing' | 'placebo'
export type ExperimentStatus = 'planned' | 'running' | 'done'
export type SessionSource = 'health-connect' | 'samsung-export' | 'manual'

export const FIELD = {
  // ── experiment ──
  /** Label of the thing under test, e.g. "glycine". Display only — the
   *  experiment is identified by its block. */
  intervention: 'sleeplab:intervention',
  /** What the dose todo says, e.g. "3 g glycine in water, 30–60 min before bed". */
  doseText: 'sleeplab:doseText',
  /** `nothing` stamps no dose on control nights; `placebo` stamps a placebo
   *  dose todo so adherence is logged on both arms. */
  control: 'sleeplab:control',
  /** Wake date of the first night of period 1. */
  startDate: 'sleeplab:startDate',
  periodNights: 'sleeplab:periodNights',
  pairs: 'sleeplab:pairs',
  /** PRNG seed the schedule was drawn from — stored so any device can
   *  re-derive the same order. */
  seed: 'sleeplab:seed',
  experimentStatus: 'sleeplab:status',

  // ── period ──
  /** 1-based position in the schedule. */
  index: 'sleeplab:index',
  /** 1-based pair number: periods 2k−1 and 2k form pair k. */
  pair: 'sleeplab:pair',
  /** Shared by period (what the schedule says) and night (what was assigned
   *  when the night was stamped). */
  arm: 'sleeplab:arm',
  /** Wake dates, inclusive. */
  from: 'sleeplab:from',
  to: 'sleeplab:to',

  // ── night ──
  /** The wake date, stored as a local-noon Date (see `day.ts`). */
  date: 'sleeplab:date',
  experiment: 'sleeplab:experiment',
  period: 'sleeplab:period',
  /** Subjective, 1–5. */
  quality: 'sleeplab:quality',
  rested: 'sleeplab:rested',
  ease: 'sleeplab:ease',
  /** Karolinska Sleepiness Scale, 1–9, afternoon. */
  sleepiness: 'sleeplab:sleepiness',
  /** Covariates. */
  alcohol: 'sleeplab:alcohol',
  caffeineLate: 'sleeplab:caffeineLate',
  lateMeal: 'sleeplab:lateMeal',
  /** Pre-registered exclusion: illness, travel, a very late night. */
  unusual: 'sleeplab:unusual',
  unusualReason: 'sleeplab:unusualReason',

  // ── session ──
  source: 'sleeplab:source',
  /** The source's own record id, for tracing a number back. Informational —
   *  identity is the derived block id. */
  externalId: 'sleeplab:externalId',
  start: 'sleeplab:start',
  end: 'sleeplab:end',
  /** The night's sleep, as opposed to a nap the same day. */
  main: 'sleeplab:main',
  onsetMinutes: 'sleeplab:onsetMinutes',
  sleepMinutes: 'sleeplab:sleepMinutes',
  inBedMinutes: 'sleeplab:inBedMinutes',
  /** 0–1. */
  efficiency: 'sleeplab:efficiency',
  deepMinutes: 'sleeplab:deepMinutes',
  remMinutes: 'sleeplab:remMinutes',
  lightMinutes: 'sleeplab:lightMinutes',
  awakeMinutes: 'sleeplab:awakeMinutes',
  awakenings: 'sleeplab:awakenings',
  hrMean: 'sleeplab:hrMean',
  hrMin: 'sleeplab:hrMin',
  /** RMSSD, ms. */
  hrv: 'sleeplab:hrv',
  /** Mean %, 0–100. */
  spo2: 'sleeplab:spo2',
  /** Mean delta from the wearable's baseline, °C. */
  skinTemp: 'sleeplab:skinTemp',
  respRate: 'sleeplab:respRate',
  /** Samsung's own 0–100 sleep score; export path only. */
  score: 'sleeplab:score',

  // ── dose ──
  /** Epoch ms when the check-in's "taken now" was pressed. The checkbox
   *  alone (todo `status`) is adherence; this is the time. */
  takenAt: 'sleeplab:takenAt',
  /** Done-ness is the built-in todo's own (un-namespaced) property. */
  todoStatus: 'status',
} as const

/** Every numeric measure a session block may carry, in dashboard order.
 *  The one list the importer writes from and the analysis reads from. */
export const SESSION_MEASURES = [
  'onsetMinutes', 'sleepMinutes', 'inBedMinutes', 'efficiency',
  'deepMinutes', 'remMinutes', 'lightMinutes', 'awakeMinutes', 'awakenings',
  'hrMean', 'hrMin', 'hrv', 'spo2', 'skinTemp', 'respRate', 'score',
] as const
export type SessionMeasure = typeof SESSION_MEASURES[number]

/** The subjective measures a night block may carry. */
export const NIGHT_RATINGS = ['quality', 'rested', 'ease', 'sleepiness'] as const
export type NightRating = typeof NIGHT_RATINGS[number]
