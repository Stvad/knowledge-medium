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

/** JSON paths of the two record properties. A property name carrying a colon
 *  (the namespace separator) must be QUOTED inside the path expression, which
 *  is why these are written once here rather than assembled from a name at each
 *  call site. */
export const INTERACTION_RECORD_PATH = '$."interaction-metrics:record"'
export const STARTUP_RECORD_PATH = '$.startupRecord'

/** The fields every reader of an interaction record dereferences. */
export const isUsableInteractionRecord = (r: {
  queries?: unknown
  fanout?: unknown
  writes?: unknown
  blockCount?: unknown
}): boolean =>
  typeof r.queries === 'object' && r.queries !== null &&
  typeof r.fanout === 'object' && r.fanout !== null &&
  typeof r.writes === 'number' && typeof r.blockCount === 'number'

/** A startup record is read only for its marks, and every one of them is
 *  optional by design (a phase the session never reached is absent), so
 *  `recordedAt` plus a boot identity is all a reader can require. */
export const isUsableStartupRecord = (r: { timeOriginMs?: unknown }): boolean =>
  typeof r.timeOriginMs === 'number'

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
  const rows = await repo.db.getAll<{ id: string; payload: string | null }>(
    // The payload filter is INSIDE the query, before the LIMIT. Records are
    // prepended, so a row carrying no record sits at the FRONT of this window —
    // filtering in JS afterwards would let such rows consume the whole window
    // and return nothing while the group visibly holds hundreds of records.
    `SELECT id, json_extract(properties_json, ?) AS payload
       FROM blocks
      WHERE parent_id = ? AND deleted = 0
        AND json_extract(properties_json, ?) IS NOT NULL
      ORDER BY order_key
      LIMIT ?`,
    [recordPath, groupId, recordPath, HISTORY_LIMIT],
  )
  const records: Array<{ id: string; record: T }> = []
  for (const row of rows) {
    if (!row.payload) continue
    try {
      const record = JSON.parse(row.payload) as T
      // A missing `recordedAt` makes every sort comparison NaN, which
      // randomises the whole window rather than merely misplacing one row.
      if (typeof record?.recordedAt === 'number' && isUsable(record)) {
        records.push({ id: row.id, record })
      }
    } catch {
      // A record written by a future/older shape is skipped, not fatal: the
      // series is a diagnostic, and one unreadable row must not blind it.
    }
  }
  return records.sort((a, b) => b.record.recordedAt - a.record.recordedAt)
}
