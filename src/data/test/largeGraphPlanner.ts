/**
 * A test database whose planner sees a large graph: the `sqlite_stat1` shape
 * (row counts only) of a ~1.1M-block workspace with ~660k reference edges,
 * and no `sqlite_stat4` samples, as on the shipped wa-sqlite build. Join-order
 * inversions that only appear at that size plan here the way they do on a
 * real graph; ANALYZE over a small fixture does not reproduce them.
 *
 * Plans run on the connection that loaded the stats: `ANALYZE sqlite_schema`
 * reloads only its own connection, and `db.getAll` may plan on a reader that
 * still holds the fixture's stats.
 */

import { expect } from 'vitest'
import { createTestDb, type TestDb } from './createTestDb'

/** Every index on `blocks`, `block_references` and `block_types`. A missing
 *  row makes the planner fall back to default estimates for that index. */
export const LARGE_GRAPH_STATS: ReadonlyArray<readonly [string, string, string]> = [
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

const STATS_TABLES = ['blocks', 'block_references', 'block_types'] as const

export interface LargeGraphPlanner {
  /** `EXPLAIN QUERY PLAN` details, in plan order. */
  plan: (sql: string, params: readonly unknown[]) => Promise<string[]>
  /** Asserts `check` holds for `sql`'s plan, and fails for the plan of `sql`
   *  with `pin` replaced by `unpinned`: proof that these stats still produce
   *  the inversion the pin prevents, so a passing check is not vacuous. */
  expectPinned: (args: {
    sql: string
    params: readonly unknown[]
    pin: string
    unpinned: string
    check: (plan: readonly string[]) => boolean
  }) => Promise<void>
  cleanup: () => Promise<void>
}

/** One `sqlite_stat1` row's replacement, keyed by its table and index. */
export type StatOverride = readonly [tbl: string, idx: string, stat: string]

/** `overrides` replaces individual {@link LARGE_GRAPH_STATS} rows, e.g. to plan
 *  under stats that are stale against the graph's real size. */
export const createLargeGraphPlanner = async (
  {overrides = []}: {overrides?: readonly StatOverride[]} = {},
): Promise<LargeGraphPlanner> => {
  const h: TestDb = await createTestDb()
  // Creates the stats tables; their rows are then replaced.
  await h.db.execute('ANALYZE')
  const indexes = await h.db.getAll<{tbl_name: string; name: string}>(
    `SELECT tbl_name, name FROM sqlite_schema WHERE type = 'index' AND tbl_name IN (${STATS_TABLES.map(() => '?').join(', ')})`,
    [...STATS_TABLES],
  )
  expect(indexes.map(row => `${row.tbl_name} ${row.name}`).sort())
    .toEqual(LARGE_GRAPH_STATS.map(([tbl, idx]) => `${tbl} ${idx}`).sort())
  for (const [tbl, idx] of overrides) {
    expect(LARGE_GRAPH_STATS.some(([t, i]) => t === tbl && i === idx), `override for an unknown index ${tbl} ${idx}`).toBe(true)
  }
  const hasStat4 = (await h.db.getAll(`SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_stat4'`)).length > 0
  await h.db.writeTransaction(async tx => {
    await tx.execute('DELETE FROM sqlite_stat1')
    if (hasStat4) await tx.execute('DELETE FROM sqlite_stat4')
    for (const [tbl, idx, stat] of LARGE_GRAPH_STATS) {
      const override = overrides.find(([t, i]) => t === tbl && i === idx)
      await tx.execute('INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES (?, ?, ?)', [tbl, idx, override?.[2] ?? stat])
    }
  })

  const plan = (sql: string, params: readonly unknown[]): Promise<string[]> =>
    h.db.writeTransaction(async tx => {
      await tx.execute('ANALYZE sqlite_schema')
      return (await tx.getAll<{detail: string}>(`EXPLAIN QUERY PLAN ${sql}`, [...params])).map(row => row.detail)
    })

  const expectPinned: LargeGraphPlanner['expectPinned'] = async ({sql, params, pin, unpinned, check}) => {
    const loose = sql.replace(pin, unpinned)
    expect(loose, 'the pin text must occur in the statement').not.toBe(sql)
    const pinnedPlan = await plan(sql, params)
    expect(check(pinnedPlan), `pinned plan:\n${pinnedPlan.join('\n')}`).toBe(true)
    const loosePlan = await plan(loose, params)
    expect(check(loosePlan), `unpinned plan should fail the check:\n${loosePlan.join('\n')}`).toBe(false)
  }

  return {plan, expectPinned, cleanup: () => h.cleanup()}
}
