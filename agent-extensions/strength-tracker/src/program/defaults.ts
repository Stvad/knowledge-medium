/** Fallback program, transcribed from Strength Plan v2.
 *
 *  These values are NOT the runtime source of truth. They exist so the
 *  first-run seeder always has a complete, plan-faithful config even when
 *  the plan-outline parser can't read a line — the seeder writes this,
 *  overlaid with whatever it did parse, into editable config blocks, and
 *  from then on the blocks are authoritative. Editing the program means
 *  editing notes, never this file.
 *
 *  Two things here aren't stated in the plan, and both are judgement calls
 *  that live in config for exactly that reason:
 *
 *  - The day boundaries on the re-entry tiers. The plan names gaps in weeks
 *    ("1–2 weeks off"); the engine needs day counts.
 *  - Where "on schedule" ends. Every lift in this program is trained once a
 *    week, so consecutive same-session nights are ~7 days apart. The plan's
 *    own "missed 1 session → repeat last weights" is about skipping a lift's
 *    slot — which is a *per-lift* idea, not a global one (see
 *    `perLiftCadenceDays`). So the global recorded-layoff table treats
 *    anything up to a full lift-cadence as on schedule, and the "repeat, no
 *    jump" behaviour is applied per lift instead of as a global tier. This
 *    is what lets three consecutive Thursday benches progress normally even
 *    though 7 days is a whole week apart.
 */

import type {ProgramConfig, ReentryTier} from '../engine/types'

/** Sun = 0. Thu = Session A, Sun = Session B (late), Tue = optional mini. */
export const DEFAULT_WEEKLY_TEMPLATE = {
  0: 'B',
  2: 'mini',
  4: 'A',
} as const

/** A lift trained within this many days is on its own weekly cadence — no
 *  re-entry adjustment, and if it topped its range it progresses. Set a
 *  hair over a week so a day or two of slippage still counts as on time. */
export const DEFAULT_PER_LIFT_CADENCE_DAYS = 9

export const DEFAULT_REENTRY_TIERS: readonly ReentryTier[] = [
  {
    id: 'on-schedule',
    label: 'on schedule',
    // Up to one lift-cadence: normal weekly rhythm, or a single skipped
    // session while the other keeps going, never records a layoff.
    maxGapDays: DEFAULT_PER_LIFT_CADENCE_DAYS,
    pct: 1,
    sessionsToNormal: 0,
    rampPerSession: 0,
    guidance: '',
  },
  {
    id: '1-2w',
    label: '1–2 weeks off',
    maxGapDays: 17,
    pct: 1,
    setsDelta: 1,
    sessionsToNormal: 1,
    rampPerSession: 0,
    guidance: 'Same weights, one set lighter tonight. Normal sets next session.',
  },
  {
    id: '2-4w',
    label: '2–4 weeks off',
    maxGapDays: 34,
    pct: 0.9,
    sessionsToNormal: 2,
    rampPerSession: 0,
    guidance: '90% of last weights, normal sets. Progression resumes after two sessions.',
  },
  {
    id: '1-2mo',
    label: '1–2 months off',
    maxGapDays: 70,
    pct: 0.8,
    setsOverride: 2,
    setsOverrideSessions: 2,
    sessionsToNormal: 5,
    rampPerSession: 0.05,
    guidance: '80% to start, 2 sets for week one, +5% per session until back.',
  },
  {
    id: '2mo+',
    label: '2+ months / post-injury',
    maxGapDays: Infinity,
    pct: 0.6,
    setsOverride: 2,
    repMin: 8,
    repMax: 12,
    sessionsToNormal: 7,
    rampPerSession: 0.075,
    guidance:
      '60%, 2 sets, higher reps, ramp 5–10% per session. Expect ~1 week of rebuild per 2 weeks off — that is normal, not a setback.',
  },
]

const SHOULDER_PREP = 'Warm-up: 3–5 min shoulder prep — band external rotations, band pull-aparts, scap push-ups'
const RPE_CAP = 'Stop every set ~2 reps shy of failure (RPE 8). No grinders.'
const BREATHING = 'Brace, exhale through the sticking point, re-breathe every rep — no multi-rep breath holds.'
const SOLO_SAFETY = 'Solo at 1am: rack safeties on every squat and bench set, no collars on bench.'

export const DEFAULT_CONFIG: ProgramConfig = {
  unit: 'lb',
  roundTo: 5,
  dayRolloverHour: 4,
  perLiftCadenceDays: DEFAULT_PER_LIFT_CADENCE_DAYS,
  weeklyTemplate: DEFAULT_WEEKLY_TEMPLATE,
  reentry: DEFAULT_REENTRY_TIERS,
  sessionNotes: {
    A: [SHOULDER_PREP, RPE_CAP, BREATHING, SOLO_SAFETY],
    B: [SHOULDER_PREP, RPE_CAP, BREATHING, SOLO_SAFETY],
    mini: ['Only rule: this must feel easy. Habit continuity and shoulder dosing, not stimulus.'],
  },
  exercises: [
    {name: 'Bench press', session: 'A', sets: 3, repMin: 6, repMax: 10, increment: 5, perSide: false, freeform: false, note: 'double progression'},
    {name: 'Bent-over row', session: 'A', sets: 3, repMin: 6, repMax: 10, increment: 5, perSide: false, freeform: false},
    {name: 'Split squat / RFESS', session: 'A', sets: 2, repMin: 8, repMax: 12, increment: 5, perSide: true, freeform: false, note: 'light — knee-friendly, dance-relevant single-leg work'},
    {name: 'Face pulls or band pull-aparts', session: 'A', sets: 2, repMin: 15, repMax: 20, increment: 5, perSide: false, freeform: true},
    {name: 'Pallof press or suitcase carry', session: 'A', sets: 2, increment: 5, perSide: false, freeform: true, note: '2 rounds'},

    {name: 'Squat', session: 'B', sets: 3, repMin: 6, repMax: 10, increment: 10, perSide: false, freeform: false, note: 'double progression'},
    {name: 'Overhead press', session: 'B', sets: 3, repMin: 6, repMax: 10, increment: 5, perSide: false, freeform: false, note: 'progressive overhead load = shoulder insurance + dance-lift base'},
    {name: 'Deadlift', session: 'B', sets: 2, repMin: 5, repMax: 8, increment: 10, perSide: false, freeform: false},
    {name: 'Pull-ups', session: 'B', sets: 3, repMin: 5, repMax: 8, increment: 5, perSide: false, freeform: false, note: 'bodyweight until 3×8, then add weight'},
    {name: 'Waiter carry', session: 'B', sets: 2, increment: 5, perSide: true, freeform: true, note: 'one arm overhead, 2 lengths per side — start left, right matches'},

    {name: 'Shoulder prep circuit', session: 'mini', sets: 1, increment: 0, perSide: false, freeform: true},
    {name: 'Pull-ups or rows (easy)', session: 'mini', sets: 2, increment: 0, perSide: false, freeform: true, note: 'nowhere near failure'},
    {name: 'Suitcase + waiter carries', session: 'mini', sets: 2, increment: 0, perSide: true, freeform: true},
  ],
  milestones: [
    {id: 'ohp-strict', exercise: 'Overhead press', weight: 115, reps: 3, label: 'Strict OHP 115–120×3 (dance-lift phase 1)'},
    {id: 'waiter-carry', exercise: 'Waiter carry', weight: 40, reps: 1, label: 'Heavy waiter carry 40–50 lb one arm'},
    {id: 'push-press', exercise: 'Push press', weight: 135, reps: 2, label: 'Push press 135–150×2 (dance-lift phase 2)'},
  ],
}
