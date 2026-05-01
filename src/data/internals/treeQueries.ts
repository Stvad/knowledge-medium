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
 *  `deleted = 0`. */
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
      JOIN blocks AS child ON child.parent_id = subtree.id
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

/** Existence check: is :potentialAncestor an ancestor of :id?
 *  Used by `tx.move`'s cycle-validation: would the new parent be a
 *  descendant of `id`? Parameter order in the SQL: `?, ?` for
 *  `(id, potentialAncestor)`. */
export const IS_DESCENDANT_OF_SQL = `
  WITH RECURSIVE chain AS (
    SELECT id, parent_id,
           '!' || hex(id) || '/' AS path,
           0 AS depth
      FROM blocks
     WHERE id = ? AND deleted = 0
    UNION ALL
    SELECT b.id, b.parent_id,
           chain.path || '!' || hex(b.id) || '/',
           chain.depth + 1
      FROM blocks AS b
      JOIN chain ON chain.parent_id = b.id
     WHERE b.deleted = 0
       AND chain.depth < 100
       AND INSTR(chain.path, '!' || hex(b.id) || '/') = 0
  )
  SELECT 1 AS hit FROM chain WHERE id = ? LIMIT 1
`

/** Direct children of a parent, ordered `(order_key, id)`, filtered
 *  `deleted = 0`. */
export const CHILDREN_SQL = `
  SELECT * FROM blocks
   WHERE parent_id = ? AND deleted = 0
   ORDER BY order_key, id
`

/** Same as CHILDREN_SQL but returns only `id` — for the child-id-only
 *  handle (`repo.childIds`) which doesn't need to hydrate the full row
 *  and only declares structural deps (`parent-edge`). */
export const CHILDREN_IDS_SQL = `
  SELECT id FROM blocks
   WHERE parent_id = ? AND deleted = 0
   ORDER BY order_key, id
`
