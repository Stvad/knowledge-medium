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
  detectPendingLayoff, layoffAlreadyRecorded, layoffFromPending,
} from '../engine/reentry'
import {trainingDay} from '../engine/schedule'
import type {
  LayoffRecord, Prescription, ProgramConfig, SessionType, WorkoutRecord,
} from '../engine/types'
import {configFor, loadPlanSource, type PlanSource} from './config'
import {EXERCISE_ENTRY_TYPE, FIELD, LAYOFF_TYPE, SET_TYPE, WORKOUT_TYPE} from './fields'
import {buildHistory, buildLayoffs} from './history'
import {findSettingsBlock, findStrengthLogPage, getOrCreateSettingsBlock, getOrCreateStrengthLogPage} from './page'
import {finishSession, type FinishOutcome} from './session'

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

/** Which of several live sessions a tap continues.
 *
 *  Most recently STARTED. Two can look live at once while a peer's `done`
 *  update is still in flight, and an id has nothing to do with chronology —
 *  so taking the lowest could send you to the session you already finished,
 *  whose set checkboxes are (deliberately) still live, and log tonight's work
 *  into last night's record. `created_at` is the creating device's clock at
 *  insert, and the systemMint path zeroes `updated_at` only, so it survives a
 *  derived-id mint intact.
 *
 *  Id breaks the tie so every device names the same one. Pulled out as a pure
 *  function because that tie-break is otherwise untestable: the query happens
 *  to return rows in an order that produces the same answer, so a test
 *  through `standingSession` passes whether the clause is there or not.
 */
export const mostRecentlyStarted = (
  rows: readonly {id: string; createdAt: number}[],
): string | null => {
  let best: {id: string; createdAt: number} | null = null
  for (const row of rows) {
    if (best === null
      || row.createdAt > best.createdAt
      || (row.createdAt === best.createdAt && row.id < best.id)) best = row
  }
  return best?.id ?? null
}

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
  const live: BlockData[] = (rows as BlockData[]).filter(row =>
    !row.deleted
    && row.properties[FIELD.status] === 'in-progress'
    && typeof row.properties[FIELD.date] === 'string'
    && trainingDay(row.properties[FIELD.date] as string, snapshot.config.dayRolloverHour) === day)
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
  const snapshot = await readProgram(repo, workspaceId)
  // The gap ends on the day the session was PERFORMED, not the day you got
  // round to tapping Finish. Train Friday night, finish Saturday morning, and
  // the clock would report one day more — enough to drop you a re-entry tier —
  // and would date the comeback to a day this session isn't on, so
  // `resolveReentry` wouldn't count it as a session back and the ramp would
  // run one session long. Both are permanent: the record is keyed on `from`,
  // so a later finish adopts the wrong one rather than correcting it.
  const workout = await repo.load(workoutId)
  const stored = workout?.properties[FIELD.date]
  // `trainingDay`, matching `detectPendingLayoff`, which decodes the history
  // it compares against the same way (`fullSessionDays`). Decoding this one
  // call site differently would put the gap's two ends on different scales.
  // What made the two disagree was an unbounded `rolloverHour`; that is
  // constrained where it is read — see `applySettings`.
  const performedOn = typeof stored === 'string' && !Number.isNaN(new Date(stored).getTime())
    ? trainingDay(stored, snapshot.config.dayRolloverHour)
    : null
  // `strength:date` is hand-editable. Cleared or corrupted, substituting the
  // clock would close a workout that `buildHistory` then drops whole — the
  // session gone from progression, its todos already stripped, and no way
  // back through Finish. Refuse instead, and say why.
  if (performedOn === null) return 'undated'
  const pending = detectPendingLayoff(snapshot.history, performedOn, snapshot.config)
  const record = pending && !layoffAlreadyRecorded(pending, snapshot.layoffs)
    ? layoffFromPending(pending)
    : undefined
  // The page is created HERE, not at read time — a gap record needs a home,
  // and this is the first moment one is actually being written.
  const layoff = record
    ? {
      pageId: (await ensureStrengthHome(repo, workspaceId)).pageId,
      record,
      knownIds: snapshot.layoffs.map(entry => entry.id),
    }
    : undefined
  return finishSession(repo, workoutId, layoff, workout?.properties[FIELD.date])
}
