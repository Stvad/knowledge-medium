/**
 * Reading the stored series back.
 *
 * Both recorders keep one block per session under
 * `user page → ui-state → <plugin type> → <client id>`, so a client's whole
 * history is the children of ONE block whose id is derivable. That matters for
 * cost: the obvious query — scan `blocks` for rows whose `properties_json`
 * carries the record property — is a `json_extract` over every block in the
 * workspace (hundreds of thousands of them), which is not something a monitor
 * gets to do, at idle or otherwise. Reading one parent's children is an index
 * hit whose cost is the number of sessions.
 *
 * The id is derived, never `ensure`d: a reader must not mint the subtree as a
 * side effect of finding out it is empty.
 */
import type { Repo } from '@/data/repo'
import { pluginUIStateBlockId, stateChildBlockId } from '@/data/stateBlocks.js'
import { deviceSurface, getClientId } from '@/utils/clientId.js'
import { jsonPathForProperty, type PropertyName } from '@/data/internals/typedBlockQuery.js'
import { clientSeriesQuery } from '@/plugins/interaction-metrics/recordStore.js'
import {
  interactionMetricsUIStateType,
  interactionRecordProp,
  type InteractionRecordData,
} from '@/plugins/interaction-metrics/record.js'
import {
  startupMetricsUIStateType,
  startupRecordProp,
  type StartupRecordData,
} from '@/plugins/startup-metrics/record.js'

// `Number.isFinite`, not `typeof === 'number'`: JSON has no Infinity literal but
// `1e400` parses as one, and these blobs are hand-editable. A non-finite p95
// reaching the recent window publishes an `Infinity×` regression; reaching the
// baseline suppresses a real one.
//
// NON-NEGATIVE as well, and for a reason finiteness does not cover. Every
// number in these records is a count or a duration, so a negative one is
// corrupt by construction — and the way it fails is silent: the comparison's
// magnitude floor is a `<` test, so a negative median lands under it and is
// reported STEADY. Corrupt rows would then contribute to a clean bill of
// health, which is the failure this whole feature exists to remove. The same
// rule covers the reversed startup marks below.
const isCount = (v: unknown): boolean => Number.isFinite(v) && (v as number) >= 0
const isAbsentOrCount = (v: unknown): boolean => v === undefined || isCount(v)

const isTimingSample = (v: unknown): boolean =>
  typeof v === 'object' && v !== null &&
  isCount((v as { calls?: unknown }).calls) &&
  isCount((v as { p95Ms?: unknown }).p95Ms)

/**
 * A validator must cover EVERY field a reader dereferences — the comparison and
 * the trend table both. These records are an opaque, deliberately
 * hand-inspectable blob, so any field can arrive with the wrong type, and the consequence is never a bad number: it is a throw
 * inside the analysis (dead for the rest of the session) or inside the dialog
 * render, rather than skipping one unreadable row. Adding a field to either
 * reader means adding it here — INCLUDING inside the nested query samples, since
 * a `queries` map of nulls passes a shallow check and throws later. */
export const isUsableInteractionRecord = (r: {
  queries?: unknown
  fanout?: unknown
  writes?: unknown
  blockCount?: unknown
  appSha?: unknown
}): boolean =>
  isAbsentOrString(r.appSha) &&
  isCount(r.writes) && isCount(r.blockCount) &&
  typeof r.queries === 'object' && r.queries !== null &&
  Object.values(r.queries as Record<string, unknown>).every(isTimingSample) &&
  typeof r.fanout === 'object' && r.fanout !== null &&
  // Counter VALUES too, not just the map: they are consumed as numbers, so a
  // string yields NaN (which takes neither branch) and a negative one yields a
  // negative rate (which takes the steady branch, silently).
  Object.values(r.fanout as Record<string, unknown>).every(isAbsentOrCount)

/** The trend table calls `.slice` on it, so a number or object throws during
 *  render and takes the whole dialog with it. */
const isAbsentOrString = (v: unknown): boolean => v === undefined || typeof v === 'string'

/** Marks stay OPTIONAL — a phase the session never reached is absent by design
 *  — but a mark that is PRESENT has to be a finite number. The comparison
 *  subtracts them, and a NaN takes neither the steady nor the regressed branch,
 *  so a single hand-edited row could publish `NaN× slower than baseline`.
 *
 *  ORDERED, too, when both marks of the compared pair are present. Paint cannot
 *  precede repo-ready, and a row saying it does yields a negative bootstrap gap
 *  — which is not merely a nonsense number in the dialog: a negative median
 *  falls under the comparison's absolute floor and is reported STEADY, so
 *  reversed rows contribute to a clean bill of health. Finiteness alone does not
 *  catch that, because both values are perfectly finite. */
export const isUsableStartupRecord = (r: {
  timeOriginMs?: unknown
  repoReadyMs?: unknown
  firstContentPaintMs?: unknown
  interactiveMs?: unknown
  appSha?: unknown
}): boolean =>
  isAbsentOrString(r.appSha) &&
  Number.isFinite(r.timeOriginMs) &&
  isAbsentOrCount(r.repoReadyMs) &&
  isAbsentOrCount(r.firstContentPaintMs) &&
  isAbsentOrCount(r.interactiveMs) &&
  // Only the pair the comparison SUBTRACTS. `interactiveMs` is stored for
  // someone reading a session by hand and no metric is derived from it, so a
  // rule about its ordering would be weight with no consumer.
  (typeof r.repoReadyMs !== 'number' || typeof r.firstContentPaintMs !== 'number' ||
    r.firstContentPaintMs >= r.repoReadyMs)

/** Sessions of history retained per comparison. Enough for the median to be
 *  stable across session heterogeneity, small enough that the baseline still
 *  tracks the current build rather than averaging over months of them. */
export const HISTORY_LIMIT = 40

/** Rows to consider before giving up on finding usable ones. Three times the
 *  window, so a group whose recent rows are unreadable still yields a full
 *  baseline, while a group full of them cannot turn this into a table scan. */
export const CANDIDATE_LIMIT = HISTORY_LIMIT * 3

/**
 * Everything it takes to read one recorder's series — named ONCE, here.
 *
 * The container type, the property name and the validator only ever travel
 * together, and a caller that spells them out is a caller that can spell one of
 * them wrong: passing a JSON path where the name belongs silently addresses a
 * property nothing writes, and the series then reads as empty rather than as
 * broken. Callers name the SERIES; nobody outside this module says which
 * property it lives in.
 */
export interface RecordSeries<T extends { recordedAt: number }> {
  /** Type of the hidden container this recorder's per-client groups live under. */
  typeId: string
  /** Name of the record property — never the JSON path. `PropertyName` is what
   *  makes that a compile error rather than a comment: an already-derived path
   *  is not assignable to it. The path is derived below from the same helper
   *  the writer uses, so reader and writer cannot address different keys. */
  recordName: PropertyName
  /** Whether a parsed row carries the fields this series is READ for. The
   *  record is an opaque blob that is deliberately hand-inspectable, so a
   *  hand-edited or future-shaped row can parse cleanly and still be missing
   *  what the comparison and the trend table dereference. */
  isUsable: (record: T) => boolean
  /** What "newest" MEANS for this series, when it is not the write time.
   *
   *  The SQL orders by `recordedAt`, which is when the row was persisted —
   *  correct for retention, whose job is to prune what arrived earliest, and
   *  correct for the interaction series, which is updated in place so its stamp
   *  IS its sample time. A startup record is written once, on a deferred and
   *  RETRYING schedule, so a slow boot can be persisted after a later fast one;
   *  ordering the comparison that way puts an older boot in the recent window
   *  and a newer one in the baseline, which can manufacture or hide a trend and
   *  attributes it to the wrong build chronology. Sorted after loading, so the
   *  pruner and the reader keep the one definition of the series and differ
   *  only in what they call recent — which is safe because retention keeps
   *  thousands and the reader reads tens. */
  recencyOf?: (record: T) => number
}

export const INTERACTION_SERIES: RecordSeries<InteractionRecordData> = {
  typeId: interactionMetricsUIStateType.id,
  recordName: interactionRecordProp.name,
  isUsable: isUsableInteractionRecord,
}

export const STARTUP_SERIES: RecordSeries<StartupRecordData> = {
  typeId: startupMetricsUIStateType.id,
  recordName: startupRecordProp.name,
  isUsable: isUsableStartupRecord,
  // Boot time, not write time — see `recencyOf`.
  recencyOf: (r) => r.timeOriginMs,
}

/** This client's group for one series. Derived, never `ensure`d — a reader must
 *  not mint the subtree as a side effect of finding out it is empty. */
const seriesGroupId = (repo: Repo, workspaceId: string, typeId: string): string =>
  stateChildBlockId(pluginUIStateBlockId(workspaceId, repo.user.id, typeId), getClientId())

/**
 * How many records this client has ON DISK for one series.
 *
 * Not `loadRecords(...).length`: that is capped at the comparison window, so a
 * count taken from it silently reports the cap — "40 sessions recorded so far"
 * for a client with four hundred. The two answer different questions, and the
 * only caller of this one is a progress note that means the disk.
 */
export const countRecords = async (
  repo: Repo,
  workspaceId: string,
  series: Pick<RecordSeries<{ recordedAt: number }>, 'typeId' | 'recordName'>,
): Promise<number> => {
  const q = clientSeriesQuery('COUNT(*) AS n', {
    groupId: seriesGroupId(repo, workspaceId, series.typeId),
    recordName: series.recordName,
    deviceSurface: deviceSurface(), clientId: getClientId(),
    tail: '',
  })
  const rows = await repo.db.getAll<{ n: number }>(q.sql, q.params)
  return rows[0]?.n ?? 0
}

/** This client's records for one recorder, newest first, each with the id of
 *  the block holding it — so a caller can identify a specific record (e.g. the
 *  one the current session owns) rather than relying on its position.
 *
 * `recordedAt` orders the result rather than `order_key`: the rows are written
 * newest-first, but an interaction record is UPDATED in place through its
 * session, so its position in the sibling order reflects when the session
 * started and its `recordedAt` reflects the sample. Sorting on the field the
 * comparison actually reads keeps those from disagreeing.
 */
/** Parse one row's payload, or null if it is unreadable or unusable.
 *
 *  `recordedAt` is checked here rather than in either validator because it
 *  orders the series: absent makes every comparison NaN and randomises the
 *  window; `Infinity` (which `1e400` parses to) sorts to the front. */
const parseRecord = <T extends { recordedAt: number }>(
  payload: string | null,
  isUsable: (record: T) => boolean,
): T | null => {
  if (!payload) return null
  try {
    const record = JSON.parse(payload) as T
    return Number.isFinite(record?.recordedAt) && isUsable(record) ? record : null
  } catch {
    // A record written by a future/older shape is skipped, not fatal: the
    // series is a diagnostic, and one unreadable row must not blind it.
    return null
  }
}

const scanSeries = async <T extends { recordedAt: number }>(
  repo: Repo,
  workspaceId: string,
  { typeId, recordName, isUsable, recencyOf }: RecordSeries<T>,
): Promise<Array<{ id: string; record: T }>> => {
  const recordPath = jsonPathForProperty(recordName)
  const groupId = seriesGroupId(repo, workspaceId, typeId)
  // ONE query, not a page walk. The candidate window is bounded and small, so
  // paging bought nothing and cost consistency: `OFFSET` over an order that
  // other tabs are mutating — a record is UPDATED in place, moving its
  // `recordedAt` — can read a row twice or skip it entirely, and the recorder
  // writes from a different idle job than this reader. A single read is one
  // snapshot, so neither can happen and the rows arrive already ordered.
  //
  // The limit is on ROWS while the window is on USABLE records, because
  // validation happens after the JSON parse: malformed or future-shaped rows at
  // the front would otherwise push valid history out of reach, and the monitor
  // would report an insufficient baseline while the group visibly holds
  // hundreds of good records.
  //
  // Built from `clientSeriesQuery` — the one definition of this client's
  // records — so the reader and the retention pass cannot disagree about which
  // rows are in the series or which of them is newest.
  const q = clientSeriesQuery('id, json_extract(properties_json, ?) AS payload', {
    groupId, recordName, deviceSurface: deviceSurface(), clientId: getClientId(),
    selectParams: [recordPath],
    tail: 'LIMIT ?', tailParams: [CANDIDATE_LIMIT],
  })
  const rows = await repo.db.getAll<{ id: string; payload: string | null }>(q.sql, q.params)
  const window: Array<{ id: string; record: T }> = []
  for (const row of rows) {
    // Stopping at the window rather than truncating afterwards. Over-long
    // history biases the baseline toward older, smaller-graph sessions, which
    // reads as a regression that never happened.
    if (window.length >= HISTORY_LIMIT) break
    const record = parseRecord<T>(row.payload, isUsable)
    if (record !== null) window.push({ id: row.id, record })
  }
  // Re-sorted, not re-queried: the SQL order decides which rows are CANDIDATES
  // (and agrees with the pruner about that), while this decides which of them
  // the comparison calls recent.
  return recencyOf === undefined
    ? window
    : [...window].sort((a, b) => recencyOf(b.record) - recencyOf(a.record))
}

/** This client's records for one recorder, newest first — the bounded window a
 *  comparison averages over. Callers that also need this session's own row use
 *  `loadSeriesWithCurrent`, which keeps the two apart. */
export const loadRecords = scanSeries

/**
 * The window, plus THIS session's own record — two answers, deliberately not
 * one list.
 *
 * `window` is the bounded history a comparison averages. `current` only says
 * that a sample for this session exists. Merging them puts the session into its
 * own baseline: everything past the recent window is history, so a current row
 * folded in both skews the average and can make four genuine samples look like
 * the five a verdict requires.
 *
 * The current row is a POINT LOOKUP, not a longer scan. It is addressed by its
 * own identity, so no candidate limit can hide it — which three successive
 * widenings of the window (the recent slice, then the history cap, then the
 * candidate cap) each failed to guarantee, because this client's other tabs go
 * on writing newer rows for as long as the page stays open and retention keeps
 * thousands. One extra bounded query on an idle path buys an answer that does
 * not depend on how far back the row happens to be.
 */
export const loadSeriesWithCurrent = async <T extends { recordedAt: number }>(
  repo: Repo,
  workspaceId: string,
  series: RecordSeries<T>,
  identity: { field: string; value: unknown },
): Promise<{ window: Array<{ id: string; record: T }>; current: T | null }> => {
  const [window, current] = await Promise.all([
    scanSeries(repo, workspaceId, series),
    findRecord(repo, workspaceId, series, identity),
  ])
  return { window, current }
}

/** The one record whose `field` holds `value`, or null. */
const findRecord = async <T extends { recordedAt: number }>(
  repo: Repo,
  workspaceId: string,
  { typeId, recordName, isUsable }: RecordSeries<T>,
  identity: { field: string; value: unknown },
): Promise<T | null> => {
  const q = clientSeriesQuery('json_extract(properties_json, ?) AS payload', {
    groupId: seriesGroupId(repo, workspaceId, typeId),
    recordName, deviceSurface: deviceSurface(), clientId: getClientId(),
    selectParams: [jsonPathForProperty(recordName)],
    matchField: identity,
    tail: 'LIMIT 1',
  })
  const rows = await repo.db.getAll<{ payload: string | null }>(q.sql, q.params)
  return parseRecord<T>(rows[0]?.payload ?? null, isUsable)
}
