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
import { getClientId, getDeviceLabel } from '@/utils/clientId.js'
import { jsonPathForProperty } from '@/data/internals/typedBlockQuery.js'
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
const isTimingSample = (v: unknown): boolean =>
  typeof v === 'object' && v !== null &&
  Number.isFinite((v as { calls?: unknown }).calls) &&
  Number.isFinite((v as { p95Ms?: unknown }).p95Ms)

/**
 * A validator must cover EVERY field a reader dereferences — the comparison and
 * the trend table both — not just the ones a past bug named. These records are
 * an opaque, deliberately hand-inspectable blob, so any field can arrive with
 * the wrong type, and the consequence is never a bad number: it is a throw
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
  Number.isFinite(r.writes) && Number.isFinite(r.blockCount) &&
  typeof r.queries === 'object' && r.queries !== null &&
  Object.values(r.queries as Record<string, unknown>).every(isTimingSample) &&
  typeof r.fanout === 'object' && r.fanout !== null &&
  // Counter VALUES too, not just the map: they are consumed as numbers, and a
  // string yields NaN, which takes neither the steady nor the regressed branch.
  Object.values(r.fanout as Record<string, unknown>).every(
    (v) => v === undefined || Number.isFinite(v),
  )

const isAbsentOrFinite = (v: unknown): boolean => v === undefined || Number.isFinite(v)
/** The trend table calls `.slice` on it, so a number or object throws during
 *  render and takes the whole dialog with it. */
const isAbsentOrString = (v: unknown): boolean => v === undefined || typeof v === 'string'

/** Marks stay OPTIONAL — a phase the session never reached is absent by design
 *  — but a mark that is PRESENT has to be a finite number. The comparison
 *  subtracts them, and a NaN takes neither the steady nor the regressed branch,
 *  so a single hand-edited row could publish `NaN× slower than baseline`. */
export const isUsableStartupRecord = (r: {
  timeOriginMs?: unknown
  repoReadyMs?: unknown
  firstContentPaintMs?: unknown
  interactiveMs?: unknown
  appSha?: unknown
}): boolean =>
  isAbsentOrString(r.appSha) &&
  Number.isFinite(r.timeOriginMs) &&
  isAbsentOrFinite(r.repoReadyMs) &&
  isAbsentOrFinite(r.firstContentPaintMs) &&
  isAbsentOrFinite(r.interactiveMs)

/** Pages of `HISTORY_LIMIT` rows to read before giving up on finding usable
 *  records. Bounds the cost when a group is full of unreadable rows. */
export const MAX_PAGES = 3

/** Sessions of history retained per comparison. Enough for the median to be
 *  stable across session heterogeneity, small enough that the baseline still
 *  tracks the current build rather than averaging over months of them. */
export const HISTORY_LIMIT = 40

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
  /** Name of the record property — never the JSON path, which is derived below
   *  from the same helper the writer uses, so reader and writer cannot address
   *  different keys. */
  recordName: string
  /** Whether a parsed row carries the fields this series is READ for. The
   *  record is an opaque blob that is deliberately hand-inspectable, so a
   *  hand-edited or future-shaped row can parse cleanly and still be missing
   *  what the comparison and the trend table dereference. */
  isUsable: (record: T) => boolean
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
export const loadRecords = async <T extends { recordedAt: number }>(
  repo: Repo,
  workspaceId: string,
  { typeId, recordName, isUsable }: RecordSeries<T>,
): Promise<Array<{ id: string; record: T }>> => {
  const recordPath = jsonPathForProperty(recordName)
  const groupId = stateChildBlockId(
    pluginUIStateBlockId(workspaceId, repo.user.id, typeId),
    getClientId(),
  )
  // Paged until HISTORY_LIMIT USABLE records are collected, not until that many
  // rows are read. Validation happens after JSON parse, so a limit applied to
  // rows lets malformed or future-shaped ones at the front of the window push
  // valid history out of reach — and the monitor then reports an insufficient
  // baseline while the group visibly holds hundreds of good records. Bounded by
  // MAX_PAGES so a group full of unreadable rows cannot turn into a full scan.
  const records: Array<{ id: string; record: T }> = []
  const seen = new Set<string>()
  for (let page = 0; page < MAX_PAGES && records.length < HISTORY_LIMIT; page++) {
    // Built from `clientSeriesQuery` — the one definition of this client's
    // records — so the reader and the retention pass cannot disagree about
    // which rows are in the series or which of them is newest. They have
    // diverged twice, and each time retention was free to evict a row this
    // reader counted as current.
    const q = clientSeriesQuery('id, json_extract(properties_json, ?) AS payload', {
      groupId, recordName, deviceLabel: getDeviceLabel(),
      selectParams: [recordPath],
      tail: 'LIMIT ? OFFSET ?', tailParams: [HISTORY_LIMIT, page * HISTORY_LIMIT],
    })
    const rows = await repo.db.getAll<{ id: string; payload: string | null }>(q.sql, q.params)
    for (const row of rows) {
      if (!row.payload) continue
      // Paging is by OFFSET, so a record PREPENDED between two page reads shifts
      // the window and the row at the old page boundary is read twice — and the
      // recorder appends from a different idle job than this one. A duplicate
      // would count one past session twice in the median.
      if (seen.has(row.id)) continue
      try {
        const record = JSON.parse(row.payload) as T
        // `recordedAt` drives the sort, so it is checked here rather than in
        // either series' validator. Absent makes every comparison NaN and
        // randomises the whole window; `Infinity` (which `1e400` parses to)
        // sorts to the front and pushes this boot out of the currency window.
        if (Number.isFinite(record?.recordedAt) && isUsable(record)) {
          seen.add(row.id)
          records.push({ id: row.id, record })
        }
      } catch {
        // A record written by a future/older shape is skipped, not fatal: the
        // series is a diagnostic, and one unreadable row must not blind it.
      }
    }
    if (rows.length < HISTORY_LIMIT) break
  }
  // Truncated, not merely loop-bounded: the page condition is checked BEFORE
  // each page, so a page that ends one short of the limit runs another and can
  // return nearly twice it. Over-long history biases the baseline toward older,
  // smaller-graph sessions, which reads as a regression.
  //
  // Re-sorted because the result is CONCATENATED from up to `MAX_PAGES` reads
  // that are not one snapshot: an append landing between two of them shifts the
  // window, so page 1 can carry a row newer than the tail of page 0. Not, as an
  // earlier note here claimed, to repair a hand-edited string timestamp — the
  // `Number.isFinite` check above drops those before they reach this line.
  return records
    .sort((a, b) => b.record.recordedAt - a.record.recordedAt)
    .slice(0, HISTORY_LIMIT)
}
