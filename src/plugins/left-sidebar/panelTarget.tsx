import { useMemo } from 'react'
import type { Block } from '@/data/block.ts'
import type { BlockData } from '@/data/api'
import type { Repo } from '@/data/repo.ts'
import {
  activePanelIdProp,
  focusedBlockIdProp,
  setIsEditing,
} from '@/data/properties.ts'
import { useLayoutSessionBlock } from '@/data/globalState.ts'
import { useHandle, usePropertyValue } from '@/hooks/block.ts'
import { useRepo } from '@/context/repo.tsx'
import {
  panelBlockId,
  panelRowsInLayoutOrder,
} from '@/utils/panelLayoutProjection.ts'

const EMPTY_ROWS: readonly BlockData[] = Object.freeze([])

export interface ActivePanelNodeTarget {
  activePanelBlock: Block | null
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
  const activePanelBlock = useMemo(
    () => activePanelRow ? repo.block(activePanelRow.id) : null,
    [activePanelRow, repo],
  )
  const activeTopLevelBlockId = activePanelRow ? panelBlockId(activePanelRow) : undefined

  return {
    activePanelBlock,
    activeTopLevelBlockId,
    canCreateNode: Boolean(activeTopLevelBlockId && activePanelBlock && !repo.isReadOnly),
  }
}

export const createNodeInActivePanel = async ({
  repo,
  activePanelBlock,
  activeTopLevelBlockId,
}: ActivePanelNodeTarget & { repo: Repo }): Promise<void> => {
  if (!activeTopLevelBlockId || !activePanelBlock || repo.isReadOnly) return
  const newId = await repo.mutate.createChild({
    parentId: activeTopLevelBlockId,
    position: {kind: 'last'},
  })
  await activePanelBlock.set(focusedBlockIdProp, newId)
  setIsEditing(activePanelBlock, true)
}
