// @vitest-environment node
/**
 * Plan guards for the recents queries. Both defects these pin are invisible in
 * the results — a scan returns exactly what an index-served plan returns, just
 * a thousand times slower on a real graph — so the assertions read the plan.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import {
  SELECT_RECENT_BLOCKS_SQL,
  SELECT_RECENT_USER_BLOCKS_SQL,
  recentUserBlocksParams,
} from './kernelQueries'

let h: TestDb

beforeAll(async () => { h = await createTestDb() })
afterAll(async () => { await h.cleanup() })

const planOf = async (sql: string, params: unknown[]): Promise<string[]> => {
  const rows = await h.db.getAll<{detail: string}>(
    `EXPLAIN QUERY PLAN ${sql}`, params as never[],
  )
  return rows.map(row => row.detail)
}

const userParams = () => recentUserBlocksParams(['root-a', 'root-b'], 'ws-1', 12)

it('walks the state tree through an index, not a scan per iteration', async () => {
  // The walk must include tombstones, and the only `parent_id`-leading indexes
  // are partial (`deleted = 0` / `deleted = 1`). A recursive step that proves
  // neither predicate gets no index and scans `blocks` once per iteration.
  const details = await planOf(SELECT_RECENT_USER_BLOCKS_SQL, userParams())

  // `b` is the recursive step's alias for `blocks`. A bare SCAN of it is the
  // whole defect; which index serves it is the planner's business.
  expect(details.filter(detail => /^SCAN b\b/.test(detail))).toEqual([])
  expect(details.some(detail => /SEARCH b\b.*\(parent_id=\?\)/.test(detail))).toBe(true)
})

// The outer statement of both queries. Ordering by `coalesce(user_updated_at,
// updated_at)` is what no ordinary index expresses, so without
// `idx_blocks_workspace_recent` SQLite has to read every live row of the
// workspace and sort the lot before it can honour the LIMIT — and the per-row
// tests `recentUserBlocks` layers on top are then paid once per row in the
// graph. Serving the sort from the index is what lets it stop early instead.
for (const [name, sql, params] of [
  ['core.recentBlocks', SELECT_RECENT_BLOCKS_SQL, ['ws-1', 12]],
  ['core.recentUserBlocks / core.recentActivity', SELECT_RECENT_USER_BLOCKS_SQL, userParams()],
] as const) {
  it(`pages ${name} through the recency index, without sorting the workspace`, async () => {
    const details = await planOf(sql, params as unknown[])

    expect(details.some(detail =>
      /^SEARCH blocks USING INDEX idx_blocks_workspace_recent \(workspace_id=\?\)/.test(detail),
    )).toBe(true)
    // Both halves of the ORDER BY, tiebreak included: an index without the
    // per-column `DESC`/`ASC` still leaves `USE TEMP B-TREE FOR LAST TERM OF
    // ORDER BY` behind, and an unindexed sort key leaves the full form.
    expect(details.filter(detail => /TEMP B-TREE FOR .*ORDER BY/.test(detail))).toEqual([])
  })
}
