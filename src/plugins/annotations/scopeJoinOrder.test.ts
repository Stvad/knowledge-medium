// @vitest-environment node
/**
 * Join-order guard for the scope walk (`COVERED_CTE` in scope.ts).
 *
 * The anchor step joins `covered` → `block_references` → `blocks root`. A
 * recursive CTE carries no cardinality estimate, and on a large graph the
 * planner prefers to drive from `root`, building an automatic index over
 * every live block, then probing the edge primary key: a full pass over the
 * blocks table for each covered row. The stats below are a large graph's
 * shape (row counts only); ANALYZE on a small fixture gives a different plan
 * and does not reproduce the inversion.
 */
import {afterAll, beforeAll, expect, it} from 'vitest'
import {createTestDb, type TestDb} from '@/data/test/createTestDb'
import {COMMENTS_RECIPE_SQL, THREAD_IDS_IN_SCOPE_SQL} from './scope'

const LARGE_GRAPH_STATS: ReadonlyArray<readonly [string, string, string]> = [
  ['block_references', 'idx_block_references_target', '663498 23 23'],
  ['block_references', 'idx_block_references_ws_alias', '663498 132700 20'],
  ['block_references', 'sqlite_autoindex_block_references_1', '663498 2 1 1 1'],
  ['block_types', 'idx_block_types_type_workspace', '69003 1015 406'],
  ['block_types', 'sqlite_autoindex_block_types_1', '69003 2 1'],
  ['blocks', 'idx_blocks_any_field_form', '382820 127607 4'],
  ['blocks', 'idx_blocks_being_edited', '10 1'],
  ['blocks', 'idx_blocks_daily_note_date', '4321 1'],
  ['blocks', 'idx_blocks_field_form', '382581 127527 4 1'],
  ['blocks', 'idx_blocks_parent_deleted', '25328 8 1 1'],
  ['blocks', 'idx_blocks_parent_order', '1135193 3 1 1'],
  ['blocks', 'idx_blocks_reference_candidates', '47945 9589 5328'],
  ['blocks', 'idx_blocks_reference_target_parent', '448796 89760 35 1'],
  ['blocks', 'idx_blocks_workspace_active', '1135193 227039'],
  ['blocks', 'idx_blocks_workspace_nonempty_properties', '112695 22539 1'],
  ['blocks', 'idx_blocks_workspace_recent', '1126701 225341 5 1'],
  ['blocks', 'idx_blocks_workspace_with_references', '547554 109511'],
  ['blocks', 'sqlite_autoindex_blocks_1', '1160521 1'],
]

let h: TestDb

beforeAll(async () => {
  h = await createTestDb()
  // Creates sqlite_stat1; its rows are then replaced with the large shape.
  await h.db.execute('ANALYZE')
  await h.db.writeTransaction(async tx => {
    await tx.execute('DELETE FROM sqlite_stat1')
    for (const [tbl, idx, stat] of LARGE_GRAPH_STATS) {
      await tx.execute('INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES (?, ?, ?)', [tbl, idx, stat])
    }
  })
}, 30_000)

afterAll(async () => { await h.cleanup() })

/** On the write connection, which is the one whose stats were just replaced:
 *  `ANALYZE sqlite_schema` reloads them for its own connection only. */
const planOf = async (sql: string, params: unknown[]): Promise<string[]> =>
  h.db.writeTransaction(async tx => {
    await tx.execute('ANALYZE sqlite_schema')
    return (await tx.getAll<{detail: string}>(`EXPLAIN QUERY PLAN ${sql}`, params)).map(row => row.detail)
  })

it.each([
  ['threadIdsInScope', THREAD_IDS_IN_SCOPE_SQL, ['scope']],
  ['the comments recipe', COMMENTS_RECIPE_SQL, ['scope', '[]']],
] as const)('%s finds anchored threads through the target edge index', async (_name, sql, params) => {
  const plan = await planOf(sql, [...params])
  expect(plan.filter(detail => /AUTOMATIC/.test(detail))).toEqual([])
  expect(plan.some(detail => /SEARCH edge USING .*INDEX idx_block_references_target \(target_id=\?/.test(detail))).toBe(true)
})
