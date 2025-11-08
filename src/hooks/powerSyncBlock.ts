import { useSuspenseQuery } from '@powersync/react'
import type { DifferentialHookOptions } from '@powersync/react/lib/hooks/watched/watch-types.js'
import type { QueryParam } from '@powersync/common'
import { BlockData, BlockProperty } from '@/types'
import { useMemo } from 'react'

type SharedQueryOptions<RowType> = DifferentialHookOptions<RowType>

interface QueryDescriptor<RowType> {
  sql: string
  parameters: QueryParam[]
  options?: SharedQueryOptions<RowType>
}


const BLOCK_QUERY = 'SELECT * FROM blocks WHERE id = ? AND is_deleted = 0'
const BLOCK_PROPS_QUERY = 'SELECT * FROM block_properties WHERE block_id = ?'
const CHILDREN_QUERY = `SELECT id FROM blocks 
     WHERE parent_id = ? AND is_deleted = 0
     ORDER BY order_key`
const TEXT_REFS_QUERY = "SELECT * FROM block_refs WHERE block_id = ? AND origin = 'text'"
const CONTENT_QUERY = 'SELECT id, content FROM blocks WHERE id = ? AND is_deleted = 0'
const PROPERTY_QUERY = 'SELECT * FROM block_properties WHERE block_id = ? AND name = ?'

const BLOCK_ROW_OPTIONS: SharedQueryOptions<any> = {
  rowComparator: {
    keyBy: (item: any) => item.id,
    compareBy: (item: any) => `${item.content}-${item.update_time}`
  }
}

const BLOCK_PROPS_OPTIONS: SharedQueryOptions<any> = {
  rowComparator: {
    keyBy: (item: any) => `${item.block_id}-${item.name}`,
    compareBy: (item: any) => item.value_json
  }
}

const CHILD_ROWS_OPTIONS: SharedQueryOptions<any> = {
  rowComparator: {
    keyBy: (item: any) => item.id,
    compareBy: (item: any) => item.order_key
  }
}

const TEXT_REFS_OPTIONS: SharedQueryOptions<any> = {
  rowComparator: {
    keyBy: (item: any) => `${item.block_id}-${item.target_id}`,
    compareBy: (item: any) => item.alias
  }
}

const CONTENT_OPTIONS: SharedQueryOptions<any> = {
  rowComparator: {
    keyBy: (item: any) => item.id,
    compareBy: (item: any) => item.content
  }
}

const PROPERTY_OPTIONS: SharedQueryOptions<any> = {
  rowComparator: {
    keyBy: (item: any) => `${item.block_id}-${item.name}`,
    compareBy: (item: any) => `${item.type}-${item.value_json}-${item.change_scope}`
  }
}

function useCachedSuspenseQuery<RowType>(descriptor: QueryDescriptor<RowType>) {
  return useSuspenseQuery(descriptor.sql, descriptor.parameters, descriptor.options)
}

/**
 * Hook to get block data from PowerSync SQLite
 */
export function usePowerSyncBlockData(blockId: string): BlockData | null {
  // Query main block
  const { data: blockRows } = useCachedSuspenseQuery({
    sql: BLOCK_QUERY,
    parameters: [blockId],
    options: BLOCK_ROW_OPTIONS
  })

  // Query properties
  const { data: propRows } = useCachedSuspenseQuery({
    sql: BLOCK_PROPS_QUERY,
    parameters: [blockId],
    options: BLOCK_PROPS_OPTIONS
  })

  // Query children (ordered by order_key)
  const { data: childRows } = useCachedSuspenseQuery({
    sql: CHILDREN_QUERY,
    parameters: [blockId],
    options: CHILD_ROWS_OPTIONS
  })

  // Query text references
  const { data: refRows } = useCachedSuspenseQuery({
    sql: TEXT_REFS_QUERY,
    parameters: [blockId],
    options: TEXT_REFS_OPTIONS
  })

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
  const { data } = useCachedSuspenseQuery({
    sql: CHILDREN_QUERY,
    parameters: [parentId],
    options: CHILD_ROWS_OPTIONS
  })

  return useMemo(() => data?.map((row: any) => row.id) ?? [], [data])
}

/**
 * Hook to get block content from PowerSync
 */
export function usePowerSyncContent(blockId: string): string {
  const { data } = useCachedSuspenseQuery({
    sql: CONTENT_QUERY,
    parameters: [blockId],
    options: CONTENT_OPTIONS
  })

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
  const { data } = useCachedSuspenseQuery({
    sql: PROPERTY_QUERY,
    parameters: [blockId, propertyName],
    options: PROPERTY_OPTIONS
  })

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
