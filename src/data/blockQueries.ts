import {
  SELECT_BLOCK_COLUMNS_SQL,
  buildQualifiedBlockColumnsSql,
} from '@/data/blockStorage'

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

export const SELECT_ALIASES_IN_SUBTREE_SQL = `
  ${SUBTREE_CTE_SQL}
  SELECT
    alias.value AS alias,
    MIN(subtree.sort_key) AS first_sort_key
  FROM blocks
  JOIN subtree ON subtree.id = blocks.id
  JOIN json_each(blocks.properties_json, '$.alias.value') AS alias
  WHERE (? = '' OR LOWER(alias.value) LIKE '%' || LOWER(?) || '%')
  GROUP BY alias.value
  ORDER BY first_sort_key, alias.value
`

export const SELECT_BLOCK_BY_ALIAS_IN_SUBTREE_SQL = `
  ${SUBTREE_CTE_SQL}
  SELECT
    ${buildQualifiedBlockColumnsSql('blocks')}
  FROM blocks
  JOIN subtree ON subtree.id = blocks.id
  JOIN json_each(blocks.properties_json, '$.alias.value') AS alias
  WHERE alias.value = ?
  ORDER BY subtree.sort_key
  LIMIT 1
`

export const SELECT_BLOCKS_BY_TYPE_IN_SUBTREE_SQL = `
  ${SUBTREE_CTE_SQL}
  SELECT
    ${buildQualifiedBlockColumnsSql('blocks')}
  FROM blocks
  JOIN subtree ON subtree.id = blocks.id
  WHERE blocks.id != ?
    AND json_extract(blocks.properties_json, '$.type.value') = ?
  ORDER BY subtree.sort_key
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

