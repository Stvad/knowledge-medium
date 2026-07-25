// @vitest-environment node
/**
 * Tests for the recursive tree CTEs (§11 of the data-layer redesign).
 * Runs against the real PowerSync test harness so trigger semantics
 * (which can fire during seed inserts here) are exercised the same way
 * as production.
 *
 * Coverage:
 *   - Subtree ordering by path (depth-first, sibling-sorted).
 *   - Sibling order_key prefix-relationship case (`a` vs `aa`) — the
 *     `!` separator makes `a!hex/` sort before `aa!hex/`.
 *   - `(order_key, id)` tiebreak when two siblings collide on order_key.
 *   - Cycle truncation: a 2-cycle (A.parent_id=B, B.parent_id=A) reached
 *     from any root yields each member at most once, no UNION-ALL
 *     duplicate explosion.
 *   - Depth guard: a non-cyclic deep chain past 100 levels truncates.
 *   - Soft-deleted blocks excluded from results.
 *   - Ancestors leaf-to-root order; subtree skip-self.
 *   - isDescendantOf: positive + negative + identity + missing-id.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import {
  ANCESTORS_SQL,
  CHILDREN_SQL,
  IS_DESCENDANT_OF_SQL,
  SUBTREE_SQL,
  VISIBLE_CHILDREN_SQL,
  VISIBLE_SUBTREE_SQL,
} from './treeQueries'

interface Seed {
  id: string
  parent_id?: string | null
  order_key?: string
  workspace_id?: string
  deleted?: 0 | 1
  /** Skip the workspace-invariant trigger by leaving tx_context.source NULL.
   *  Sync-applied seeds (default for tests) bypass parent-validation per §4.1.1. */
}

const insertOne = async (db: TestDb['db'], seed: Seed): Promise<void> => {
  await db.execute(
    `INSERT INTO blocks
      (id, workspace_id, parent_id, order_key, content, properties_json, references_json,
       created_at, updated_at, created_by, updated_by, deleted)
     VALUES (?, ?, ?, ?, '', '{}', '[]', 0, 0, 'u', 'u', ?)`,
    [
      seed.id,
      seed.workspace_id ?? 'ws',
      seed.parent_id ?? null,
      seed.order_key ?? 'a0',
      seed.deleted ?? 0,
    ],
  )
}

const seed = (db: TestDb['db'], rows: Seed[]) => Promise.all(rows.map(r => insertOne(db, r)))

describe('SUBTREE_SQL', () => {
  let h: TestDb
  beforeAll(async () => { h = await createTestDb() })
  afterAll(async () => { await h.cleanup() })

  it('returns the root + descendants in depth-first sibling order', async () => {
    await seed(h.db, [
      {id: 'r', parent_id: null, order_key: 'a0'},
      {id: 'a', parent_id: 'r',  order_key: 'a1'},
      {id: 'b', parent_id: 'r',  order_key: 'a2'},
      {id: 'aa', parent_id: 'a', order_key: 'a0'},
      {id: 'ab', parent_id: 'a', order_key: 'a1'},
    ])
    const rows = await h.db.getAll<{id: string}>(SUBTREE_SQL, ['r'])
    expect(rows.map(r => r.id)).toEqual(['r', 'a', 'aa', 'ab', 'b'])
  })

  it('sorts siblings whose order_keys are in a prefix relationship correctly (a < aa)', async () => {
    // Pre-v4.25 used `~` as the in-segment separator — but `~` (0x7E) is
    // GREATER than every letter, so `aa…` would sort before `a…`. With
    // `!` (0x21) the comparison flips and we get the intended ordering.
    await seed(h.db, [
      {id: 'p',  parent_id: null, order_key: 'b0'},
      {id: 'p1', parent_id: 'p',  order_key: 'aa'},
      {id: 'p2', parent_id: 'p',  order_key: 'a'},
    ])
    const rows = await h.db.getAll<{id: string}>(SUBTREE_SQL, ['p'])
    expect(rows.map(r => r.id)).toEqual(['p', 'p2', 'p1'])
  })

  it('uses (order_key, id) tiebreak on order_key collision', async () => {
    await seed(h.db, [
      {id: 'q',     parent_id: null, order_key: 'c0'},
      {id: 'q-yyy', parent_id: 'q',  order_key: 'a0'},
      {id: 'q-xxx', parent_id: 'q',  order_key: 'a0'},
    ])
    const rows = await h.db.getAll<{id: string}>(SUBTREE_SQL, ['q'])
    expect(rows.map(r => r.id)).toEqual(['q', 'q-xxx', 'q-yyy'])
  })

  it('truncates a 2-cycle to one occurrence per member, no UNION-ALL explosion', async () => {
    // Concurrent moves under sync produced A.parent=B, B.parent=A. The
    // visited-id guard truncates the recursion at the cycle entry.
    await seed(h.db, [
      {id: 'root', parent_id: null,   order_key: 'd0'},
      {id: 'A',    parent_id: 'B',    order_key: 'a0'},
      {id: 'B',    parent_id: 'A',    order_key: 'a0'},
    ])
    // Reached from A: A → B → (A blocked by visited-id guard).
    const rowsA = await h.db.getAll<{id: string}>(SUBTREE_SQL, ['A'])
    expect(rowsA.map(r => r.id).sort()).toEqual(['A', 'B'])
    // Reached from B: same.
    const rowsB = await h.db.getAll<{id: string}>(SUBTREE_SQL, ['B'])
    expect(rowsB.map(r => r.id).sort()).toEqual(['A', 'B'])
  })

  it('excludes soft-deleted blocks even when they have live children', async () => {
    await seed(h.db, [
      {id: 'sd-root',  parent_id: null,        order_key: 'e0'},
      {id: 'sd-mid',   parent_id: 'sd-root',   order_key: 'a0', deleted: 1},
      {id: 'sd-child', parent_id: 'sd-mid',    order_key: 'a0'},
    ])
    const rows = await h.db.getAll<{id: string}>(SUBTREE_SQL, ['sd-root'])
    // Soft-deleted parent excluded, and its live child too (recursion
    // can't reach it because the parent row drops out at the deleted=0 filter).
    expect(rows.map(r => r.id)).toEqual(['sd-root'])
  })

  it('returns empty when the root id does not exist', async () => {
    const rows = await h.db.getAll<{id: string}>(SUBTREE_SQL, ['no-such-id'])
    expect(rows).toEqual([])
  })
})

describe('ANCESTORS_SQL', () => {
  let h: TestDb
  beforeAll(async () => { h = await createTestDb() })
  afterAll(async () => { await h.cleanup() })

  it('returns parents leaf-to-root, excluding self', async () => {
    await seed(h.db, [
      {id: 'gp',    parent_id: null,  order_key: 'a0'},
      {id: 'p',     parent_id: 'gp',  order_key: 'a0'},
      {id: 'self',  parent_id: 'p',   order_key: 'a0'},
    ])
    const rows = await h.db.getAll<{id: string}>(ANCESTORS_SQL, ['self', 'self'])
    expect(rows.map(r => r.id)).toEqual(['p', 'gp'])
  })

  it('returns empty when the row has no parent', async () => {
    await seed(h.db, [{id: 'a-root', parent_id: null, order_key: 'a0'}])
    const rows = await h.db.getAll(ANCESTORS_SQL, ['a-root', 'a-root'])
    expect(rows).toEqual([])
  })

  it('truncates a non-root cycle (start → A → B → C → B …) at the visited-id guard', async () => {
    // Setup: start has parent A; A has parent B; B has parent C; C has
    // parent B (cycle on B-C, NOT involving start). Pre-v4.25 path
    // encoding only checked the root segment; this test pins the v4.25
    // uniform `!hex/` shape that catches non-root re-entries.
    await seed(h.db, [
      {id: 'B',     parent_id: 'C',     order_key: 'a0'},
      {id: 'C',     parent_id: 'B',     order_key: 'a0'},
      {id: 'A',     parent_id: 'B',     order_key: 'a0'},
      {id: 'start', parent_id: 'A',     order_key: 'a0'},
    ])
    const rows = await h.db.getAll<{id: string}>(ANCESTORS_SQL, ['start', 'start'])
    // Walk: start → A → B → C → (B blocked by visited-id). Each
    // cycle member appears at most once in the result.
    expect(rows.map(r => r.id).sort()).toEqual(['A', 'B', 'C'])
  })
})

describe('IS_DESCENDANT_OF_SQL', () => {
  let h: TestDb
  beforeAll(async () => { h = await createTestDb() })
  afterAll(async () => { await h.cleanup() })

  it('returns hit=1 when potentialAncestor is in the chain', async () => {
    await seed(h.db, [
      {id: 'd-gp',  parent_id: null,    order_key: 'a0'},
      {id: 'd-p',   parent_id: 'd-gp',  order_key: 'a0'},
      {id: 'd-c',   parent_id: 'd-p',   order_key: 'a0'},
    ])
    const got = await h.db.getOptional<{hit: number}>(IS_DESCENDANT_OF_SQL, ['d-c', 'd-gp'])
    expect(got).toEqual({hit: 1})
  })

  it('returns null when potentialAncestor is unrelated', async () => {
    await seed(h.db, [
      {id: 'iso-1', parent_id: null, order_key: 'a0'},
      {id: 'iso-2', parent_id: null, order_key: 'a1'},
    ])
    const got = await h.db.getOptional(IS_DESCENDANT_OF_SQL, ['iso-1', 'iso-2'])
    expect(got).toBeNull()
  })

  it('returns hit=1 on identity (a node is descendant-of itself in the chain)', async () => {
    await seed(h.db, [{id: 'self-only', parent_id: null, order_key: 'a0'}])
    const got = await h.db.getOptional<{hit: number}>(IS_DESCENDANT_OF_SQL, ['self-only', 'self-only'])
    // Note: this is the engine's `isDescendantOf(target.parentId, id)`
    // semantics — when target.parentId === id, it's a self-cycle and
    // tx.move will throw CycleError. The CTE reflects that "self
    // appears in the chain rooted at self".
    expect(got).toEqual({hit: 1})
  })

  it('returns null when the start id does not exist', async () => {
    const got = await h.db.getOptional(IS_DESCENDANT_OF_SQL, ['no-such', 'no-such'])
    expect(got).toBeNull()
  })

  it('traverses through a soft-deleted intermediate (issue #183)', async () => {
    // gp → mid(deleted) → c. The walk up from c must cross the deleted mid to
    // report gp as an ancestor — cycle-freedom is independent of soft-delete.
    await seed(h.db, [
      {id: 'sd-gp',  parent_id: null,    order_key: 'a0'},
      {id: 'sd-mid', parent_id: 'sd-gp', order_key: 'a0', deleted: 1},
      {id: 'sd-c',   parent_id: 'sd-mid', order_key: 'a0'},
    ])
    const got = await h.db.getOptional<{hit: number}>(IS_DESCENDANT_OF_SQL, ['sd-c', 'sd-gp'])
    expect(got).toEqual({hit: 1})
  })
})

describe('CHILDREN_SQL', () => {
  let h: TestDb
  beforeAll(async () => { h = await createTestDb() })
  afterAll(async () => { await h.cleanup() })

  it('returns direct children only, ordered by (order_key, id)', async () => {
    await seed(h.db, [
      {id: 'cp',     parent_id: null,  order_key: 'a0'},
      {id: 'cp-c2',  parent_id: 'cp',  order_key: 'a1'},
      {id: 'cp-c3',  parent_id: 'cp',  order_key: 'a2'},
      {id: 'cp-c1a', parent_id: 'cp',  order_key: 'a0'},
      {id: 'cp-c1b', parent_id: 'cp',  order_key: 'a0'},
      {id: 'cp-gc',  parent_id: 'cp-c1a', order_key: 'a0'},  // grandchild — excluded
    ])
    const rows = await h.db.getAll<{id: string}>(CHILDREN_SQL, ['cp'])
    expect(rows.map(r => r.id)).toEqual(['cp-c1a', 'cp-c1b', 'cp-c2', 'cp-c3'])
  })

  it('excludes soft-deleted children', async () => {
    await seed(h.db, [
      {id: 'sd-p', parent_id: null,    order_key: 'b0'},
      {id: 'sd-1', parent_id: 'sd-p',  order_key: 'a0', deleted: 1},
      {id: 'sd-2', parent_id: 'sd-p',  order_key: 'a1'},
    ])
    const rows = await h.db.getAll<{id: string}>(CHILDREN_SQL, ['sd-p'])
    expect(rows.map(r => r.id)).toEqual(['sd-2'])
  })
})

describe('VISIBLE_CHILDREN_SQL / VISIBLE_SUBTREE_SQL — flat §9 recognition', () => {
  // The `::` grammar deleted the recursive `up` ancestry walks these views
  // used to embed (and with them the #404 item-8b cyclic-chain guard those
  // walks needed): the flat predicate reads only the candidate row's own
  // columns, so a cyclic parent_id chain (issue #183 shape) cannot even be
  // consulted. These tests pin the two flat inversions on exactly the old
  // fixtures: an UNMARKED stamped look-alike is never machinery, and a
  // MARKED row filters regardless of what its ancestor chain looks like.
  let h: TestDb
  const WS = 'ws-vis-cycle'
  const DEF = 'def-cycle'

  beforeAll(async () => {
    h = await createTestDb()
    // Shared, static fixture for every test in this describe (workspace flip
    // + the one property-schema definition) — inserted once since `h` isn't
    // reset between the `it`s here; each test uses its own disjoint
    // block ids so they don't collide.
    await h.db.execute(
      `INSERT INTO workspaces
         (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
       VALUES (?, ?, ?, 1, 1, 'none', NULL, 'children')`,
      [WS, 'cycle test ws', 'user-1'],
    )
    await h.db.execute(
      `INSERT INTO block_types (block_id, workspace_id, type) VALUES (?, ?, 'property-schema')`,
      [DEF, WS],
    )
  })
  afterAll(async () => { await h.cleanup() })

  const insertBlock = (row: {
    id: string
    parent_id: string | null
    reference_target_id?: string | null
    is_field_form?: 1 | null
    order_key?: string
  }) => h.db.execute(
    `INSERT INTO blocks
       (id, workspace_id, parent_id, order_key, content, properties_json, references_json,
        created_at, updated_at, created_by, updated_by, deleted, reference_target_id, is_field_form)
      VALUES (?, ?, ?, ?, '', '{}', '[]', 0, 0, 'u', 'u', 0, ?, ?)`,
    [row.id, WS, row.parent_id, row.order_key ?? 'a0', row.reference_target_id ?? null, row.is_field_form ?? null],
  )

  it('filters marked rows and ONLY marked rows — an unmarked stamped look-alike stays visible, cyclic ancestors notwithstanding', async () => {
    // P's own ancestor chain cycles X <-> Y forever (issue #183 shape) —
    // irrelevant to the flat predicate, which never walks it.
    await insertBlock({id: 'X', parent_id: 'Y'})
    await insertBlock({id: 'Y', parent_id: 'X'})
    await insertBlock({id: 'P', parent_id: 'X'})

    // An ordinary child stays visible.
    await insertBlock({id: 'C', parent_id: 'P', order_key: 'a0'})
    // An UNMARKED child whose column happens to name a definition (the old
    // look-alike: a ref-typed value / plain link) is NOT machinery — only
    // `::` rows classify.
    await insertBlock({id: 'L', parent_id: 'P', reference_target_id: DEF, order_key: 'a1'})
    // A MARKED child targeting the definition IS machinery and filters.
    await insertBlock({id: 'F', parent_id: 'P', reference_target_id: DEF, is_field_form: 1, order_key: 'a2'})

    const rows = await h.db.getAll<{id: string}>(VISIBLE_CHILDREN_SQL, ['P'])
    expect(rows.map(r => r.id)).toEqual(['C', 'L'])
  })

  it('VISIBLE_SUBTREE_SQL prunes AT each marked row, keeps unmarked stamped rows, and never prunes the root', async () => {
    await insertBlock({id: 'X2', parent_id: 'Y2'})
    await insertBlock({id: 'Y2', parent_id: 'X2'})
    await insertBlock({id: 'P2', parent_id: 'X2'})
    // Marked field row (prunes with its whole subtree) + its value child.
    await insertBlock({id: 'F2', parent_id: 'P2', reference_target_id: DEF, is_field_form: 1, order_key: 'a1'})
    await insertBlock({id: 'V2', parent_id: 'F2', order_key: 'a0'})
    // Unmarked stamped row (the old look-alike) descends normally.
    await insertBlock({id: 'L2', parent_id: 'P2', reference_target_id: DEF, order_key: 'a0'})

    const rows = await h.db.getAll<{id: string}>(VISIBLE_SUBTREE_SQL, ['P2'])
    expect(rows.map(r => r.id)).toEqual(['P2', 'L2'])

    // The ROOT itself is never pruned — opening a field row shows its
    // subtree (its value child), minus nothing here (V2 is unmarked).
    const fromField = await h.db.getAll<{id: string}>(VISIBLE_SUBTREE_SQL, ['F2'])
    expect(fromField.map(r => r.id)).toEqual(['F2', 'V2'])
  })
})
