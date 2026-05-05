import { useMemo } from 'react'
import type { BlockData } from '@/data/api'
import type { Block } from '@/data/block'
import { useUserPrefsProperty } from '@/data/globalState.ts'
import { useHandle } from '@/hooks/block.ts'
import {
  groupedBacklinksDefaultsProp,
  groupedBacklinksOverridesProp,
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
  const [defaults] = useUserPrefsProperty(groupedBacklinksDefaultsProp)
  const overrides = useHandle(block, {selector: selectGroupedBacklinksOverrides})

  return useMemo(
    () => mergeGroupedBacklinksConfig(defaults, overrides),
    [defaults, overrides],
  )
}
