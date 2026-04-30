/**
 * Kernel queries — raw SQL helpers used by Repo for outside-tx reads
 * (UI hooks, search, alias lookup, backlinks, type filters).
 *
 * Phase-1 scope: plain `Repo.findX(...)` methods + standalone SQL
 * constants. Phase 4 wraps these in `queriesFacet` contributions
 * (`repo.query.X(args).load()`); the SQL underneath stays the same.
 *
 * Property-shape note: the new `BlockData.properties` is flat
 * `{name: encodedValue}`, NOT the legacy `{name: {name, type, value}}`
 * record. So `json_extract(properties_json, '$.alias')` returns the
 * encoded value directly (string[] for alias, string for type, etc.).
 * The legacy `'$.alias.value'` paths don't exist anymore.
 */

import { SELECT_BLOCK_COLUMNS_SQL, buildQualifiedBlockColumnsSql } from '@/data/blockSchema'

export const SELECT_BLOCK_BY_ID_SQL = `
  SELECT ${SELECT_BLOCK_COLUMNS_SQL}
  FROM blocks
  WHERE id = ?
    AND deleted = 0
`

/** Backlinks: blocks whose `references_json` array contains an entry
 *  with `id = ?`. Excludes the target itself + tombstones; `references_json !=
 *  '[]'` lets the partial index `idx_blocks_workspace_with_references` carry
 *  the scan. */
export const SELECT_BACKLINKS_FOR_BLOCK_SQL = `
  SELECT ${SELECT_BLOCK_COLUMNS_SQL}
  FROM blocks
  WHERE blocks.workspace_id = ?
    AND blocks.deleted = 0
    AND blocks.id != ?
    AND blocks.references_json != '[]'
    AND EXISTS (
      SELECT 1
      FROM json_each(blocks.references_json) AS ref
      WHERE json_extract(ref.value, '$.id') = ?
    )
  ORDER BY blocks.updated_at DESC, blocks.id
`

/** Type filter — flat-property shape (`$.type`, not `$.type.value`). */
export const SELECT_BLOCKS_BY_TYPE_SQL = `
  SELECT ${SELECT_BLOCK_COLUMNS_SQL}
  FROM blocks
  WHERE workspace_id = ?
    AND deleted = 0
    AND json_extract(properties_json, '$.type') = ?
  ORDER BY created_at ASC, id ASC
`

/** Content search — case-insensitive substring match. */
export const SELECT_BLOCKS_BY_CONTENT_SQL = `
  SELECT ${SELECT_BLOCK_COLUMNS_SQL}
  FROM blocks
  WHERE workspace_id = ?
    AND deleted = 0
    AND content != ''
    AND LOWER(content) LIKE '%' || LOWER(?) || '%'
  ORDER BY updated_at DESC
  LIMIT ?
`

/** Distinct alias values in a workspace, optionally filtered substring.
 *  The flat alias property is a JSON array of strings; `json_each` walks
 *  the array, GROUP BY collapses dupes across blocks. */
export const SELECT_ALIASES_IN_WORKSPACE_SQL = `
  SELECT alias.value AS alias
  FROM blocks
  JOIN json_each(blocks.properties_json, '$.alias') AS alias
  WHERE blocks.workspace_id = ?
    AND blocks.deleted = 0
    AND (? = '' OR LOWER(alias.value) LIKE '%' || LOWER(?) || '%')
  GROUP BY alias.value
  ORDER BY MIN(blocks.created_at), alias.value
`

/** Single-block lookup by exact alias (used by createOrRestore wrappers
 *  and call-site alias jumps). Returns the oldest match (deterministic
 *  tie-break on workspaces with two blocks accidentally claiming the
 *  same alias). */
export const SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_SQL = `
  SELECT ${buildQualifiedBlockColumnsSql('blocks')}
  FROM blocks
  JOIN json_each(blocks.properties_json, '$.alias') AS alias
  WHERE blocks.workspace_id = ?
    AND blocks.deleted = 0
    AND alias.value = ?
  ORDER BY blocks.created_at
  LIMIT 1
`

/** Alias-prefix match used by QuickFind / autocomplete; one row per
 *  (alias, block) pair. */
export const SELECT_ALIAS_MATCHES_IN_WORKSPACE_SQL = `
  SELECT
    alias.value AS alias,
    blocks.id AS blockId,
    blocks.content AS content
  FROM blocks
  JOIN json_each(blocks.properties_json, '$.alias') AS alias
  WHERE blocks.workspace_id = ?
    AND blocks.deleted = 0
    AND (? = '' OR LOWER(alias.value) LIKE '%' || LOWER(?) || '%')
  ORDER BY blocks.created_at, alias.value
  LIMIT ?
`

/** First child of `parentId` whose content matches exactly. Tree-shape:
 *  joins on `blocks.parent_id`, ordered by `(order_key, id)` so the
 *  "first" tie-breaks deterministically. */
export const SELECT_FIRST_CHILD_BY_CONTENT_SQL = `
  SELECT ${buildQualifiedBlockColumnsSql('child')}
  FROM blocks AS child
  WHERE child.parent_id = ?
    AND child.deleted = 0
    AND child.content = ?
  ORDER BY child.order_key, child.id
  LIMIT 1
`

export interface AliasMatch {
  alias: string
  blockId: string
  content: string
}
