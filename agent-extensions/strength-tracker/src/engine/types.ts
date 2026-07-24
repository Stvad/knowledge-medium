/** Domain types for the strength-program engine.
 *
 *  Everything under `src/engine/` is pure: no km imports, no DOM, no
 *  clock. The km side (`src/km/`) reads blocks into these shapes, calls
 *  the engine, and writes the result back as blocks. That split is what
 *  makes the progression rules unit-testable and keeps the program logic
 *  from leaking into UI components.
 */

export type SessionType = 'A' | 'B' | 'mini'

/** Full sessions are the ones the re-entry clock counts. Mini days are
 *  the maintenance floor — they're logged, and they keep the habit, but
 *  per the plan they deliberately do NOT reset the layoff gap. */
export const FULL_SESSIONS: readonly SessionType[] = ['A', 'B']

export const isFullSession = (session: SessionType): boolean =>
  session === 'A' || session === 'B'

export interface ExerciseConfig {
  /** Canonical name; the join key against `strength:exercise` on logged
   *  entries. Renaming here without renaming logged blocks starts a new
   *  progression line, which is why the UI edits config rather than code. */
  name: string
  session: SessionType
  /** Working sets prescribed at full health. */
  sets: number
  /** Double-progression window. Both undefined for work the plan does
   *  not progress by load (carries, Pallof rounds) — still logged, never
   *  auto-loaded. */
  repMin?: number
  repMax?: number
  /** Load added once the top of the range is hit on every prescribed set.
   *  +5 upper / +10 lower per the plan. */
  increment: number
  /** Logged per side; the plan's rule is left leads and right matches. */
  perSide: boolean
  /** Carries and rounds-based work: reps are "lengths"/"rounds", and the
   *  engine never proposes a weight jump from a rep count. */
  freeform: boolean
  /** Verbatim tail of the plan line ("light (knee-friendly…)"). Shown
   *  under the exercise so the reasoning survives into the gym. */
  note?: string
  /** Bigger jump for a lift that's catching up after being under-trained
   *  (the plan's deadlift rule: "+20 instead of +10 while RPE ≤ 7"). Only
   *  applies when every progression set is logged at or below `catchUpRpe`,
   *  so it needs RPE data; without it the normal `increment` is used. */
  catchUpIncrement?: number
  catchUpRpe?: number
  /** Demo/technique links lifted from the plan line's markdown links. */
  videos?: readonly ExerciseVideo[]
}

export interface ExerciseVideo {
  label: string
  url: string
}

/** One row of the plan's re-entry table, keyed by the gap since the last
 *  full session. Tiers are ordered by `maxGapDays`; the first tier whose
 *  bound the gap fits under wins. */
export interface ReentryTier {
  id: string
  /** The plan's own phrasing — shown in the banner so the prescription
   *  is traceable back to the table. */
  label: string
  /** Inclusive upper bound in days. The last tier uses `Infinity`. */
  maxGapDays: number
  /** Fraction of pre-break working weight for the first session back. */
  pct: number
  /** Absolute set count while ramping (the "2 sets per lift" rows). */
  setsOverride?: number
  /** How many sessions back `setsOverride` applies for. The 1–2 month row
   *  scopes it to "week one"; the 2+ month row leaves it on for the whole
   *  ramp. Undefined = the whole ramp. */
  setsOverrideSessions?: number
  /** Sets dropped on the *first* session back only ("drop 1 set"). */
  setsDelta?: number
  /** Rep-range override while ramping (the 2+ month row's 8–12). */
  repMin?: number
  repMax?: number
  /** Full sessions spent under this tier before normal double
   *  progression resumes. */
  sessionsToNormal: number
  /** Added to `pct` per full session back ("+5% per session"). */
  rampPerSession: number
  guidance: string
}

/** The `pct === 1`, no-override, zero-session tier: training is on
 *  schedule and nothing about the recorded-layoff prescription changes.
 *  (Per-lift progression holds are handled separately in `prescribe`, not
 *  as a tier — see `perLiftCadenceDays`.) */
export const isOnScheduleTier = (tier: ReentryTier): boolean =>
  tier.pct === 1 &&
  tier.setsOverride === undefined &&
  (tier.setsDelta ?? 0) === 0 &&
  tier.sessionsToNormal === 0

export interface Milestone {
  id: string
  exercise: string
  weight: number
  reps: number
  label: string
}

export interface ProgramConfig {
  unit: 'lb' | 'kg'
  /** Smallest loadable jump; re-entry percentages round to it. */
  roundTo: number
  /** Sessions run past midnight, so the training day rolls over at this
   *  local hour, not at 00:00. A Sunday session logged at 1:10am Monday
   *  is Sunday's Session B — for the weekly template AND for the gap
   *  clock. */
  dayRolloverHour: number
  /** A lift trained within this many days is on its own schedule.
   *
   *  Every lift in this program appears in exactly one session, so each is
   *  a once-a-week lift. The gap clock, though, is global (days since any
   *  full session) — which is right for detraining but means that dropping
   *  Sunday for a month reads as "missed a session" every Thursday and
   *  would freeze bench progression forever, even though bench has been
   *  trained every seven days like clockwork. So the mildest row's
   *  "no jump" only binds a lift that is itself overdue. Deeper rows cut
   *  load outright and ignore this — after three weeks away, everything is
   *  stale. */
  perLiftCadenceDays: number
  /** Local weekday (0 = Sunday) → scheduled session. */
  weeklyTemplate: Readonly<Record<number, SessionType>>
  exercises: readonly ExerciseConfig[]
  reentry: readonly ReentryTier[]
  milestones: readonly Milestone[]
  /** Per-session reminders lifted from the plan (warm-up, RPE cap). */
  sessionNotes: Readonly<Record<SessionType, readonly string[]>>
}

// ──── Logged history ────

export interface SetRecord {
  /** Added load. 0 means bodyweight / unloaded. */
  weight: number
  reps: number
  rpe?: number
  side?: 'L' | 'R'
}

export interface ExerciseRecord {
  exercise: string
  /** What the engine asked for at the time. Kept so progression judges
   *  "all prescribed sets" against the prescription that was actually
   *  live, not against today's config. */
  prescribedWeight?: number
  prescribedSets?: number
  sets: readonly SetRecord[]
}

export interface WorkoutRecord {
  id: string
  /** ISO timestamp of the session. */
  date: string
  session: SessionType
  exercises: readonly ExerciseRecord[]
}

/** A recorded break. `from` is the last pre-break full session, `to` the
 *  first session back — so "sessions since the layoff" counts sessions
 *  on or after `to`, and pre-break baselines read history on or before
 *  `from`. */
export interface LayoffRecord {
  id: string
  from: string
  to: string
  days: number
  tierId: string
  pct: number
}

// ──── Prescription ────

export interface PrescribedExercise {
  exercise: string
  sets: number
  repMin?: number
  repMax?: number
  /** Undefined when there's no load history yet — the UI asks for a
   *  starting weight instead of guessing. */
  weight?: number
  perSide: boolean
  freeform: boolean
  note?: string
  videos?: readonly ExerciseVideo[]
  /** One line explaining where `weight` came from. Always shown: the
   *  plan's whole point is that the number is never a mystery. */
  rationale: string
  lastTime?: {
    date: string
    weight: number
    reps: readonly number[]
  }
}

export interface ReentryStatus {
  tier: ReentryTier
  gapDays: number
  /** Training day of the last full session before the break. */
  from: string
  /** Full sessions already logged since the break ended. 0 on the first
   *  night back. */
  sessionsBack: number
  /** Fraction of pre-break weights this session prescribes. */
  factor: number
  /** True until this session has been logged — i.e. the layoff hasn't
   *  been recorded as a block yet. */
  pending: boolean
  banner: string
}

export interface Prescription {
  /** Training day (YYYY-MM-DD), not the wall-clock date. */
  day: string
  session: SessionType
  /** True when the weekly template has nothing scheduled today and the
   *  session type was inferred from what's most overdue. */
  offSchedule: boolean
  exercises: readonly PrescribedExercise[]
  reentry?: ReentryStatus
  notes: readonly string[]
}
