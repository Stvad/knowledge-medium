/**
 * Recursive CTEs for tree operations against the v2 blocks schema (§11
 * of the data-layer redesign). Two guards on every recursion:
 *
 *   1. `depth < 100` — defensive cap. Catches pathological non-cycle
 *      deep trees and is the safety net if the visited-id guard fails.
 *
 *   2. `INSTR(path, '!' || hex(id) || '/') = 0` — visited-id check via
 *      path-INSTR. Skips any row whose id already appears in the
 *      recursion path-so-far. **Without this guard, UNION ALL would
 *      re-emit cycle members on every loop iteration**, exploding the
 *      result. With it, each block appears at most once.
 *
 * Path encoding: `!hex(id)/` segments separated by `<order_key>`.
 *   - `hex()` makes the path lexically safe regardless of id format
 *     (block ids may contain `/`; e.g. deterministic `daily/<ws>/<date>`).
 *   - `!` (0x21) is the in-segment separator: lexicographically less
 *     than every char in any order_key alphabet (digits, lowercase
 *     letters, `_`) AND every uppercase hex char (`0-9A-F`). This is
 *     what makes `ORDER BY path` produce correct sibling ordering when
 *     one order_key is a prefix of another (e.g. keys `a` and `aa` —
 *     comparing position-by-position, `a == a`, then `!` < `a` →
 *     `a!hex1/` sorts before `aa!hex2/`).
 *   - Trailing `/` per segment makes the visited-id INSTR match
 *     unambiguous (`!hex/` is found only as a complete segment, never
 *     as a prefix of a longer hex).
 *
 * Path is internal to the CTE; consumers ignore it.
 */

/** Returns the rooted subtree, ordered by path (i.e. depth-first, with
 *  siblings sorted by `(order_key, id)` via the path encoding). Filters
 *  `deleted = 0`.
 *
 *  The `INDEXED BY` on the recursive join is load-bearing: SQLite has no
 *  cardinality estimate for a recursive CTE, so whether it uses
 *  `idx_blocks_parent_order` or builds a transient AUTOMATIC index over
 *  every live row — O(table) per execution, ~190ms on a 117k-row DB even
 *  for a 3-row subtree — is a per-database coin flip decided by whatever
 *  `sqlite_stat1` happens to hold (a fresh ANALYZE does not reliably fix
 *  it). The hint pins the good plan; it errors at prepare time if the
 *  index is ever renamed or dropped, which is the loud failure we want.
 *  The query's own `deleted = 0` filter satisfies the partial-index
 *  predicate. See docs/subtree-cte-planner-perf.html. */
export const SUBTREE_SQL = `
  WITH RECURSIVE subtree AS (
    SELECT *,
           '!' || hex(id) || '/' AS path,
           0 AS depth
      FROM blocks
     WHERE id = ? AND deleted = 0
    UNION ALL
    SELECT child.*,
           subtree.path || child.order_key || '!' || hex(child.id) || '/',
           subtree.depth + 1
      FROM subtree
      JOIN blocks AS child INDEXED BY idx_blocks_parent_order
        ON child.parent_id = subtree.id
     WHERE child.deleted = 0
       AND subtree.depth < 100
       AND INSTR(subtree.path, '!' || hex(child.id) || '/') = 0
  )
  SELECT * FROM subtree ORDER BY path
`

/** Returns the leaf-to-root chain, excluding the start id. Filters
 *  `deleted = 0`. */
export const ANCESTORS_SQL = `
  WITH RECURSIVE chain AS (
    SELECT *,
           '!' || hex(id) || '/' AS path,
           0 AS depth
      FROM blocks
     WHERE id = ? AND deleted = 0
    UNION ALL
    SELECT parent.*,
           chain.path || '!' || hex(parent.id) || '/',
           chain.depth + 1
      FROM chain
      JOIN blocks AS parent ON parent.id = chain.parent_id
     WHERE parent.deleted = 0
       AND chain.depth < 100
       AND INSTR(chain.path, '!' || hex(parent.id) || '/') = 0
  )
  SELECT * FROM chain WHERE id != ? ORDER BY depth ASC
`

/** Many-id variant of `ANCESTORS_SQL` — runs the recursive walk for
 *  every seed id in one statement, tagging each row with the seed it
 *  belongs to. Used by `core.manyAncestors` to avoid N round-trips
 *  when a backlinks panel needs the parent chain for every visible
 *  source block.
 *
 *  Caller supplies `idCount` `?` placeholders bound to the seed ids;
 *  ordering of the input array is not preserved in the result, so
 *  consumers must group by `chain_start_id` themselves. Each chain is
 *  returned leaf-to-root (ascending `depth`) so it matches the
 *  single-id `ANCESTORS_SQL` shape exactly. */
export const manyAncestorsSql = (idCount: number): string => {
  if (idCount <= 0) throw new Error('manyAncestorsSql: idCount must be >= 1')
  const placeholders = Array(idCount).fill('?').join(', ')
  return `
    WITH RECURSIVE chain AS (
      SELECT blocks.*,
             blocks.id AS chain_start_id,
             '!' || hex(blocks.id) || '/' AS path,
             0 AS depth
        FROM blocks
       WHERE blocks.id IN (${placeholders}) AND blocks.deleted = 0
      UNION ALL
      SELECT parent.*,
             chain.chain_start_id,
             chain.path || '!' || hex(parent.id) || '/',
             chain.depth + 1
        FROM chain
        JOIN blocks AS parent ON parent.id = chain.parent_id
       WHERE parent.deleted = 0
         AND chain.depth < 100
         AND INSTR(chain.path, '!' || hex(parent.id) || '/') = 0
    )
    SELECT * FROM chain
    WHERE chain.id != chain.chain_start_id
    ORDER BY chain.chain_start_id, chain.depth ASC
  `
}

/** Existence check: is :potentialAncestor an ancestor of :id?
 *  Used by `tx.move`'s cycle-validation: would the new parent be a
 *  descendant of `id`? Parameter order in the SQL: `?, ?` for
 *  `(id, potentialAncestor)`.
 *
 *  Deliberately does NOT filter `deleted = 0`: cycle-freedom is a
 *  structural invariant of `parent_id` that is independent of
 *  soft-delete. A soft-deleted node on the ancestor chain still forms a
 *  real edge — stopping the walk at it would let `move()` create a
 *  durable structural cycle that becomes a live cycle once the deleted
 *  node is restored (see issue #183). */
export const IS_DESCENDANT_OF_SQL = `
  WITH RECURSIVE chain AS (
    SELECT id, parent_id,
           '!' || hex(id) || '/' AS path,
           0 AS depth
      FROM blocks
     WHERE id = ?
    UNION ALL
    SELECT b.id, b.parent_id,
           chain.path || '!' || hex(b.id) || '/',
           chain.depth + 1
      FROM blocks AS b
      JOIN chain ON chain.parent_id = b.id
     WHERE chain.depth < 100
       AND INSTR(chain.path, '!' || hex(b.id) || '/') = 0
  )
  SELECT 1 AS hit FROM chain WHERE id = ? LIMIT 1
`

/** Bounded scan over a set of affected ids — for each id, walks up
 *  parent_id and, if its chain closes onto itself, reports every id
 *  visited along that closing chain (i.e. every member of the cycle
 *  the input id is part of). Used by the row_events tail to surface
 *  sync-introduced cycles (§4.7 detection-only telemetry).
 *
 *  Parameter shape: pass `idCount` `?` placeholders bound to the ids
 *  to scan. Caller is responsible for matching the count.
 *
 *  Why report every cycle member, not just the input id that closed:
 *  drains can split per-row when sync-applied writes arrive in
 *  separate `db.onChange` ticks. For a 2-cycle A↔B introduced by two
 *  sync writes (A.parent←B, then B.parent←A), the drain that sees
 *  the first write scans `idList=[A]` against pre-second-write state
 *  and finds nothing; only the second drain (idList=[B], post-both-
 *  writes) sees the cycle. Reporting just `start_id` would emit
 *  `[B]` and lose A. Reporting the full cycle (`[A, B]`) gives
 *  consumers a complete view from any single drain that catches the
 *  closure, regardless of which member's mutation triggered the
 *  drain. The column alias stays `start_id` so the surface caller
 *  reads (`hits.map(h => h.start_id)`) is unchanged.
 *
 *  Why scoped to affected ids (not all blocks): cycle scans are O(n)
 *  per starting row and we don't need to find every cycle in the DB
 *  — only the ones the just-applied sync writes might have closed.
 *
 *  Why no `deleted = 0` filter: a cycle is a structural property of
 *  `parent_id` regardless of soft-delete. A soft-deleted node on the
 *  closing chain still forms a real edge, and filtering it out would
 *  leave the same blind spot that let the cycle through `move()` in the
 *  first place (issue #183). The detector must see the full structure. */
export const cycleScanSql = (idCount: number): string => {
  if (idCount <= 0) throw new Error('cycleScanSql: idCount must be >= 1')
  const placeholders = Array(idCount).fill('?').join(',')
  return `
    WITH RECURSIVE chain(start_id, id, parent_id, depth) AS (
      SELECT id, id, parent_id, 0
        FROM blocks
       WHERE id IN (${placeholders})
      UNION ALL
      SELECT chain.start_id, b.id, b.parent_id, chain.depth + 1
        FROM chain
        JOIN blocks AS b ON b.id = chain.parent_id
       WHERE chain.depth < 100
    ),
    cyclic AS (
      SELECT DISTINCT start_id FROM chain WHERE depth > 0 AND id = start_id
    )
    SELECT DISTINCT chain.id AS start_id
      FROM chain
      JOIN cyclic ON cyclic.start_id = chain.start_id
  `
}

/** Direct children of a parent, ordered `(order_key, id)`, filtered
 *  `deleted = 0`. Machinery form: property field rows INCLUDED — copy,
 *  export, delete-cascade, and the property-children processors must see
 *  them (PR #288 §9). */
export const CHILDREN_SQL = `
  SELECT * FROM blocks
   WHERE parent_id = ? AND deleted = 0
   ORDER BY order_key, id
`

/** Same as CHILDREN_SQL but returns only `id` — for the child-id-only
 *  handle (`repo.childIds`) which doesn't need to hydrate the full row
 *  and only declares structural deps (`parent-edge`). Machinery form:
 *  field rows included. */
export const CHILDREN_IDS_SQL = `
  SELECT id FROM blocks
   WHERE parent_id = ? AND deleted = 0
   ORDER BY order_key, id
`

/**
 * VISIBLE-children predicate (PR #288 §9, slice B1): in a child-backed
 * workspace the outline's default child listing excludes recognized
 * property field rows — a child whose local `reference_target_id` names a
 * definition block, when the workspace's `properties_migration` is at or
 * past 'children' (never an equality test) and the PARENT itself is
 * ordinary content (role is positional: everything beneath a field row is
 * property-subtree interior — values, comments — so listings there never
 * filter; a ref-typed VALUE pointing at a definition block would otherwise
 * be misread as a nested field).
 *
 * The row template binds nothing; the recursion template consumes ONE `?`
 * (the parent id) for the §9 ancestry rule. Callers therefore bind
 * `[parentId, parentId]` for the visible variants below.
 *
 * Definition-ness binds to the `block_types` side index (`type =
 * 'property-schema'`, SAME workspace — a foreign workspace's definition id
 * must degrade to a visible "unknown field" row per §9, exactly as the
 * tx-layer registry checker resolves it): every definition block —
 * user-authored and materialized seed alike — carries that type. DIVERGENCE from the
 * tx-layer checker (which asks the registry and so recognizes a seeded
 * definition with zero rows): a not-yet-materialized seed's field rows are
 * invisible to this SQL — acceptable because the slice-C flip runbook
 * materializes seeds before any workspace flips, and un-flipped workspaces
 * never reach the predicate at all.
 *
 * An un-flipped workspace short-circuits on the `workspaces` probe
 * (dormant: today's behavior, zero rows filtered).
 *
 * The inner `up` walk carries the same `path` visited-guard as the
 * descendant CTEs above (issue #404 item 8b) — without it a cyclic
 * `parent_id` chain (see issue #183; classification still converges
 * because the walk terminates on the `depth < 100` cap either way, but
 * a cyclic DB would otherwise spin every one of those 100 steps instead
 * of stopping the moment it revisits a row).
 */
const VISIBLE_CHILD_PREDICATE_SQL = `
   AND (
     blocks.reference_target_id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM workspaces w
        WHERE w.id = blocks.workspace_id
          AND w.properties_migration IN ('children', 'cell-off')
     )
     OR NOT EXISTS (
       SELECT 1 FROM block_types bt
        WHERE bt.block_id = blocks.reference_target_id
          AND bt.type = 'property-schema'
          AND bt.workspace_id = blocks.workspace_id
     )
     OR EXISTS (
       WITH RECURSIVE up(id, reference_target_id, parent_id, workspace_id, path, depth) AS (
         SELECT id, reference_target_id, parent_id, workspace_id,
                '!' || hex(id) || '/',
                0
           FROM blocks WHERE id = ?
         UNION ALL
         SELECT b.id, b.reference_target_id, b.parent_id, b.workspace_id,
                up.path || '!' || hex(b.id) || '/',
                up.depth + 1
           FROM blocks AS b
           JOIN up ON b.id = up.parent_id
          WHERE up.depth < 100
            AND INSTR(up.path, '!' || hex(b.id) || '/') = 0
       )
       SELECT 1 FROM up
        WHERE up.reference_target_id IS NOT NULL
          -- §9 root half: a workspace-root row is never a field row, so it
          -- never makes its descendants "interior" (twin of the parentId
          -- check in isPropertyFieldInstance).
          AND up.parent_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM block_types bt2
             WHERE bt2.block_id = up.reference_target_id
               AND bt2.type = 'property-schema'
               AND bt2.workspace_id = up.workspace_id
          )
        LIMIT 1
     )
   )
`

/** Outline form of {@link CHILDREN_SQL}: excludes recognized field rows in
 *  a flipped workspace. Bind `[parentId, parentId]`. */
export const VISIBLE_CHILDREN_SQL = `
  SELECT * FROM blocks
   WHERE parent_id = ? AND deleted = 0
${VISIBLE_CHILD_PREDICATE_SQL}
   ORDER BY order_key, id
`

/** Outline form of {@link CHILDREN_IDS_SQL}. Bind `[parentId, parentId]`. */
export const VISIBLE_CHILDREN_IDS_SQL = `
  SELECT id FROM blocks
   WHERE parent_id = ? AND deleted = 0
${VISIBLE_CHILD_PREDICATE_SQL}
   ORDER BY order_key, id
`

/**
 * VISIBLE-subtree form of {@link SUBTREE_SQL} (PR #288 §9, slice C gap fix):
 * a flipped workspace's hidden property field/value machinery must not leak
 * into subtree consumers (panels, copy, navigation, shortcuts) any more than
 * it leaks into the outline. The recursive descent refuses to step INTO a
 * recognized field-row child — same recognition predicate as
 * {@link VISIBLE_CHILD_PREDICATE_SQL} (flip probe on the child's workspace +
 * a workspace-scoped `block_types = 'property-schema'` probe on the child's
 * `reference_target_id`). Pruning happens AT the field row, so its entire
 * subtree (value child, comments, everything) is excluded in one step —
 * no per-descendant interior re-check is needed once a branch is pruned.
 *
 * Root exemptions, evaluated ONCE for the root id via `root_exempt` (a
 * scalar CTE wrapping the same `up`-ancestry-walk pattern
 * VISIBLE_CHILD_PREDICATE_SQL uses, just seeded at the root instead of a
 * parent): if the ROOT itself is a recognized field row, or the root is
 * interior (some strict ancestor of the root is a recognized field row),
 * the raw subtree is returned unfiltered. Both cases are "the caller
 * explicitly asked for property-subtree content" — §9 guarantees nothing
 * below a field row is ever itself another field row, so a stamped
 * ref-typed VALUE row further down a property subtree must never be
 * pruned. `root_exempt` is OR'd into the recursive descend condition so it
 * short-circuits the rest of the predicate once true.
 *
 * Bind `[rootId, rootId]` — one for the `root_exempt` ancestry seed, one
 * for the `subtree` seed (same convention as `[parentId, parentId]` on the
 * VISIBLE_CHILDREN_* pair above). Same selected columns + depth semantics
 * as SUBTREE_SQL; the `INDEXED BY` planner-pin note there applies here too.
 *
 * An un-flipped workspace short-circuits on the `workspaces` probe exactly
 * like VISIBLE_CHILD_PREDICATE_SQL (dormant: zero rows pruned).
 */
export const VISIBLE_SUBTREE_SQL = `
  WITH RECURSIVE
  root_exempt(v) AS (
    SELECT CASE WHEN EXISTS (
      WITH RECURSIVE up(id, reference_target_id, parent_id, workspace_id, path, depth) AS (
        SELECT id, reference_target_id, parent_id, workspace_id,
               '!' || hex(id) || '/',
               0
          FROM blocks WHERE id = ?
        UNION ALL
        SELECT b.id, b.reference_target_id, b.parent_id, b.workspace_id,
               up.path || '!' || hex(b.id) || '/',
               up.depth + 1
          FROM blocks AS b
          JOIN up ON b.id = up.parent_id
         WHERE up.depth < 100
           AND INSTR(up.path, '!' || hex(b.id) || '/') = 0
      )
      SELECT 1 FROM up
       WHERE up.reference_target_id IS NOT NULL
         -- §9 root half: a workspace-root row is never a field row (twin
         -- of the parentId check in isPropertyFieldInstance).
         AND up.parent_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM workspaces w
            WHERE w.id = up.workspace_id
              AND w.properties_migration IN ('children', 'cell-off')
         )
         AND EXISTS (
           SELECT 1 FROM block_types bt
            WHERE bt.block_id = up.reference_target_id
              AND bt.type = 'property-schema'
              AND bt.workspace_id = up.workspace_id
         )
       LIMIT 1
    ) THEN 1 ELSE 0 END
  ),
  subtree AS (
    SELECT *,
           '!' || hex(id) || '/' AS path,
           0 AS depth
      FROM blocks
     WHERE id = ? AND deleted = 0
    UNION ALL
    SELECT child.*,
           subtree.path || child.order_key || '!' || hex(child.id) || '/',
           subtree.depth + 1
      FROM subtree
      JOIN blocks AS child INDEXED BY idx_blocks_parent_order
        ON child.parent_id = subtree.id
     WHERE child.deleted = 0
       AND subtree.depth < 100
       AND INSTR(subtree.path, '!' || hex(child.id) || '/') = 0
       AND (
         (SELECT v FROM root_exempt) = 1
         OR child.reference_target_id IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM workspaces w
            WHERE w.id = child.workspace_id
              AND w.properties_migration IN ('children', 'cell-off')
         )
         OR NOT EXISTS (
           SELECT 1 FROM block_types bt
            WHERE bt.block_id = child.reference_target_id
              AND bt.type = 'property-schema'
              AND bt.workspace_id = child.workspace_id
         )
       )
  )
  SELECT * FROM subtree ORDER BY path
`
