import { useMemo } from 'react'
import type { BlockData } from '@/data/api'
import type { Block } from '@/data/block'
import { usePluginPrefsProperty } from '@/data/globalState.js'
import { useHandle } from '@/hooks/block.js'
import {
  groupedBacklinksDefaultsProp,
  groupedBacklinksOverridesProp,
  groupedBacklinksPrefsType,
  mergeGroupedBacklinksConfig,
  type GroupedBacklinksConfig,
  type GroupedBacklinksOverrides,
} from './config.ts'

const selectGroupedBacklinksOverrides = (
  data: BlockData | null | undefined,
): GroupedBacklinksOverrides => {
  const stored = data?.properties[groupedBacklinksOverridesProp.name]
  return stored === undefined
    ? groupedBacklinksOverridesProp.defaultValue
    : groupedBacklinksOverridesProp.codec.decode(stored)
}

export const useGroupedBacklinksConfig = (block: Block): GroupedBacklinksConfig => {
  const [defaults] = usePluginPrefsProperty(groupedBacklinksPrefsType, groupedBacklinksDefaultsProp)
  const overrides = useHandle(block, {selector: selectGroupedBacklinksOverrides})

  return useMemo(
    () => mergeGroupedBacklinksConfig(defaults, overrides),
    [defaults, overrides],
  )
}
