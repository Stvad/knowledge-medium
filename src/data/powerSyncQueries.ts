import { powerSyncDb } from './powerSyncInstance'
import { BlockData } from '@/types'
import { generateBetweenOrderKey, generateNextOrderKey, generateFirstOrderKey } from '@/utils/orderKey'

// Common SQL queries
export const QUERIES = {
  BLOCK: 'SELECT * FROM blocks WHERE id = ? AND is_deleted = 0',
  BLOCK_PROPERTIES: 'SELECT * FROM block_properties WHERE block_id = ?',
  CHILDREN: 'SELECT id, order_key FROM blocks WHERE parent_id = ? AND is_deleted = 0 ORDER BY order_key',
  CHILDREN_IDS: 'SELECT id FROM blocks WHERE parent_id = ? AND is_deleted = 0 ORDER BY order_key',
  TEXT_REFS: "SELECT * FROM block_refs WHERE block_id = ? AND origin = 'text'",
  CONTENT: 'SELECT id, content FROM blocks WHERE id = ? AND is_deleted = 0',
  PROPERTY: 'SELECT * FROM block_properties WHERE block_id = ? AND name = ?',
  HAS_CHILDREN: 'SELECT CAST(EXISTS(SELECT 1 FROM blocks WHERE parent_id = ? AND is_deleted = 0) AS INTEGER) AS hasChildren',
}

/**
 * Fetch complete block data from PowerSync database
 */
export async function fetchBlockData(blockId: string): Promise<BlockData | undefined> {
  const block = await powerSyncDb.getOptional<any>(QUERIES.BLOCK, [blockId])
  if (!block) return undefined

  const [props, children, refs] = await Promise.all([
    powerSyncDb.getAll<any>(QUERIES.BLOCK_PROPERTIES, [blockId]),
    powerSyncDb.getAll<any>(QUERIES.CHILDREN_IDS, [blockId]),
    powerSyncDb.getAll<any>(QUERIES.TEXT_REFS, [blockId]),
  ])

  return {
    id: block.id,
    content: block.content,
    parentId: block.parent_id,
    createTime: block.create_time,
    updateTime: block.update_time,
    createdByUserId: block.created_by_user_id,
    updatedByUserId: block.updated_by_user_id,
    properties: Object.fromEntries(
      (props || []).map(p => [p.name, {
        name: p.name,
        type: p.type,
        value: JSON.parse(p.value_json),
        changeScope: p.change_scope
      }])
    ),
    childIds: (children || []).map(c => c.id),
    references: (refs || []).map(r => ({
      id: r.target_id,
      alias: r.alias || ''
    }))
  }
}

/**
 * Fetch children with order keys
 */
export async function fetchChildren(parentId: string): Promise<Array<{id: string, order_key: string}>> {
  return powerSyncDb.getAll<{id: string, order_key: string}>(QUERIES.CHILDREN, [parentId])
}

/**
 * Calculate order key for a position among siblings
 */
export async function calculateOrderKey(
  parentId: string,
  position: 'first' | 'last' | number,
  currentChildren?: Array<{id: string, order_key: string}>
): Promise<string> {
  const children = currentChildren || await fetchChildren(parentId)

  if (position === 'first') {
    return children.length > 0
      ? generateBetweenOrderKey(null, children[0].order_key)
      : generateFirstOrderKey()
  } else if (typeof position === 'number') {
    const prevOrderKey = position > 0 ? children[position - 1]?.order_key || null : null
    const nextOrderKey = children[position]?.order_key || null
    return generateBetweenOrderKey(prevOrderKey, nextOrderKey)
  } else {
    // 'last'
    return children.length > 0
      ? generateNextOrderKey(children[children.length - 1].order_key)
      : generateFirstOrderKey()
  }
}

/**
 * Update block's parent and order_key
 */
export async function updateBlockParentAndOrder(
  blockId: string,
  parentId: string,
  orderKey: string,
  userId: string
): Promise<void> {
  await powerSyncDb.execute(
    'UPDATE blocks SET parent_id = ?, order_key = ?, update_time = ?, updated_by_user_id = ? WHERE id = ?',
    [parentId, orderKey, Date.now(), userId, blockId]
  )
}

/**
 * Update block's order_key only
 */
export async function updateBlockOrder(
  blockId: string,
  orderKey: string,
  userId: string
): Promise<void> {
  await powerSyncDb.execute(
    'UPDATE blocks SET order_key = ?, update_time = ?, updated_by_user_id = ? WHERE id = ?',
    [orderKey, Date.now(), userId, blockId]
  )
}

/**
 * Mark block as deleted
 */
export async function markBlockDeleted(
  blockId: string,
  userId: string
): Promise<void> {
  await powerSyncDb.execute(
    'UPDATE blocks SET is_deleted = 1, update_time = ?, updated_by_user_id = ? WHERE id = ?',
    [Date.now(), userId, blockId]
  )
}

/**
 * Update block content
 */
export async function updateBlockContent(
  blockId: string,
  content: string,
  userId: string
): Promise<void> {
  await powerSyncDb.execute(
    'UPDATE blocks SET content = ?, update_time = ?, updated_by_user_id = ? WHERE id = ?',
    [content, Date.now(), userId, blockId]
  )
}
