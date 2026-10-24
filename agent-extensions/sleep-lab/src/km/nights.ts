/** The write path for nights, their sessions and their dose.
 *
 *  Three writers reach a night — the evening gesture, the morning check-in
 *  and the importer — and none of them controls when the others fire, so a
 *  night's id is DERIVED from its wake date and every writer converges on
 *  one block. Same for a session (its start minute) and a dose (its night).
 *  A `taken` seat — a tombstone, or a row in another workspace — falls back
 *  to a lookup and then a minted id: a deleted night was deleted on purpose,
 *  and resurrecting it silently is worse than a visible second block.
 *
 *  Every write re-reads what it is about to change inside its transaction.
 */

import {ChangeScope, propertyValue, type BlockData, type Tx} from '@/data/api/index.js'
import {hasBlockType} from '@/data/properties.js'
import type {Repo} from '@/data/repo.js'
import {createTypedChild, getOrCreateTypedChild, type DerivedIdentity} from '@/data/typedRecords.js'
import {statusProp as todoStatusProp, TODO_TYPE} from '@/plugins/todo/schema.js'

import {deriveMeasures, pickMain, wakeDateOf} from '../engine/derive'
import type {Arm, ImportedSession, NightRating, SessionMeasure, SessionRecord} from '../engine/types'
import {addDays, dayToDate} from './day'
import {DOSE_TYPE, FIELD, NIGHT_TYPE, SESSION_TYPE} from './fields'
import {getOrCreateLabPage} from './page'
import {asNight, asSession} from './records'
import {
  alcoholProp, armProp, caffeineLateProp, dateProp, endProp, experimentProp, externalIdProp,
  lateMealProp, mainProp, MEASURE_PROPS, periodProp, RATING_PROPS, sourceProp, startProp,
  takenAtProp, unusualProp, unusualReasonProp,
} from './schema'

type TypeSnapshot = ReturnType<Repo['snapshotTypeRegistries']>

// Fresh uuid-v5 namespaces, one per derived record kind. Never change them.
const NIGHT_NS = '4f74bc41-d8af-4019-8475-2cabbb32c3f1'
const SESSION_NS = '2888fafa-d9ea-417d-89a5-164459a4ceee'
const DOSE_NS = '29918fa8-bfee-4dad-ac7f-a0d208be6972'

export const nightIdentity = (workspaceId: string, date: string): DerivedIdentity =>
  ({namespace: NIGHT_NS, key: `${workspaceId}/${date}`})

/** Keyed to the MINUTE, so the same session reported by two sources that
 *  disagree by seconds still lands on one block. */
const startMinute = (start: Date): number => Math.floor(start.getTime() / 60_000)
const sameMinute = (a: Date, b: Date): boolean => startMinute(a) === startMinute(b)

export const sessionIdentity = (workspaceId: string, start: Date): DerivedIdentity =>
  ({namespace: SESSION_NS, key: `${workspaceId}/${startMinute(start)}`})

export const doseIdentity = (nightId: string): DerivedIdentity =>
  ({namespace: DOSE_NS, key: nightId})

export const nightContent = (date: string): string => `Night of ${addDays(date, -1)} → ${date}`

const hhmm = (at: Date): string =>
  `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`

export const sessionContent = (session: {start: Date; end: Date}, main: boolean): string =>
  `${main ? 'Sleep' : 'Nap'} ${hhmm(session.start)} → ${hhmm(session.end)}`

// ──── Night ────

export interface NightSeat {
  workspaceId: string
  pageId: string
  date: string
  typeSnapshot: TypeSnapshot
}

/** The night block for `date`, created under the page if it is not there.
 *
 *  Any live block at the derived id is adopted whatever its parent: a night
 *  is a record the user is free to file anywhere (into a daily note, say),
 *  and rejecting a moved one would strand it and mint a duplicate. */
export const getOrCreateNightInTx = async (repo: Repo, tx: Tx, seat: NightSeat): Promise<string> => {
  const spec = {
    parentId: seat.pageId,
    content: nightContent(seat.date),
    types: [NIGHT_TYPE],
    properties: [propertyValue(dateProp, dayToDate(seat.date))],
    // Newest at the top: the page reads as a log.
    position: {kind: 'first'} as const,
    typeSnapshot: seat.typeSnapshot,
  }
  const outcome = await getOrCreateTypedChild(repo, tx, {identity: nightIdentity(seat.workspaceId, seat.date), ...spec})
  if (outcome.status === 'created') return outcome.id
  if (outcome.status === 'adopted') {
    // Adopt repairs types, not properties. The seat IS this date's night by
    // identity — its id encodes the date — so a block whose date is missing
    // or was edited to another day gets the seat's date back: readers file a
    // night by its date, and a mismatch would split one night's sessions
    // across two dates. A night is not re-dated by hand; it is deleted.
    if (asNight(outcome.block)?.date !== seat.date) await tx.setProperty(outcome.id, dateProp, dayToDate(seat.date))
    return outcome.id
  }

  // Decoded by the same rule every reader uses (`asNight` → `storedDate`),
  // so an editor-typed date finds its block here too.
  const minted = (await tx.childrenOf(seat.pageId, undefined, {hidePropertyChildren: true}))
    .find(block => !block.deleted && asNight(block)?.date === seat.date)
  return minted ? minted.id : createTypedChild(repo, tx, spec)
}

export type AssignOutcome = 'assigned' | 'already' | 'gone'

/** Stamp the schedule's answer onto a night that has none yet. Never
 *  relabels: a night that has an arm was slept under it. */
export const assignNightInTx = async (
  tx: Tx,
  nightId: string,
  assignment: {experimentId: string; periodId: string; arm: Arm},
): Promise<AssignOutcome> => {
  const night = await tx.get(nightId)
  if (!night || night.deleted || !hasBlockType(night, NIGHT_TYPE)) return 'gone'
  const preset = typeof night.properties[FIELD.arm] === 'string'
  // A hand-set arm stays, but the night still belongs to the experiment and
  // period covering its date — without the refs the analysis, which reads
  // nights by experiment, would never see it.
  // The two refs are ONE assignment: written together, and a night that has
  // either is left as found rather than completed from another experiment.
  const hasAssignment = typeof night.properties[FIELD.experiment] === 'string'
    || typeof night.properties[FIELD.period] === 'string'
  if (!hasAssignment) {
    await tx.setProperty(nightId, experimentProp, assignment.experimentId)
    await tx.setProperty(nightId, periodProp, assignment.periodId)
  }
  if (preset) return 'already'
  await tx.setProperty(nightId, armProp, assignment.arm)
  return 'assigned'
}

// ──── Dose ────

/** The night's dose todo, created if absent. Positional — it lives under
 *  its night — so a block dragged elsewhere is not this night's dose. */
export const ensureDoseInTx = async (
  repo: Repo,
  tx: Tx,
  {nightId, text, typeSnapshot}: {nightId: string; text: string; typeSnapshot: TypeSnapshot},
): Promise<string> => {
  const spec = {
    parentId: nightId,
    content: text,
    types: [DOSE_TYPE, TODO_TYPE],
    properties: [propertyValue(todoStatusProp, 'open')],
    position: {kind: 'first'} as const,
    typeSnapshot,
  }
  const outcome = await getOrCreateTypedChild(repo, tx, {
    identity: doseIdentity(nightId),
    adoptable: block => block.parentId === nightId,
    ...spec,
  })
  if (outcome.status !== 'taken') return outcome.id
  const minted = (await tx.childrenOf(nightId, undefined, {hidePropertyChildren: true}))
    .find(block => !block.deleted && hasBlockType(block, DOSE_TYPE))
  return minted ? minted.id : createTypedChild(repo, tx, spec)
}

export type WriteOutcome = 'written' | 'gone'

/** Tick the dose and stamp when. The tick is the todo's own status, so the
 *  native checkbox and this button agree. */
export const markDoseTaken = (repo: Repo, doseId: string, now: number = Date.now()): Promise<WriteOutcome> =>
  repo.tx(async tx => {
    const dose = await tx.get(doseId)
    if (!dose || dose.deleted || !hasBlockType(dose, DOSE_TYPE)) return 'gone'
    await tx.setProperty(doseId, todoStatusProp, 'done')
    await tx.setProperty(doseId, takenAtProp, now)
    return 'written'
  }, {scope: ChangeScope.BlockDefault, description: 'Dose taken'})

// ──── Check-in ────

/** A rating, or `null` to clear it. */
export const writeRating = (
  repo: Repo, nightId: string, rating: NightRating, value: number | null,
): Promise<WriteOutcome> =>
  repo.tx(async tx => {
    // The type is re-read here, not trusted from the render that showed the
    // control: a peer can untag the block in between, and a rating on a
    // block that is no longer a night is a stray property.
    const night = await tx.get(nightId)
    if (!night || night.deleted || !hasBlockType(night, NIGHT_TYPE)) return 'gone'
    if (value === null) await tx.unsetProperty(nightId, RATING_PROPS[rating])
    else await tx.setProperty(nightId, RATING_PROPS[rating], value)
    return 'written'
  }, {scope: ChangeScope.BlockDefault, description: `Rate ${rating}`})

export interface CovariatePatch {
  alcohol?: number | null
  caffeineLate?: boolean
  lateMeal?: boolean
  unusual?: boolean
  unusualReason?: string | null
}

export const writeCovariates = (repo: Repo, nightId: string, patch: CovariatePatch): Promise<WriteOutcome> =>
  repo.tx(async tx => {
    const night = await tx.get(nightId)
    if (!night || night.deleted || !hasBlockType(night, NIGHT_TYPE)) return 'gone'
    if (patch.alcohol === null) await tx.unsetProperty(nightId, alcoholProp)
    else if (patch.alcohol !== undefined) await tx.setProperty(nightId, alcoholProp, patch.alcohol)
    if (patch.caffeineLate !== undefined) await tx.setProperty(nightId, caffeineLateProp, patch.caffeineLate)
    if (patch.lateMeal !== undefined) await tx.setProperty(nightId, lateMealProp, patch.lateMeal)
    if (patch.unusual !== undefined) await tx.setProperty(nightId, unusualProp, patch.unusual)
    if (patch.unusualReason === null) await tx.unsetProperty(nightId, unusualReasonProp)
    else if (patch.unusualReason !== undefined) await tx.setProperty(nightId, unusualReasonProp, patch.unusualReason)
    return 'written'
  }, {scope: ChangeScope.BlockDefault, description: 'Night covariates'})

// ──── Sessions ────

const measureAssignments = (measures: Partial<Record<SessionMeasure, number>>) =>
  (Object.keys(measures) as SessionMeasure[])
    .filter(measure => measures[measure] !== undefined)
    .map(measure => propertyValue(MEASURE_PROPS[measure], measures[measure]))

/** One imported session onto its block: created, or adopted and then
 *  updated with what THIS import knows — source, span, and every measure it
 *  derived. Fields it did not derive are left as they were. */
export const upsertSessionInTx = async (
  repo: Repo,
  tx: Tx,
  {workspaceId, nightId, session, typeSnapshot}: {
    workspaceId: string; nightId: string; session: ImportedSession; typeSnapshot: TypeSnapshot
  },
): Promise<{id: string; status: 'created' | 'updated'}> => {
  const measures = deriveMeasures(session)
  const identityProps = [
    propertyValue(sourceProp, session.source),
    propertyValue(startProp, session.start.getTime()),
    propertyValue(endProp, session.end.getTime()),
    ...(session.externalId !== undefined ? [propertyValue(externalIdProp, session.externalId)] : []),
  ]
  const spec = {
    parentId: nightId,
    // `main` is settled per night AFTER every session of the night is in —
    // see `settleMainInTx` — so a fresh block starts as a nap and is
    // promoted in the same transaction.
    content: sessionContent(session, false),
    types: [SESSION_TYPE],
    properties: [...identityProps, propertyValue(mainProp, false), ...measureAssignments(measures)],
    position: {kind: 'last'} as const,
    typeSnapshot,
  }
  const outcome = await getOrCreateTypedChild(repo, tx, {identity: sessionIdentity(workspaceId, session.start), ...spec})
  if (outcome.status === 'created') return {id: outcome.id, status: 'created'}
  let id: string
  let current: SessionRecord | null
  if (outcome.status === 'adopted') {
    id = outcome.id
    current = asSession(outcome.block)
  } else {
    // The seat holds a tombstone or a row of another workspace, and stays
    // that way — so a previous import already minted a replacement here.
    // Find it by the same identity (its start minute) before minting again,
    // or every re-import adds a block.
    const minted = (await tx.childrenOf(nightId, undefined, {hidePropertyChildren: true}))
      .map(asSession)
      .find(existing => existing !== null && sameMinute(existing.start, session.start))
    if (!minted) return {id: await createTypedChild(repo, tx, spec), status: 'created'}
    id = minted.id
    current = minted
  }
  for (const assignment of [...identityProps, ...measureAssignments(measures)]) {
    await tx.setProperty(id, assignment.schema, assignment.value)
  }
  // The line says the span; a corrected end time must show. The main flag
  // is whatever the block has now — settling is a separate decision.
  await tx.update(id, {content: sessionContent(session, current?.main ?? false)})
  return {id, status: 'updated'}
}

const liveSessionsOf = async (tx: Tx, nightId: string): Promise<SessionRecord[]> =>
  (await tx.childrenOf(nightId, undefined, {hidePropertyChildren: true}))
    .map(asSession)
    .filter((session): session is NonNullable<typeof session> => session !== null)

/** Whether the night's `main` flags are what `pickMain` would set — i.e.
 *  still the importer's own choice. A hand edit (the README's answer to a
 *  night slept in another zone) breaks the match, and that mismatch IS the
 *  override record: nothing else is stored to say so. */
export const mainFlagsMatchHeuristic = (sessions: readonly SessionRecord[]): boolean => {
  const mainIndex = pickMain(sessions)
  return sessions.every((session, index) => session.main === (index === mainIndex))
}

/** Decide which of the night's sessions is the night's sleep, and write
 *  only the flags that change. Callers decide WHEN — `importSessions` only
 *  settles a night whose flags were still its own before the import. */
export const settleMainInTx = async (tx: Tx, nightId: string): Promise<void> => {
  const sessions = await liveSessionsOf(tx, nightId)
  const mainIndex = pickMain(sessions)
  for (const [index, session] of sessions.entries()) {
    const main = index === mainIndex
    if (session.main === main) continue
    await tx.setProperty(session.id, mainProp, main)
    await tx.update(session.id, {content: sessionContent(session, main)})
  }
}

export interface ImportReport {
  nights: number
  created: number
  updated: number
  /** Nights whose transaction threw; the rest of the import went ahead. */
  failed: {date: string; error: string}[]
}

/** Every imported session onto its night, one transaction per night so a
 *  large export lands in bounded steps and a failure loses one night, not
 *  the batch — and is REPORTED, per night, rather than thrown over the
 *  nights already written. */
export const importSessions = async (
  repo: Repo,
  workspaceId: string,
  sessions: readonly ImportedSession[],
): Promise<ImportReport> => {
  const page = await getOrCreateLabPage(repo, workspaceId)
  const byNight = new Map<string, ImportedSession[]>()
  for (const session of sessions) {
    const date = wakeDateOf(session.end)
    byNight.set(date, [...(byNight.get(date) ?? []), session])
  }
  const report: ImportReport = {nights: 0, created: 0, updated: 0, failed: []}
  for (const [date, own] of [...byNight.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    try {
      // Counted after the transaction commits; a throw rolls the night back,
      // and its sessions must not show up as written.
      const counts = await repo.tx(async tx => {
        const typeSnapshot = repo.snapshotTypeRegistries()
        const nightId = await getOrCreateNightInTx(repo, tx, {workspaceId, pageId: page.id, date, typeSnapshot})
        // Judged BEFORE this import's sessions land: a flag set by hand is
        // kept; a flag the importer set is recomputed over the new set.
        const importerOwned = mainFlagsMatchHeuristic(await liveSessionsOf(tx, nightId))
        const counted = {created: 0, updated: 0}
        for (const session of own) {
          const {status} = await upsertSessionInTx(repo, tx, {workspaceId, nightId, session, typeSnapshot})
          counted[status] += 1
        }
        if (importerOwned) await settleMainInTx(tx, nightId)
        return counted
      }, {scope: ChangeScope.BlockDefault, description: `Import sleep for ${date}`})
      report.created += counts.created
      report.updated += counts.updated
      report.nights += 1
    } catch (error) {
      report.failed.push({date, error: error instanceof Error ? error.message : String(error)})
    }
  }
  return report
}
