// @vitest-environment node
/**
 * Join-order guard for `SELECT_GROUPED_BACKLINK_CANDIDATES_SQL`.
 *
 * `refs` is constrained only by `workspace_id` in that statement, so
 * `idx_block_references_ws_alias` looks usable on its leading column; and a
 * recursive CTE carries no cardinality estimate to weigh against it. Left to
 * choose, SQLite drives from every edge in the workspace and builds a throwaway
 * index on the chain — the `AUTOMATIC COVERING INDEX` this test forbids —
 * instead of probing the `(source_id, …)` primary key once per chain row.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { SELECT_GROUPED_BACKLINK_CANDIDATES_SQL } from '../query'

const WS = 'ws-1'

// The inversion needs enough edges for the workspace column to look worth
// driving from. Measured: it reproduces from ~2k, so this is the cheap end of
// the range and not a number to trim without re-checking the mutation below.
const EDGES = 2000

let h: TestDb

beforeAll(async () => {
  h = await createTestDb()
  await h.db.writeTransaction(async tx => {
    for (let i = 0; i < EDGES; i++) {
      await tx.execute(
        `INSERT INTO block_references (source_id, target_id, workspace_id, alias, source_field)
         VALUES (?, ?, ?, ?, '')`,
        [`s-${i % 500}`, `t-${i}`, WS, `alias-${i % 97}`],
      )
    }
  })
  // The planner only consults index selectivity once stats exist; without this
  // it guesses uniformly and the inversion does not appear.
  await h.db.execute('ANALYZE')
}, 60_000)

afterAll(async () => { await h.cleanup() })

it('drives the candidates walk from the chain, not from every workspace edge', async () => {
  const plan = await h.db.getAll<{detail: string}>(
    `EXPLAIN QUERY PLAN ${SELECT_GROUPED_BACKLINK_CANDIDATES_SQL}`,
    [JSON.stringify(['s-1', 's-2', 's-3']), WS, 't-0'],
  )
  const details = plan.map(row => row.detail)
  // An automatic index over the chain is the signature of the inverted order:
  // it only pays to build one when the chain is the INNER side.
  expect(details.filter(d => /AUTOMATIC/.test(d) && /ancestor_chain/.test(d))).toEqual([])
}, 30_000)
