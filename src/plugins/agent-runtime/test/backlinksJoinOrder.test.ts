// @vitest-environment node
/**
 * Join-order guard for the backlinks view's "via" lookup
 * (`SOURCE_FIELDS_FOR_SOURCES_SQL`): the page's ids stay outer and each
 * probes the edge primary key, under a large graph's planner stats.
 */
import {afterAll, beforeAll, it} from 'vitest'
import {createLargeGraphPlanner, type LargeGraphPlanner} from '@/data/test/largeGraphPlanner'
import {SOURCE_FIELDS_FOR_SOURCES_SQL} from '../agentViews/backlinks'

let planner: LargeGraphPlanner
beforeAll(async () => { planner = await createLargeGraphPlanner() }, 30_000)
afterAll(async () => { await planner.cleanup() })

it('probes each listed source by the edge primary key', async () => {
  await planner.expectPinned({
    sql: SOURCE_FIELDS_FOR_SOURCES_SQL,
    params: [JSON.stringify(['s-1', 's-2', 's-3']), 'ws', 'target', 3],
    pin: 'CROSS JOIN block_references r',
    unpinned: 'JOIN block_references r',
    check: plan => plan.some(detail => /SEARCH r USING .*sqlite_autoindex_block_references_1 \(source_id=\?/.test(detail)),
  })
})
