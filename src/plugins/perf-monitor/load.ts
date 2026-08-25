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
import { getClientId } from '@/utils/clientId.js'

/** Each series' JSON path comes from the module that owns its property, so a
 *  rename cannot leave the reader addressing a name nothing writes. */
export { INTERACTION_RECORD_PATH } from '@/plugins/interaction-metrics/record.js'
export { STARTUP_RECORD_PATH } from '@/plugins/startup-metrics/record.js'

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
  typeof r.timeOriginMs === 'number' &&
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
  typeId: string,
  /** JSON path of the record property, e.g. `$.startupRecord`. Passed whole
   *  rather than assembled from a name so escaping never becomes this
   *  function's problem — property names may carry colons. */
  recordPath: string,
  /** Whether a parsed row carries the fields this series is READ for. The
   *  record is an opaque blob that is deliberately hand-inspectable, so a
   *  hand-edited or future-shaped row can parse cleanly and still be missing
   *  what the comparison and the trend table dereference. */
  isUsable: (record: T) => boolean,
): Promise<Array<{ id: string; record: T }>> => {
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
  for (let page = 0; page < MAX_PAGES && records.length < HISTORY_LIMIT; page++) {
    const rows = await repo.db.getAll<{ id: string; payload: string | null }>(
      // The payload filter is INSIDE the query, before the LIMIT: records are
      // prepended, so a row carrying no record sits at the FRONT of this window.
      //
      // Ordered by the RECORD's own timestamp, not by tree position. A session's
      // record is updated in place, so a long-lived tab's row stays where it was
      // created while becoming the most recent sample — and paging by
      // `order_key` then sorting afterwards cannot recover a row the paging
      // already excluded. `(order_key, id)` only breaks ties, in the tree's
      // canonical order.
      `SELECT id, json_extract(properties_json, ?) AS payload
         FROM blocks
        WHERE parent_id = ? AND deleted = 0
          AND json_extract(properties_json, ?) IS NOT NULL
        ORDER BY json_extract(properties_json, ?) DESC, order_key, id
        LIMIT ? OFFSET ?`,
      [recordPath, groupId, recordPath, `${recordPath}.recordedAt`,
       HISTORY_LIMIT, page * HISTORY_LIMIT],
    )
    for (const row of rows) {
      if (!row.payload) continue
      try {
        const record = JSON.parse(row.payload) as T
        // `recordedAt` drives the sort, so it is checked here rather than in
        // either series' validator. Absent makes every comparison NaN and
        // randomises the whole window; `Infinity` (which `1e400` parses to)
        // sorts to the front and pushes this boot out of the currency window.
        if (Number.isFinite(record?.recordedAt) && isUsable(record)) {
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
  // Re-sorted rather than trusted: the query orders on a value SQLite reads
  // untyped, so a hand-edited string timestamp sorts by JSON type rather than
  // numerically. The rows are already the right ones by then — this only fixes
  // their order.
  return records
    .sort((a, b) => b.record.recordedAt - a.record.recordedAt)
    .slice(0, HISTORY_LIMIT)
}
