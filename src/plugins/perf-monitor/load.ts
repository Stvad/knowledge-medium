/**
 * Reading the stored series back. Both recorders keep one block per session
 * under `user page → ui-state → <plugin type> → <client id>`, so a client's
 * history is the children of ONE derivable-id block — an index hit, not a
 * `json_extract` scan over every block in the workspace. That id is derived,
 * never `ensure`d: a read must not mint the subtree by finding it empty.
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

// `Number.isFinite`, not `typeof === 'number'`: these blobs are hand-editable
// and a non-finite p95 skews the comparison silently. NON-NEGATIVE too — a
// negative value is corrupt by construction, and the `<` floor reports it
// STEADY rather than catching it; same rule for the startup marks below.
const isCount = (v: unknown): boolean => Number.isFinite(v) && (v as number) >= 0
const isAbsentOrCount = (v: unknown): boolean => v === undefined || isCount(v)

const isTimingSample = (v: unknown): boolean =>
  typeof v === 'object' && v !== null &&
  isCount((v as { calls?: unknown }).calls) &&
  isCount((v as { p95Ms?: unknown }).p95Ms)

/** A validator must cover EVERY field a reader dereferences — a missed check
 *  throws (analysis or dialog render) instead of skipping one bad row. Add a
 *  field to either reader here too, INCLUDING the nested `queries` samples. */
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

/** `.slice`d by the trend table — a number or object throws mid-render. */
const isAbsentOrString = (v: unknown): boolean => v === undefined || typeof v === 'string'

/** Marks stay OPTIONAL (absent if the session never reached that phase), but a
 *  PRESENT mark must be finite — NaN takes neither branch and could publish
 *  `NaN× slower`. ORDERED too: paint can't precede repo-ready, or the reversed
 *  gap gets reported STEADY by the comparison's floor instead of caught. */
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
 *  so unreadable recent rows don't starve the baseline without becoming a scan. */
export const CANDIDATE_LIMIT = HISTORY_LIMIT * 3

/** Everything it takes to read one recorder's series — named ONCE, here. Type,
 *  property name and validator only ever travel together; spelling them out
 *  separately risks reading an empty series instead of a broken one. Callers
 *  name the SERIES, never the property. */
export interface RecordSeries<T extends { recordedAt: number }> {
  /** Type of the hidden container this recorder's per-client groups live under. */
  typeId: string
  /** Name of the record property — never the JSON path. `PropertyName` makes
   *  that a compile error: an already-derived path isn't assignable to it. */
  recordName: PropertyName
  /** Whether a parsed row carries the fields this series is READ for — a
   *  hand-inspectable blob can parse cleanly and still miss them. */
  isUsable: (record: T) => boolean
  /** What "newest" MEANS, when it isn't write time — applied in SQL before
   *  the cap, so a late-persisted older boot can't displace a newer one, and
   *  read back by `rowTime` so a table can't order rows by one field and
   *  stamp them with another. */
  orderField?: keyof T & string
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

/** When a row HAPPENED — the field the series is ORDERED by, so anything
 *  displaying a timestamp beside a rank can't contradict it. Falls back to
 *  write time, which is what the ordering falls back to. */
export const rowTime = <T extends { recordedAt: number }>(
  series: Pick<RecordSeries<T>, 'orderField'>,
  record: T,
): number => {
  const field = series.orderField
  const value = field === undefined ? undefined : record[field]
  return typeof value === 'number' ? value : record.recordedAt
}

/** Derived, never `ensure`d — a read must not mint the subtree by looking. */
const seriesGroupId = (repo: Repo, workspaceId: string, typeId: string): string =>
  stateChildBlockId(pluginUIStateBlockId(workspaceId, repo.user.id, typeId), getClientId())

/** How many records this client has ON DISK for one series — NOT
 *  `loadRecords(...).length`, which is capped at the window and would
 *  silently report the cap ("40 recorded" for a client with 400). */
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

/** Parse one row's payload, or null if unreadable/unusable — `recordedAt` is
 *  checked here (not in either validator) since it orders the series and
 *  `Infinity` (from `1e400`) would otherwise sort first. */
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

/** This client's records for one series, newest first, each with the id of the
 *  block holding it — so a caller can name a record rather than rely on its
 *  position. Ordered by the series' own recency field, never `order_key`: an
 *  update-in-place record's sibling order reflects when its session STARTED,
 *  not when it was sampled. */
const scanSeries = async <T extends { recordedAt: number }>(
  repo: Repo,
  workspaceId: string,
  { typeId, recordName, isUsable, orderField }: RecordSeries<T>,
  /** Rows this window is not FOR — applied before the cap counts them, so
   *  excluding one shortens the scan rather than the window. */
  excluded: (row: { id: string; record: T }) => boolean = () => false,
): Promise<Array<{ id: string; record: T }>> => {
  const recordPath = jsonPathForProperty(recordName)
  const groupId = seriesGroupId(repo, workspaceId, typeId)
  // ONE query, not a page walk: `OFFSET` over an order other tabs keep
  // mutating (records UPDATE in place, moving `recordedAt`) can read a row
  // twice or skip it. LIMIT is on ROWS, the window on USABLE records — a
  // parse-time check, so bad rows up front mustn't push valid history out of
  // reach. Built from `clientSeriesQuery`, so the reader and retention pass
  // can't disagree about which rows are in the series or which is newest.
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
    if (record === null) continue
    const entry = { id: row.id, record }
    if (!excluded(entry)) window.push(entry)
  }
  return window
}

/** This client's records, newest first — the bounded window a comparison
 *  averages, optionally minus rows the caller is judging rather than averaging.
 *  For this session's own STORED row too, use `loadSeriesWithCurrent`. */
export const loadRecords = scanSeries

/**
 * The baseline window with THIS session's own row REMOVED, plus that row. A
 * session must not contribute to the history it is judged against: it both
 * inflates the count — letting four genuine samples pass for the five a
 * verdict requires — and pulls the median toward itself.
 *
 * Filtered here rather than left to the caller's slicing: other tabs writing
 * newer rows sink this one THROUGH the window, so it is neither reliably at
 * the front nor reliably past the cap. Before the cap, so the window still
 * holds a full `HISTORY_LIMIT` of past sessions rather than one short.
 *
 * `current` is a POINT LOOKUP by identity, not a wider scan: no candidate
 * limit can hide it, however far those other tabs may have pushed it.
 */
export const loadSeriesWithCurrent = async <T extends { recordedAt: number }>(
  repo: Repo,
  workspaceId: string,
  series: RecordSeries<T>,
  identity: { field: keyof T & string; value: unknown },
): Promise<{ window: Array<{ id: string; record: T }>; current: T | null }> => {
  const [window, current] = await Promise.all([
    scanSeries(repo, workspaceId, series,
      ({ record }) => record[identity.field] === identity.value),
    findRecord(repo, workspaceId, series, identity),
  ])
  return { window, current }
}

/** The one record whose `field` holds `value`, or null. */
const findRecord = async <T extends { recordedAt: number }>(
  repo: Repo,
  workspaceId: string,
  { typeId, recordName, isUsable, orderField }: RecordSeries<T>,
  identity: { field: keyof T & string; value: unknown },
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
