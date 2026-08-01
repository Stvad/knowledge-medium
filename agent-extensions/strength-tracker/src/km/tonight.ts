/** Reading the program, so a session can be stamped or closed.
 *
 *  The plan outline is only ever needed at the two moments a decision is made
 *  — Start (what should tonight be?) and Finish (was this the first session
 *  back from a break?). Everything in between reads blocks alone, which is
 *  why the decorations never touch this module.
 */

import type {BlockData} from '@/data/api/index.js'
import {hasBlockType} from '@/data/properties.js'
import {getOrCreateDailyNote} from '@/plugins/daily-notes/dailyNotes.js'
import type {Repo} from '@/data/repo.js'

import {prescribe} from '../engine/prescribe'
import {
  detectPendingLayoff, layoffAlreadyRecorded, layoffFromPending,
} from '../engine/reentry'
import {trainingDay} from '../engine/schedule'
import type {
  LayoffRecord, Prescription, ProgramConfig, SessionType, WorkoutRecord,
} from '../engine/types'
import {configFor, loadPlanSource, type PlanSource} from './config'
import {EXERCISE_ENTRY_TYPE, FIELD, LAYOFF_TYPE, SET_TYPE, WORKOUT_TYPE} from './fields'
import {buildHistory, buildLayoffs} from './history'
import {getOrCreateSettingsBlock, getOrCreateStrengthLogPage} from './page'
import {finishSession, type FinishOutcome} from './session'

export interface ProgramSnapshot {
  config: ProgramConfig
  warnings: readonly string[]
  history: readonly WorkoutRecord[]
  layoffs: readonly LayoffRecord[]
  /** Where layoff records and settings live. */
  pageId: string
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
  const page = await getOrCreateStrengthLogPage(repo, workspaceId)
  const settingsBlockId = await getOrCreateSettingsBlock(repo, workspaceId, page.id).catch(() => null)
  const planSource = await loadPlanSource(repo, workspaceId, settingsBlockId)
  const {config, warnings} = configFor(planSource, altChoiceOverrides)

  // ONE query for the whole tree, `types` being any-of: three separate ones
  // resolve independently, and a history assembled from a half-arrived tree
  // would prescribe off a session that looks emptier than it is.
  const tree = splitTree(await repo.query.typedBlocks({
    workspaceId,
    types: [WORKOUT_TYPE, EXERCISE_ENTRY_TYPE, SET_TYPE],
  }).load())
  const layoffRows = await repo.query.typedBlocks({workspaceId, types: [LAYOFF_TYPE]}).load()

  return {
    config,
    warnings,
    history: buildHistory(tree.workouts, tree.exercises, tree.sets),
    layoffs: buildLayoffs(layoffRows),
    pageId: page.id,
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

/** Finish, recording the break this session ends if there is one.
 *
 *  Decided from history as it stands BEFORE this session joins it, and handed
 *  to `finishSession` so both land in one transaction: written first, a
 *  finish that then refuses leaves a break recorded against a session that
 *  never happened; written after, a failure loses the record for good, since
 *  the gap becomes undetectable the moment this session is the latest one.
 */
/** Where tonight's session gets filed: the training day's daily note.
 *
 *  `day` is a training day (`YYYY-MM-DD`), which is exactly the calendar-ISO
 *  string `getOrCreateDailyNote` takes — it parses `^\d{4}-\d{2}-\d{2}$` and
 *  throws on anything else, a full timestamp included. Kept as a named
 *  function so the contract between the engine's day and the daily-note API
 *  has somewhere to be tested. */
export const sessionParent = async (
  repo: Repo,
  workspaceId: string,
  day: string,
): Promise<string> => (await getOrCreateDailyNote(repo, workspaceId, day)).id

export const closeSession = async (
  repo: Repo,
  workspaceId: string,
  workoutId: string,
): Promise<FinishOutcome> => {
  const snapshot = await readProgram(repo, workspaceId)
  // The gap ends on the day the session was PERFORMED, not the day you got
  // round to tapping Finish. Train Friday night, finish Saturday morning, and
  // the clock would report one day more — enough to drop you a re-entry tier —
  // and would date the comeback to a day this session isn't on, so
  // `resolveReentry` wouldn't count it as a session back and the ramp would
  // run one session long. Both are permanent: the record is keyed on `from`,
  // so a later finish adopts the wrong one rather than correcting it.
  const workout = await repo.load(workoutId)
  const performedOn = typeof workout?.properties[FIELD.date] === 'string'
    ? trainingDay(workout.properties[FIELD.date] as string, snapshot.config.dayRolloverHour)
    : snapshot.day
  const pending = detectPendingLayoff(snapshot.history, performedOn, snapshot.config)
  const layoff = pending && !layoffAlreadyRecorded(pending, snapshot.layoffs)
    ? {pageId: snapshot.pageId, record: layoffFromPending(pending)}
    : undefined
  return finishSession(repo, workoutId, layoff)
}
