// @vitest-environment node
/**
 * Join-order guard for the scope walk's anchor step (`COVERED_CTE` in
 * scope.ts): covered → edge by `idx_block_references_target`, never an
 * automatic index, under a large graph's planner stats.
 */
import {afterAll, beforeAll, it} from 'vitest'
import {createLargeGraphPlanner, type LargeGraphPlanner} from '@/data/test/largeGraphPlanner'
import {COMMENTS_RECIPE_SQL, THREAD_IDS_IN_SCOPE_SQL} from './scope'

let planner: LargeGraphPlanner
beforeAll(async () => { planner = await createLargeGraphPlanner() }, 30_000)
afterAll(async () => { await planner.cleanup() })

const probesTargetEdges = (plan: readonly string[]): boolean =>
  !plan.some(detail => /AUTOMATIC/.test(detail))
  && plan.some(detail => /SEARCH edge USING .*INDEX idx_block_references_target \(target_id=\?/.test(detail))

it.each([
  ['threadIdsInScope', THREAD_IDS_IN_SCOPE_SQL, ['scope']],
  ['the comments recipe', COMMENTS_RECIPE_SQL, ['scope', '["target"]']],
] as const)('%s finds anchored threads through the target edge index', async (_name, sql, params) => {
  await planner.expectPinned({
    sql,
    params,
    pin: 'CROSS JOIN block_references edge',
    unpinned: 'JOIN block_references edge',
    check: probesTargetEdges,
  })
})
