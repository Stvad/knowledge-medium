/** Reading the program, so a session can be stamped or closed.
 *
 *  The plan outline is only ever needed at the two moments a decision is made
 *  — Start (what should tonight be?) and Finish (was this the first session
 *  back from a break?). Everything in between reads blocks alone, which is
 *  why the decorations never touch this module.
 */

import type {BlockData} from '@/data/api/index.js'
import {hasBlockType} from '@/data/properties.js'
import type {Repo} from '@/data/repo.js'

import {prescribe} from '../engine/prescribe'
import {
  coveringLayoff, detectPendingLayoff, lastFullSessionBasis, layoffFromPending,
} from '../engine/reentry'
import {trainingDay} from '../engine/schedule'
import type {
  LayoffRecord, Prescription, ProgramConfig, SessionType, WorkoutRecord,
} from '../engine/types'
import {configFor, loadPlanSource, type PlanSource} from './config'
import {EXERCISE_ENTRY_TYPE, FIELD, LAYOFF_TYPE, SET_TYPE, WORKOUT_TYPE} from './fields'
import {buildHistory, buildLayoffs} from './history'
import {asWorkout} from './records'
import {findSettingsBlock, findStrengthLogPage, getOrCreateSettingsBlock, getOrCreateStrengthLogPage} from './page'
// `mostRecentlyStarted` lives beside the stamp, not here: this pre-check and
// the transaction that adopts have to name the SAME session.
import {
  finishBlocker, finishSession, mostRecentlyStarted, setEditsSettled, type FinishOutcome,
} from './session'

export interface ProgramSnapshot {
  config: ProgramConfig
  warnings: readonly string[]
  history: readonly WorkoutRecord[]
  layoffs: readonly LayoffRecord[]
  /** Where layoff records and settings live — `null` until something is
   *  written there. */
  pageId: string | null
  settingsBlockId: string | null
  day: string
  /** The plan as read, so a caller can re-resolve it against different
   *  `or`-group picks without touching the database again. */
  planSource: PlanSource
}

const splitTree = (rows: readonly BlockData[]) => {
  const workouts: BlockData[] = []
  const exercises: BlockData[] = []
  const sets: BlockData[] = []
  for (const row of rows) {
    if (hasBlockType(row, WORKOUT_TYPE)) workouts.push(row)
    if (hasBlockType(row, EXERCISE_ENTRY_TYPE)) exercises.push(row)
    if (hasBlockType(row, SET_TYPE)) sets.push(row)
  }
  return {workouts, exercises, sets}
}

/** Everything the engine needs, read once. */
export const readProgram = async (
  repo: Repo,
  workspaceId: string,
  altChoiceOverrides?: Readonly<Record<string, string>>,
): Promise<ProgramSnapshot> => {
  // Found, never created: this runs before the start dialog is even shown,
  // and a preview you cancel must leave the workspace exactly as it was.
  // `ensureStrengthHome` does the creating, at the two moments something is
  // actually written here.
  const pageId = await findStrengthLogPage(repo, workspaceId)
  const settingsBlockId = pageId ? await findSettingsBlock(repo, workspaceId, pageId) : null
  const planSource = await loadPlanSource(repo, workspaceId, settingsBlockId)
  const {config, warnings} = configFor(planSource, altChoiceOverrides)

  // ONE query for the whole tree, `types` being any-of: three separate ones
  // resolve independently, and a history assembled from a half-arrived tree
  // would prescribe off a session that looks emptier than it is.
  // Layoffs ride in the SAME any-of query as the tree. Read separately, a peer
  // finishing the first comeback session between the two loads gives you
  // pre-finish history beside the layoff that finish created atomically —
  // `resolveReentry` then counts zero sessions since the break and hands a
  // concurrently started second session the first-session cut all over again.
  const rows = await repo.query.typedBlocks({
    workspaceId,
    types: [WORKOUT_TYPE, EXERCISE_ENTRY_TYPE, SET_TYPE, LAYOFF_TYPE],
  }).load()
  const tree = splitTree(rows)
  const layoffRows = (rows as BlockData[]).filter(row => hasBlockType(row, LAYOFF_TYPE))

  return {
    config,
    warnings,
    history: buildHistory(tree.workouts, tree.exercises, tree.sets),
    layoffs: buildLayoffs(layoffRows),
    pageId,
    settingsBlockId,
    day: trainingDay(new Date(), config.dayRolloverHour),
    planSource,
  }
}

/** Prescribe for a given session and set of `or`-group picks, without going
 *  back to the database — the plan is already read, and everything from here
 *  down is pure. `now` is captured by the caller so a session that crosses
 *  midnight stays on one training day however long the dialog is open. */
export const prescribeFor = (
  snapshot: ProgramSnapshot,
  now: Date,
  session?: SessionType,
  altChoices?: Readonly<Record<string, string>>,
): Prescription => prescribe({
  history: snapshot.history,
  layoffs: snapshot.layoffs,
  config: altChoices && Object.keys(altChoices).length > 0
    ? configFor(snapshot.planSource, altChoices).config
    : snapshot.config,
  now,
  ...(session !== undefined ? {session} : {}),
})

/** The in-progress workout for the training day this snapshot describes, if
 *  there is one — the same three fields the readers file a workout by.
 *
 *  Read straight from the blocks rather than from `history`, which holds only
 *  FINISHED sessions by design and so can never answer this. */
export const standingSession = async (
  repo: Repo,
  workspaceId: string,
  snapshot: ProgramSnapshot,
  now: Date,
): Promise<string | null> => {
  const day = trainingDay(now, snapshot.config.dayRolloverHour)
  const rows = await repo.query.typedBlocks({workspaceId, types: [WORKOUT_TYPE]}).load()
  const live: BlockData[] = (rows as BlockData[]).filter(row => {
    const workout = asWorkout(row)
    return workout !== null && workout.live && workout.on !== null
      && trainingDay(workout.on, snapshot.config.dayRolloverHour) === day
  })
  return mostRecentlyStarted(live)
}

/** The log page and its settings block, created if they are not there yet.
 *  Called only from the two paths that write into them — recording a layoff,
 *  and recording an `or`-group choice — so nothing is bootstrapped by merely
 *  looking. */
export const ensureStrengthHome = async (
  repo: Repo,
  workspaceId: string,
): Promise<{pageId: string; settingsBlockId: string}> => {
  const page = await getOrCreateStrengthLogPage(repo, workspaceId)
  return {pageId: page.id, settingsBlockId: await getOrCreateSettingsBlock(repo, workspaceId, page.id)}
}

/** Finish, recording the break this session ends if there is one.
 *
 *  Decided from history as it stands BEFORE this session joins it, and handed
 *  to `finishSession` so both land in one transaction: written first, a
 *  finish that then refuses leaves a break recorded against a session that
 *  never happened; written after, a failure loses the record for good, since
 *  the gap becomes undetectable the moment this session is the latest one.
 */
export const closeSession = async (
  repo: Repo,
  workspaceId: string,
  workoutId: string,
): Promise<FinishOutcome> => {
  // BEFORE the read, so what follows sees the edit's result. Finish is one tap
  // after a blur, and the blur's `adjustSet` is a transaction of its own that
  // nothing awaits — overtake it and the session closes around the number you
  // had already replaced, while the edit refuses as `closed`.
  if (await setEditsSettled(repo, workoutId) === 'failed') return 'edit-failed'
  const snapshot = await readProgram(repo, workspaceId)
  // The gap ends on the day the session was PERFORMED, not the day you got
  // round to tapping Finish. Train Friday night, finish Saturday morning, and
  // the clock would report one day more — enough to drop you a re-entry tier —
  // and would date the comeback to a day this session isn't on, so
  // `resolveReentry` wouldn't count it as a session back and the ramp would
  // run one session long. Both are permanent: the record is keyed on `from`,
  // so a later finish adopts the wrong one rather than correcting it.
  const workout = await repo.load(workoutId)
  // Asked before the date is: a peer discarding this workout while the program
  // was being read leaves no row at all, and reading a date off `undefined`
  // turns that into `undated` — which tells you to set a date on a workout
  // that is not there. `finishSession` would say `gone`; say it here too.
  if (!workout || workout.deleted) return 'gone'
  // `trainingDay`, matching `detectPendingLayoff`, which decodes the history
  // it compares against the same way (`fullSessionDays`). Decoding this one
  // call site differently would put the gap's two ends on different scales.
  // What made the two disagree was an unbounded `rolloverHour`; that is
  // constrained where it is read — see `applySettings`.
  // The instant comes from `asWorkout`, which normalises it: a date typed into
  // the property editor is UTC midnight, whose LOCAL day is the one before west
  // of UTC — so repairing a workout's date would file its layoff against the
  // wrong day. See `storedDate`.
  const view = asWorkout(workout)
  const performedOn = view?.on ? trainingDay(view.on, snapshot.config.dayRolloverHour) : null
  // `strength:date` is hand-editable. Cleared or corrupted, substituting the
  // clock would close a workout that `buildHistory` then drops whole — the
  // session gone from progression, its todos already stripped, and no way
  // back through Finish. Refuse instead, and say why.
  if (performedOn === null) return 'undated'
  // A MINI day does not end a break, so it must not record the return.
  // `fullSessionDays` — which is what `detectPendingLayoff` measures gaps
  // between — excludes mini sessions on purpose: they are habit continuity,
  // not stimulus. Recording one anyway dated the comeback to the mini day, and
  // because the record is keyed on `from`, the real full session back could
  // not replace it: every later prescription then resolved against a SHORTER
  // gap and whatever tier that fell in, so a deep re-entry could jump to a
  // much heavier tier after one easy session. The first full session records
  // the actual return.
  const isMini = view?.isMini === true
  const pending = isMini ? null : detectPendingLayoff(snapshot.history, performedOn, snapshot.config)
  // WHICH record satisfied the check, not merely that one did — writing nothing
  // because a record already covers the gap is a decision resting on that row,
  // and it has to travel into the transaction like any other. Through
  // `coveringLayoff`, which IS the predicate `layoffAlreadyRecorded` asks, so
  // the two cannot disagree about what "already covered" means.
  const covering = pending
    ? coveringLayoff(pending, snapshot.layoffs, snapshot.config)
    : undefined
  const record = pending && !covering ? layoffFromPending(pending) : undefined
  // Both facts the decision above rests on travel INTO the transaction, and
  // `isMini` is the one that goes wrong silently: this branch writes no layoff,
  // so a flip from `mini` to `A` between the read and the commit closes the
  // session as a full one with no record — after which the gap is undetectable
  // on every later day and the re-entry cut is gone for good, rather than
  // merely misfiled. See `FinishExpectation`.
  // `basis` alongside them: the gap was measured from the last full session
  // day, and that day is a history read, not a property of this workout —
  // `finishSession` re-checks the target and would not have noticed.
  const expected = {
    date: workout.properties[FIELD.date],
    mini: isMini,
    basis: lastFullSessionBasis(snapshot.history, snapshot.config),
    ...(covering !== undefined
      ? {layoffOnRecord: {
        id: covering.id, from: covering.from,
        tierId: covering.tierId, days: covering.days,
      }}
      : {}),
  }
  if (!record) return finishSession(repo, workoutId, undefined, expected)

  // A gap record needs a home, but creating one is a WRITE and every refusal
  // below is documented as writing nothing — bootstrapped eagerly, a Finish
  // that then returns `gone`/`misfiled`/`nothing-logged` left a Strength Log
  // page behind. So ask the same questions first, and build only if they pass.
  //
  // Advisory: `finishSession` re-asks inside the transaction that writes, so a
  // peer can still refuse after the home exists. That window cannot be closed
  // without putting page creation inside the finishing transaction, which
  // `ensureStrengthHome` cannot be — it runs transactions of its own.
  const blocker = await finishBlocker(repo, workoutId, expected)
  if (blocker) return blocker

  return finishSession(repo, workoutId, {
    pageId: (await ensureStrengthHome(repo, workspaceId)).pageId,
    record,
    knownIds: snapshot.layoffs.map(entry => entry.id),
    reentry: snapshot.config.reentry,
  }, expected)
}
