import { useCallback, useMemo } from 'react'
import { ChangeScope } from '@/data/api'
import type { Block } from '@/data/block'
import { useData } from '@/hooks/block.ts'
import {
  hasBacklinksFilter,
  normalizeBacklinksFilter,
  type BacklinksFilter,
} from './query.ts'
import {
  backlinksFilterProp,
  readBacklinksFilterProperty,
} from './filterProperty.ts'

export const useStoredBacklinkFilter = (
  block: Block,
): [BacklinksFilter, (filter: BacklinksFilter) => void] => {
  const data = useData(block)
  const stored = data?.properties[backlinksFilterProp.name]
  const filter = useMemo(
    () => stored === undefined ? {} : readBacklinksFilterProperty(stored),
    [stored],
  )

  const setFilter = useCallback((next: BacklinksFilter) => {
    if (block.repo.isReadOnly) return
    const normalized = normalizeBacklinksFilter(next)
    void block.repo.tx(async tx => {
      const current = await tx.get(block.id)
      if (!current) return

      const properties = {...current.properties}
      if (hasBacklinksFilter(normalized)) {
        properties[backlinksFilterProp.name] = backlinksFilterProp.codec.encode(normalized)
      } else {
        delete properties[backlinksFilterProp.name]
      }
      await tx.update(block.id, {properties})
    }, {
      scope: ChangeScope.BlockDefault,
      description: 'update backlinks filter',
    })
  }, [block])

  return [filter, setFilter]
}
