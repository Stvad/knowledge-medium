import { useQuery } from '@powersync/react'
import { BlockData, BlockProperty } from '@/types'
import { useMemo } from 'react'

/**
 * Hook to get block data from PowerSync SQLite
 */
export function usePowerSyncBlockData(blockId: string): BlockData | null {
  // Query main block
  const { data: blockRows } = useQuery(
    'SELECT * FROM blocks WHERE id = ? AND is_deleted = 0',
    [blockId]
  )
  
  // Query properties
  const { data: propRows } = useQuery(
    'SELECT * FROM block_properties WHERE block_id = ?',
    [blockId]
  )
  
  // Query children (ordered by order_key)
  const { data: childRows } = useQuery(
    `SELECT id FROM blocks 
     WHERE parent_id = ? AND is_deleted = 0
     ORDER BY order_key`,
    [blockId]
  )
  
  // Query text references
  const { data: refRows } = useQuery(
    "SELECT * FROM block_refs WHERE block_id = ? AND origin = 'text'",
    [blockId]
  )
  
  return useMemo(() => {
    if (!blockRows || blockRows.length === 0) {
      console.log('[usePowerSyncBlockData] No block found for:', blockId)
      return null
    }
    
    const block = blockRows[0] as any
    console.log('[usePowerSyncBlockData] Found block:', blockId, block)
    
    // Reconstruct BlockData from normalized tables
    return {
      id: block.id,
      content: block.content,
      parentId: block.parent_id,
      createTime: block.create_time,
      updateTime: block.update_time,
      createdByUserId: block.created_by_user_id,
      updatedByUserId: block.updated_by_user_id,
      properties: Object.fromEntries(
        (propRows || []).map((p: any) => [p.name, { 
          name: p.name,
          type: p.type,
          value: JSON.parse(p.value_json),
          changeScope: p.change_scope
        }])
      ),
      childIds: (childRows || []).map((r: any) => r.id),
      references: (refRows || []).map((r: any) => ({
        id: r.target_id,
        alias: r.alias || ''
      }))
    } as BlockData
  }, [blockRows, propRows, childRows, refRows])
}

/**
 * Hook to get child IDs from PowerSync
 */
export function usePowerSyncChildren(parentId: string): string[] {
  const { data } = useQuery(
    `SELECT id FROM blocks 
     WHERE parent_id = ? AND is_deleted = 0
     ORDER BY order_key`,
    [parentId]
  )
  
  return useMemo(() => data?.map((row: any) => row.id) ?? [], [data])
}

/**
 * Hook to get block content from PowerSync
 */
export function usePowerSyncContent(blockId: string): string {
  const { data } = useQuery(
    'SELECT content FROM blocks WHERE id = ? AND is_deleted = 0',
    [blockId]
  )
  
  return useMemo(() => data?.[0]?.content ?? '', [data])
}

/**
 * Hook to get a block property from PowerSync
 */
export function usePowerSyncProperty<T extends BlockProperty>(
  blockId: string,
  propertyName: string,
  defaultValue: T
): T {
  const { data } = useQuery(
    'SELECT * FROM block_properties WHERE block_id = ? AND name = ?',
    [blockId, propertyName]
  )
  
  return useMemo(() => {
    if (!data || data.length === 0) return defaultValue
    
    const prop = data[0] as any
    return {
      name: prop.name,
      type: prop.type,
      value: JSON.parse(prop.value_json),
      changeScope: prop.change_scope
    } as T
  }, [data, defaultValue])
}
