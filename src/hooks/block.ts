import { useEffect, useSyncExternalStore } from 'react'
import { useQuery } from '@powersync/react'
import { BlockData, BlockProperty } from '@/types.ts'
import { useRepo } from '@/context/repo.tsx'
import { Block } from '@/data/block.ts'
import { BlockRow, parseBlockRow } from '@/data/repo.ts'
import { useCallback } from 'react'

const blockQuery = `
  SELECT
    id,
    content,
    properties_json,
    child_ids_json,
    parent_id,
    create_time,
    update_time,
    created_by_user_id,
    updated_by_user_id,
    references_json
  FROM blocks
  WHERE id = ?
`

const blockRowComparator = {
  keyBy: (row: BlockRow) => row.id,
  compareBy: (row: BlockRow) => JSON.stringify(row),
}

const pickPreferredSnapshot = (
  cached: BlockData | undefined,
  fromDb: BlockData | undefined,
  isDirty: boolean,
) => {
  if (isDirty && cached) return cached
  return fromDb ?? cached
}

export const useData = (block: Block) => {
  const repo = useRepo()
  const revision = useSyncExternalStore(
    useCallback((listener) => repo.subscribeToBlock(block.id, listener), [repo, block.id]),
    () => repo.getBlockRevision(block.id),
    () => repo.getBlockRevision(block.id),
  )
  const {data} = useQuery<BlockRow>(blockQuery, [block.id], {
    rowComparator: blockRowComparator,
  })

  const fromDb = data[0] ? parseBlockRow(data[0]) : undefined
  useEffect(() => {
    if (fromDb) {
      repo.hydrateBlockData(fromDb)
    }
  }, [fromDb, repo])

  void revision
  return pickPreferredSnapshot(repo.getCachedBlockData(block.id), fromDb, repo.isBlockDirty(block.id))
}

export const useDataWithSelector =
  <T>(block: Block, selector: (doc: BlockData | undefined) => T) => selector(useData(block))

export function useProperty<T extends BlockProperty>(block: Block, config: T): [T, (value: T) => void] {
  const name = config.name
  const property = useDataWithSelector(block, doc => doc?.properties[name])

  const setProperty = useCallback((newProperty: T) => {
    block.setProperty(newProperty)
  }, [block])

  return [(property ?? config) as T, setProperty]
}

export function usePropertyValue<T extends BlockProperty>(block: Block, config: T): [T['value'], (value: T['value']) => void] {
  const [property, setProperty] = useProperty(block, config)

  const setValue = useCallback((newValue: T['value']) => {
    setProperty({
      ...property,
      value: newValue,
    })
  }, [property, setProperty])

  return [property.value, setValue]
}

export const useContent = (block: Block) => useDataWithSelector(block, doc => doc?.content || '')

export const useChildIds = (block: Block) =>
  useDataWithSelector(block, doc => doc?.childIds || [])

export const useChildren = (block: Block): Block[] =>
  useChildIds(block).map(childId => block.repo.find(childId))

export const useHasChildren = (block: Block) =>
  useDataWithSelector(block, (data?: BlockData) => data ? data.childIds.length > 0 : false)
