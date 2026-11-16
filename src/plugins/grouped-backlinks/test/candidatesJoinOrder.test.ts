// @vitest-environment node
/**
 * Join-order guards for the grouped-backlinks candidate statements, under a
 * large graph's planner stats.
 *
 * `SELECT_GROUPED_BACKLINK_CANDIDATES_SQL`: `refs` is constrained only by
 * `workspace_id`, and a recursive CTE carries no cardinality estimate, so left
 * free SQLite drives from every edge in the workspace and builds an automatic
 * index on the chain instead of probing the `(source_id, …)` primary key once
 * per chain row.
 *
 * `SELECT_GROUPED_BACKLINK_FIELD_CANDIDATES_SQL`: left free, SQLite drives
 * from the target's edges and rescans the source id list per edge.
 */
import { afterAll, beforeAll, it } from 'vitest'
import { createLargeGraphPlanner, type LargeGraphPlanner } from '@/data/test/largeGraphPlanner'
import { SELECT_GROUPED_BACKLINK_CANDIDATES_SQL, SELECT_GROUPED_BACKLINK_FIELD_CANDIDATES_SQL } from '../query'

const WS = 'ws-1'
const SOURCE_IDS = JSON.stringify(['s-1', 's-2', 's-3'])

let planner: LargeGraphPlanner
beforeAll(async () => { planner = await createLargeGraphPlanner() }, 30_000)
afterAll(async () => { await planner.cleanup() })

it('drives the candidates walk from the chain, not from every workspace edge', async () => {
  await planner.expectPinned({
    sql: SELECT_GROUPED_BACKLINK_CANDIDATES_SQL,
    params: [SOURCE_IDS, WS, 't-0', WS],
    pin: 'CROSS JOIN block_references refs ON refs.source_id = ancestor_chain.anc_id',
    unpinned: 'JOIN block_references refs ON refs.source_id = ancestor_chain.anc_id',
    check: plan => !plan.some(detail => /AUTOMATIC/.test(detail) && /ancestor_chain/.test(detail)),
  })
})

it('probes each source of the field candidates by the edge primary key', async () => {
  await planner.expectPinned({
    sql: SELECT_GROUPED_BACKLINK_FIELD_CANDIDATES_SQL,
    params: [SOURCE_IDS, WS, 't-0'],
    pin: 'CROSS JOIN block_references refs ON refs.source_id = s.id',
    unpinned: 'JOIN block_references refs ON refs.source_id = s.id',
    check: plan => plan.some(detail => /SEARCH refs USING .*sqlite_autoindex_block_references_1 \(source_id=\?/.test(detail)),
  })
})
