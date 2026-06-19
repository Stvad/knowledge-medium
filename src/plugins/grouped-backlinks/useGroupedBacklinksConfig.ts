import { useMemo } from 'react'
import type { Block } from '@/data/block'
import { usePluginPrefsProperty } from '@/data/globalState.js'
import { useHandle } from '@/hooks/block.js'
import {
  groupedBacklinksDefaultsProp,
  groupedBacklinksPrefsType,
  mergeGroupedBacklinksConfig,
  selectGroupedBacklinksOverrides,
  type GroupedBacklinksConfig,
} from './config.ts'

export const useGroupedBacklinksConfig = (block: Block): GroupedBacklinksConfig => {
  const [defaults] = usePluginPrefsProperty(groupedBacklinksPrefsType, groupedBacklinksDefaultsProp)
  const overrides = useHandle(block, {selector: selectGroupedBacklinksOverrides})

  return useMemo(
    () => mergeGroupedBacklinksConfig(defaults, overrides),
    [defaults, overrides],
  )
}
