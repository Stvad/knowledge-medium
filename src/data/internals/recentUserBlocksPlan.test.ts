// @vitest-environment node
/**
 * Index guard for the user-state descent in `SELECT_RECENT_USER_BLOCKS_SQL`.
 *
 * The walk must include tombstones, and the only `parent_id`-leading indexes
 * are partial (`deleted = 0` / `deleted = 1`). A recursive step that proves
 * neither predicate gets no index and scans `blocks` once per iteration — a
 * plan this query's own results cannot be told apart from a fast one, which
 * is why the guard reads the plan instead.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { SELECT_RECENT_USER_BLOCKS_SQL, recentUserBlocksParams } from './kernelQueries'

let h: TestDb

beforeAll(async () => { h = await createTestDb() })
afterAll(async () => { await h.cleanup() })

it('walks the state tree through an index, not a scan per iteration', async () => {
  const plan = await h.db.getAll<{detail: string}>(
    `EXPLAIN QUERY PLAN ${SELECT_RECENT_USER_BLOCKS_SQL}`,
    recentUserBlocksParams(['root-a', 'root-b'], 'ws-1', 12) as never[],
  )
  const details = plan.map(row => row.detail)

  // `b` is the recursive step's alias for `blocks`. A bare SCAN of it is the
  // whole defect; which index serves it is the planner's business.
  expect(details.filter(detail => /^SCAN b\b/.test(detail))).toEqual([])
  expect(details.some(detail => /SEARCH b\b.*\(parent_id=\?\)/.test(detail))).toBe(true)
})
