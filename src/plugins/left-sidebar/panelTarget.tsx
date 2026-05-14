import { useMemo } from 'react'
import type { BlockData } from '@/data/api'
import { activePanelIdProp } from '@/data/properties.ts'
import { useLayoutSessionBlock } from '@/data/globalState.ts'
import { useHandle, usePropertyValue } from '@/hooks/block.ts'
import { useRepo } from '@/context/repo.tsx'
import {
  panelBlockId,
  panelRowsInLayoutOrder,
} from '@/utils/panelLayoutProjection.ts'

const EMPTY_ROWS: readonly BlockData[] = Object.freeze([])

export interface ActivePanelNodeTarget {
  activeTopLevelBlockId: string | undefined
  canCreateNode: boolean
}

export function useActivePanelNodeTarget(): ActivePanelNodeTarget {
  const repo = useRepo()
  const layoutSessionBlock = useLayoutSessionBlock()
  const [activePanelId] = usePropertyValue(layoutSessionBlock, activePanelIdProp)
  const rows = useHandle(layoutSessionBlock.repo.query.subtree({id: layoutSessionBlock.id}), {
    selector: data => data ?? EMPTY_ROWS,
  })

  const panelRows = useMemo(
    () => panelRowsInLayoutOrder(layoutSessionBlock.id, rows),
    [layoutSessionBlock.id, rows],
  )
  const activePanelRow = useMemo(
    () =>
      (activePanelId ? panelRows.find(row => row.id === activePanelId) : undefined)
      ?? panelRows.at(-1),
    [activePanelId, panelRows],
  )
  const activeTopLevelBlockId = activePanelRow ? panelBlockId(activePanelRow) : undefined

  return {
    activeTopLevelBlockId,
    canCreateNode: Boolean(activeTopLevelBlockId && activePanelRow && !repo.isReadOnly),
  }
}
