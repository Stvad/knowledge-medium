/**
 * Reading the stored series back.
 *
 * Both recorders keep one block per session under
 * `user page → ui-state → <plugin type> → <client id>`, so a client's whole
 * history is the children of ONE block whose id is derivable — reading them is
 * an index hit, not a `json_extract` scan over every block in the workspace.
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

// `Number.isFinite`, not `typeof === 'number'`: these blobs are hand-editable,
// and a non-finite p95 skews the comparison silently (an `Infinity×`
// regression, or a suppressed real one).
//
// NON-NEGATIVE too: a negative value is corrupt by construction, and the
// comparison's `<` floor reports it STEADY rather than catching it — the same
// rule covers the reversed startup marks below.
const isCount = (v: unknown): boolean => Number.isFinite(v) && (v as number) >= 0
const isAbsentOrCount = (v: unknown): boolean => v === undefined || isCount(v)

const isTimingSample = (v: unknown): boolean =>
  typeof v === 'object' && v !== null &&
  isCount((v as { calls?: unknown }).calls) &&
  isCount((v as { p95Ms?: unknown }).p95Ms)

/** A validator must cover EVERY field a reader dereferences (comparison and
 *  trend table both) — a missing check throws inside the analysis or the
 *  dialog render rather than skipping one bad row. Add a field to either
 *  reader here too, INCLUDING inside the nested `queries` samples. */
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
  // Counter VALUES too: a string yields NaN (neither branch), a negative one
  // yields a silently-steady rate.
  Object.values(r.fanout as Record<string, unknown>).every(isAbsentOrCount)

/** The trend table calls `.slice` on it, so a number or object throws during
 *  render and takes the whole dialog with it. */
const isAbsentOrString = (v: unknown): boolean => v === undefined || typeof v === 'string'

/** Marks stay OPTIONAL (a phase the session never reached is absent by
 *  design), but a PRESENT mark must be finite — a NaN takes neither the
 *  steady nor regressed branch and could publish `NaN× slower than baseline`.
 *
 *  ORDERED too, when both marks of a compared pair are present: paint cannot
 *  precede repo-ready, and a reversed pair yields a negative gap that the
 *  comparison's floor reports STEADY rather than catching. */
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
  // Only the pair the comparison SUBTRACTS — `interactiveMs` is for hand
  // reading only, so ordering it would be weight with no consumer.
  (typeof r.repoReadyMs !== 'number' || typeof r.firstContentPaintMs !== 'number' ||
    r.firstContentPaintMs >= r.repoReadyMs)

/** Sessions of history retained per comparison — enough for a stable median,
 *  small enough that the baseline still tracks the current build. */
export const HISTORY_LIMIT = 40

/** Rows to consider before giving up on usable ones — three times the window,
 *  so unreadable recent rows don't starve the baseline without this becoming a
 *  table scan. */
export const CANDIDATE_LIMIT = HISTORY_LIMIT * 3

/**
 * Everything it takes to read one recorder's series — named ONCE, here.
 *
 * Type, property name and validator only ever travel together; a caller that
 * spells them out separately can spell one wrong and silently read an empty
 * series instead of a broken one. Callers name the SERIES, never the property.
 */
export interface RecordSeries<T extends { recordedAt: number }> {
  /** Type of the hidden container this recorder's per-client groups live under. */
  typeId: string
  /** Name of the record property — never the JSON path. `PropertyName` makes
   *  that a compile error: an already-derived path isn't assignable to it. */
  recordName: PropertyName
  /** Whether a parsed row carries the fields this series is READ for — these
   *  records are hand-inspectable blobs that can parse cleanly and still miss
   *  them. */
  isUsable: (record: T) => boolean
  /** What "newest" MEANS for this series, when it isn't write time — see
   *  `clientSeriesQuery`'s `orderField`. Applied in the SQL, before the cap:
   *  sorting after would let a late-persisted older boot displace a newer one. */
  orderField?: string
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
  // Boot time, not write time — see `orderField`.
  orderField: 'timeOriginMs',
}

/** This client's group for one series — derived, never `ensure`d, so a read
 *  cannot mint the subtree as a side effect of finding it empty. */
const seriesGroupId = (repo: Repo, workspaceId: string, typeId: string): string =>
  stateChildBlockId(pluginUIStateBlockId(workspaceId, repo.user.id, typeId), getClientId())

/**
 * How many records this client has ON DISK for one series — NOT
 * `loadRecords(...).length`, which is capped at the comparison window and
 * would silently report the cap ("40 recorded" for a client with 400).
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

/** Records carry the id of the block holding them, so a caller can identify a
 *  specific record rather than relying on position.
 *
 *  Sorted by `recordedAt`, not `order_key`: an interaction record is UPDATED
 *  in place through its session, so sibling order reflects when the session
 *  STARTED while `recordedAt` reflects the sample — sorting on the field the
 *  comparison reads keeps the two from disagreeing. */
/** Parse one row's payload, or null if unreadable or unusable.
 *
 *  `recordedAt` is checked here, not in either validator, because it orders
 *  the series: absent makes comparisons NaN; `Infinity` (from `1e400`) sorts
 *  first. */
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
  { typeId, recordName, isUsable, orderField }: RecordSeries<T>,
): Promise<Array<{ id: string; record: T }>> => {
  const recordPath = jsonPathForProperty(recordName)
  const groupId = seriesGroupId(repo, workspaceId, typeId)
  // ONE query, not a page walk: `OFFSET` over an order other tabs keep
  // mutating (a record is UPDATED in place, moving its `recordedAt`) can read
  // a row twice or skip it — a single read is one snapshot, so neither can
  // happen.
  //
  // The limit is on ROWS, the window on USABLE records: validation happens
  // after the JSON parse, so unreadable rows at the front must not push valid
  // history out of reach.
  //
  // Built from `clientSeriesQuery` so the reader and the retention pass can't
  // disagree about which rows are in the series or which is newest.
  const q = clientSeriesQuery('id, json_extract(properties_json, ?) AS payload', {
    groupId, recordName, orderField, deviceSurface: deviceSurface(), clientId: getClientId(),
    selectParams: [recordPath],
    tail: 'LIMIT ?', tailParams: [CANDIDATE_LIMIT],
  })
  const rows = await repo.db.getAll<{ id: string; payload: string | null }>(q.sql, q.params)
  const window: Array<{ id: string; record: T }> = []
  for (const row of rows) {
    // Stop at the window rather than truncate after: over-long history biases
    // the baseline toward older, smaller-graph sessions — a false regression.
    if (window.length >= HISTORY_LIMIT) break
    const record = parseRecord<T>(row.payload, isUsable)
    if (record !== null) window.push({ id: row.id, record })
  }
  return window
}

/** This client's records for one recorder, newest first — the bounded window a
 *  comparison averages over. Callers that also need this session's own row use
 *  `loadSeriesWithCurrent`, which keeps the two apart. */
export const loadRecords = scanSeries

/**
 * The window, plus THIS session's own record — two answers, not one list.
 *
 * `window` is the bounded history a comparison averages; `current` only says a
 * sample for this session exists. Merging them would fold the session into its
 * own baseline, skewing the average and letting four genuine samples pass for
 * the five a verdict requires.
 *
 * `current` is a POINT LOOKUP by identity, not a wider scan: no candidate
 * limit can hide it, however far back other tabs still writing may have
 * pushed the row.
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
  { typeId, recordName, isUsable, orderField }: RecordSeries<T>,
  identity: { field: string; value: unknown },
): Promise<T | null> => {
  const q = clientSeriesQuery('json_extract(properties_json, ?) AS payload', {
    groupId: seriesGroupId(repo, workspaceId, typeId),
    recordName, orderField, deviceSurface: deviceSurface(), clientId: getClientId(),
    selectParams: [jsonPathForProperty(recordName)],
    matchField: identity,
    tail: 'LIMIT 1',
  })
  const rows = await repo.db.getAll<{ payload: string | null }>(q.sql, q.params)
  return parseRecord<T>(rows[0]?.payload ?? null, isUsable)
}
