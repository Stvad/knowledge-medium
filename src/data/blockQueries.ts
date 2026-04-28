import {
  SELECT_BLOCK_COLUMNS_SQL,
  buildQualifiedBlockColumnsSql,
} from '@/data/blockSchema'

export interface BlockEventChangeRow {
  seq: number
  blockId: string
}

export interface BlockEventStateRow {
  afterJson: string | null
}

export const SELECT_BLOCK_SQL = `
  SELECT
    ${SELECT_BLOCK_COLUMNS_SQL}
  FROM blocks
  WHERE id = ?
`

export const SELECT_BLOCK_EVENTS_AFTER_SQL = `
  SELECT
    seq,
    block_id AS blockId
  FROM block_events
  WHERE seq > ?
  ORDER BY seq ASC
`

export const SELECT_MAX_BLOCK_EVENT_SEQ_SQL = `
  SELECT
    COALESCE(MAX(seq), 0) AS seq
  FROM block_events
`

export const SELECT_BLOCK_STATE_AT_SQL = `
  SELECT
    after_json AS afterJson
  FROM block_events
  WHERE block_id = ?
    AND event_time <= ?
  ORDER BY seq DESC
  LIMIT 1
`

export const SELECT_ALL_BLOCK_STATES_AT_SQL = `
  WITH latest AS (
    SELECT
      block_id,
      MAX(seq) AS seq
    FROM block_events
    WHERE event_time <= ?
    GROUP BY block_id
  )
  SELECT
    block_events.after_json AS afterJson
  FROM latest
  JOIN block_events ON block_events.seq = latest.seq
  WHERE block_events.after_json IS NOT NULL
`

export const buildSelectBlocksByIdsSql = (count: number) => `
  SELECT
    ${SELECT_BLOCK_COLUMNS_SQL}
  FROM blocks
  WHERE id IN (${Array.from({length: count}, () => '?').join(', ')})
`

const SUBTREE_CTE_SQL = `
  WITH RECURSIVE subtree(id, sort_key, visited_path) AS (
    SELECT
      id,
      '' AS sort_key,
      ',' || id || ',' AS visited_path
    FROM blocks
    WHERE id = ?

    UNION ALL

    SELECT
      child.id,
      subtree.sort_key || printf('%08d.', CAST(child_order.key AS INTEGER)) AS sort_key,
      subtree.visited_path || child.id || ','
    FROM subtree
    JOIN blocks AS parent ON parent.id = subtree.id
    JOIN json_each(parent.child_ids_json) AS child_order
    JOIN blocks AS child ON child.id = child_order.value
    WHERE instr(subtree.visited_path, ',' || child.id || ',') = 0
  )
`

export const buildSelectSubtreeBlocksSql = (includeRoot: boolean) => `
  ${SUBTREE_CTE_SQL}
  SELECT
    ${buildQualifiedBlockColumnsSql('blocks')}
  FROM blocks
  JOIN subtree ON subtree.id = blocks.id
  ${includeRoot ? '' : 'WHERE blocks.id != ?'}
  ORDER BY subtree.sort_key
`

// `deleted = 0` filters soft-deleted blocks. Block.delete() marks the block
// and all descendants deleted, so this catches both leaf and subtree deletes.
// Backed by idx_blocks_workspace_active (partial index on workspace_id WHERE
// deleted = 0).
export const SELECT_ALIASES_IN_WORKSPACE_SQL = `
  SELECT
    alias.value AS alias
  FROM blocks
  JOIN json_each(blocks.properties_json, '$.alias.value') AS alias
  WHERE blocks.workspace_id = ?
    AND blocks.deleted = 0
    AND (? = '' OR LOWER(alias.value) LIKE '%' || LOWER(?) || '%')
  GROUP BY alias.value
  ORDER BY MIN(blocks.create_time), alias.value
`

// json_each() exposes its own `id` column, so any unqualified `SELECT id ...`
// alongside the join is ambiguous. Qualify every block column to keep SQLite
// happy.
export const SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_SQL = `
  SELECT
    ${buildQualifiedBlockColumnsSql('blocks')}
  FROM blocks
  JOIN json_each(blocks.properties_json, '$.alias.value') AS alias
  WHERE blocks.workspace_id = ?
    AND blocks.deleted = 0
    AND alias.value = ?
  ORDER BY blocks.create_time
  LIMIT 1
`

export const SELECT_ALIAS_MATCHES_IN_WORKSPACE_SQL = `
  SELECT
    alias.value AS alias,
    blocks.id AS blockId,
    blocks.content AS content
  FROM blocks
  JOIN json_each(blocks.properties_json, '$.alias.value') AS alias
  WHERE blocks.workspace_id = ?
    AND blocks.deleted = 0
    AND (? = '' OR LOWER(alias.value) LIKE '%' || LOWER(?) || '%')
  ORDER BY blocks.create_time, alias.value
  LIMIT ?
`

// Find blocks whose `references_json` contains the target block id. Used to
// surface "Linked References" on a zoomed-in block. The EXISTS+json_each path
// expands to the partial index `idx_blocks_workspace_references` (see
// repoInstance.ts), which only contains blocks that actually have outgoing
// references — keeping the scan small even on workspaces with thousands of
// link-free blocks.
export const SELECT_BACKLINKS_FOR_BLOCK_SQL = `
  SELECT
    ${SELECT_BLOCK_COLUMNS_SQL}
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
  ORDER BY blocks.update_time DESC, blocks.id
`

export const SELECT_BLOCKS_BY_CONTENT_SQL = `
  SELECT
    ${SELECT_BLOCK_COLUMNS_SQL}
  FROM blocks
  WHERE workspace_id = ?
    AND deleted = 0
    AND content != ''
    AND LOWER(content) LIKE '%' || LOWER(?) || '%'
  ORDER BY update_time DESC
  LIMIT ?
`

export const SELECT_BLOCKS_BY_TYPE_SQL = `
  SELECT
    ${SELECT_BLOCK_COLUMNS_SQL}
  FROM blocks
  WHERE workspace_id = ?
    AND deleted = 0
    AND json_extract(properties_json, '$.type.value') = ?
  ORDER BY create_time ASC, id ASC
`

export const SELECT_FIRST_CHILD_BY_CONTENT_SQL = `
  SELECT
    ${buildQualifiedBlockColumnsSql('child')}
  FROM blocks AS parent
  JOIN json_each(parent.child_ids_json) AS child_order
  JOIN blocks AS child ON child.id = child_order.value
  WHERE parent.id = ?
    AND child.content = ?
  ORDER BY CAST(child_order.key AS INTEGER)
  LIMIT 1
`

