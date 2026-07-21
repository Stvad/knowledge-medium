import { useCallback, useMemo } from 'react'
import { ChangeScope } from '@/data/api'
import type { Block } from '@/data/block'
import { usePluginPrefsBlock } from '@/data/globalState.js'
import { useHandle, usePropertyValue } from '@/hooks/block.js'
import {
  mergeBacklinksFilters,
  hasBacklinksFilter,
  normalizeBacklinksFilter,
  type BacklinksFilter,
} from './query.ts'
import { backlinksFilterProp } from './filterProperty.ts'
import {
  backlinksPrefsType,
  dailyNoteBacklinksDefaultsProp,
  defaultBacklinksFilterForBlock,
} from './dailyNoteDefaults.ts'

export const useStoredBacklinkFilter = (
  block: Block,
): [BacklinksFilter, (filter: BacklinksFilter) => void] => {
  const [filter] = usePropertyValue(block, backlinksFilterProp)

  const setFilter = useCallback((next: BacklinksFilter) => {
    if (block.repo.isReadOnly) return
    const normalized = normalizeBacklinksFilter(next)
    void block.repo.tx(async tx => {
      const current = await tx.get(block.id)
      if (!current) return // block gone: silent no-op (the typed primitives would throw)

      if (hasBacklinksFilter(normalized)) {
        await tx.setProperty(block.id, backlinksFilterProp, normalized)
      } else {
        await tx.unsetProperty(block.id, backlinksFilterProp)
      }
    }, {
      scope: ChangeScope.BlockDefault,
      description: 'update backlinks filter',
    })
  }, [block])

  return [filter, setFilter]
}

export const useBacklinkFilterState = (
  block: Block,
): {
  filter: BacklinksFilter
  defaultFilter: BacklinksFilter
  effectiveFilter: BacklinksFilter
  defaultFilterConfigBlock: Block
  setFilter: (filter: BacklinksFilter) => void
} => {
  const [filter, setFilter] = useStoredBacklinkFilter(block)
  const defaultFilterConfigBlock = usePluginPrefsBlock(backlinksPrefsType)
  const [dailyNoteDefaults] = usePropertyValue(
    defaultFilterConfigBlock,
    dailyNoteBacklinksDefaultsProp,
  )
  const blockData = useHandle(block, {selector: data => data})

  const defaultFilter = useMemo(
    () => defaultBacklinksFilterForBlock(blockData, dailyNoteDefaults),
    [blockData, dailyNoteDefaults],
  )
  const effectiveFilter = useMemo(
    () => mergeBacklinksFilters(defaultFilter, filter),
    [defaultFilter, filter],
  )

  return {filter, defaultFilter, effectiveFilter, defaultFilterConfigBlock, setFilter}
}
