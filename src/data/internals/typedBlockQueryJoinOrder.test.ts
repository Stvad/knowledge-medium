// @vitest-environment node
/**
 * Join-order guard for the typed-query compiler's `ancestor_chain` seed.
 *
 * Left to choose, SQLite seeds the chain by scanning every live block and
 * probing an automatic index over the candidates — at any table size, with or
 * without ANALYZE — a cost that grows with the workspace rather than with the
 * candidate set. `CROSS JOIN` pins the order.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { compileTypedBlockQuery } from './typedBlockQuery'

interface PlanRow { id: number; parent: number; detail: string }

let h: TestDb

beforeAll(async () => { h = await createTestDb() })
afterAll(async () => { await h.cleanup() })

/** The two loops of the chain's seed step, outer then inner. */
const ancestorSeedLoops = (plan: readonly PlanRow[]): string[] => {
  const chain = plan.find(row => /^(CO-ROUTINE|MATERIALIZE) ancestor_chain$/.test(row.detail))
  const setup = chain && plan.find(row => row.parent === chain.id && row.detail === 'SETUP')
  return setup ? plan.filter(row => row.parent === setup.id).map(row => row.detail) : []
}

it('seeds the ancestor chain from the candidates, probing blocks by primary key', async () => {
  const compiled = compileTypedBlockQuery({
    workspaceId: 'ws-1',
    referencedBy: {id: 'target'},
    exclude: [{scope: 'ancestor', referencedBy: {id: 'excluded'}}],
    order: 'created-desc',
  }, {properties: new Map()}, {projection: 'ids'})
  const plan = await h.db.getAll<PlanRow>(`EXPLAIN QUERY PLAN ${compiled.sql}`, [...compiled.params])
  const [outer, inner, ...rest] = ancestorSeedLoops(plan)
  expect(rest).toEqual([])
  expect(outer).toMatch(/^SCAN \w+$/)
  expect(inner).toMatch(/^SEARCH \w+ USING INDEX sqlite_autoindex_blocks_1 \(id=\?\)$/)
})

