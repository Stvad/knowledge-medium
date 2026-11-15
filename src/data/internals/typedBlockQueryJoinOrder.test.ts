// @vitest-environment node
/**
 * Join-order guard for the typed-query compiler's `ancestor_chain` seed.
 *
 * `candidates` is materialized when an ancestor-scoped predicate reads it a
 * second time, and a materialized CTE carries no cardinality estimate. Left to
 * choose, SQLite seeds the chain by scanning every live block
 * (`idx_blocks_parent_order` covers `id, parent_id` under `deleted = 0`) and
 * probing an automatic index over the candidates — a cost that grows with the
 * workspace, not with the handful of candidates.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { compileTypedBlockQuery } from './typedBlockQuery'

const WS = 'ws-1'
const TARGET = 'target'

// Enough live blocks for a scan of them to look cheaper than it is.
const BLOCKS = 2000

let h: TestDb

beforeAll(async () => {
  h = await createTestDb()
  await h.db.writeTransaction(async tx => {
    for (let i = 0; i < BLOCKS; i++) {
      await tx.execute(
        `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, created_at, updated_at, created_by, updated_by)
         VALUES (?, ?, ?, ?, '', 0, 0, 'u', 'u')`,
        [`b-${i}`, WS, i < 20 ? null : `b-${i % 20}`, `a${i}`],
      )
    }
    for (let i = 0; i < 5; i++) {
      await tx.execute(
        `INSERT INTO block_references (source_id, target_id, workspace_id, alias, source_field)
         VALUES (?, ?, ?, ?, '')`,
        [`b-${100 + i}`, TARGET, WS, TARGET],
      )
    }
  })
  // The planner only consults index selectivity once stats exist.
  await h.db.execute('ANALYZE')
}, 60_000)

afterAll(async () => { await h.cleanup() })

it('seeds the ancestor chain from the candidates, not from every live block', async () => {
  const compiled = compileTypedBlockQuery({
    workspaceId: WS,
    referencedBy: {id: TARGET},
    exclude: [{scope: 'ancestor', referencedBy: {id: 'excluded'}}],
    order: 'created-desc',
  }, new Map(), {projection: 'ids'})
  const plan = await h.db.getAll<{detail: string}>(
    `EXPLAIN QUERY PLAN ${compiled.sql}`, [...compiled.params],
  )
  const details = plan.map(row => row.detail)
  expect(details.filter(d => /^SCAN seed\b/.test(d) || (/AUTOMATIC/.test(d) && /\bc\b/.test(d)))).toEqual([])
}, 30_000)
