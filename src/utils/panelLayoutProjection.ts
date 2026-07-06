import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import type { BlockData, Tx, Unsubscribe } from '@/data/api'
import { ChangeScope } from '@/data/api'
import { PANEL_STACK_TYPE, PANEL_TYPE } from '@/data/blockTypes'
import {
  activePanelIdProp,
  focusedBlockLocationProp,
  scrollTopProp,
  topLevelBlockIdProp,
} from '@/data/properties'
import { hasBlockType } from '@/data/properties'
import { keyAtEnd, keyBetween, keysBetween } from '@/data/orderKey'
import { keysImmediatelyAfter } from '@/data/orderKeyPlacement'
import {
  buildLayoutFromSlots,
  parseLayout,
  preserveHashQueryParams,
  type LayoutSlot,
} from '@/utils/routing'
import { panelHistory, writePanelContent } from '@/utils/panelHistory'
import { CallbackSet } from '@/utils/callbackSet'
import { outlineRenderScopeId } from '@/utils/renderScope'

export interface ApplyLayoutResult {
  kind: 'applied' | 'empty' | 'ignored' | 'noop' | 'normalized'
}

interface PanelSlot {
  row: BlockData
  blockId: string | undefined
}

interface ReconciliationPlan {
  rowsByTargetIndex: Map<number, PanelSlot>
  rowsToDelete: PanelSlot[]
}

export const isPanelStackRow = (row: Pick<BlockData, 'properties'>): boolean =>
  hasBlockType(row, PANEL_STACK_TYPE)

export const panelBlockId = (row: BlockData): string | undefined => {
  const stored = row.properties[topLevelBlockIdProp.name]
  if (stored === undefined) return undefined
  return topLevelBlockIdProp.codec.decode(stored)
}

export const panelBlockIds = (rows: readonly BlockData[]): string[] =>
  rows.map(panelBlockId).filter((id): id is string => Boolean(id))

/** Group rows by `parentId`, preserving row order within each parent.
 *  Rows without a parent are skipped (we never want an `undefined` bucket). */
const buildChildrenByParent = (rows: readonly BlockData[]): Map<string, BlockData[]> => {
  const childrenByParent = new Map<string, BlockData[]>()
  for (const row of rows) {
    if (!row.parentId) continue
    const children = childrenByParent.get(row.parentId) ?? []
    children.push(row)
    childrenByParent.set(row.parentId, children)
  }
  return childrenByParent
}

export const panelRowsInLayoutOrder = (
  rootId: string,
  rows: readonly BlockData[],
): BlockData[] => {
  const childrenByParent = buildChildrenByParent(rows)

  const visit = (row: BlockData): BlockData[] =>
    isPanelStackRow(row)
      ? (childrenByParent.get(row.id) ?? []).flatMap(visit)
      : [row]

  return (childrenByParent.get(rootId) ?? []).flatMap(visit)
}

const firstPanelRowInSlot = (
  row: BlockData,
  childrenByParent: Map<string, BlockData[]>,
): BlockData | undefined => {
  if (!isPanelStackRow(row)) return row
  const children = childrenByParent.get(row.id) ?? []
  for (const child of children) {
    const panel = firstPanelRowInSlot(child, childrenByParent)
    if (panel) return panel
  }
  return undefined
}

const lastPanelRowInSlot = (
  row: BlockData,
  childrenByParent: Map<string, BlockData[]>,
): BlockData | undefined => {
  if (!isPanelStackRow(row)) return row
  const children = childrenByParent.get(row.id) ?? []
  for (let index = children.length - 1; index >= 0; index--) {
    const panel = lastPanelRowInSlot(children[index], childrenByParent)
    if (panel) return panel
  }
  return undefined
}

const adjacentPanelRowInParent = (
  parent: BlockData,
  rowId: string,
  childrenByParent: Map<string, BlockData[]>,
): BlockData | undefined => {
  const siblings = childrenByParent.get(parent.id) ?? []
  const index = siblings.findIndex(sibling => sibling.id === rowId)
  if (index < 0) return undefined

  for (let nextIndex = index + 1; nextIndex < siblings.length; nextIndex++) {
    const panel = firstPanelRowInSlot(siblings[nextIndex], childrenByParent)
    if (panel) return panel
  }

  for (let prevIndex = index - 1; prevIndex >= 0; prevIndex--) {
    const panel = lastPanelRowInSlot(siblings[prevIndex], childrenByParent)
    if (panel) return panel
  }

  return undefined
}

const nextActivePanelAfterClose = (
  row: BlockData,
  parent: BlockData | null,
  rowsBeforeDelete: readonly BlockData[],
): string | undefined => {
  const rowsById = new Map(rowsBeforeDelete.map(row => [row.id, row]))
  const childrenByParent = buildChildrenByParent(rowsBeforeDelete)
  let childId = row.id
  let container = parent

  while (container) {
    const sibling = adjacentPanelRowInParent(container, childId, childrenByParent)
    if (sibling) return sibling.id
    if (!isPanelStackRow(container)) return undefined
    childId = container.id
    container = container.parentId ? rowsById.get(container.parentId) ?? null : null
  }

  return undefined
}

const stackAncestorIdsEmptiedByClose = (
  row: BlockData,
  parent: BlockData | null,
  rowsBeforeDelete: readonly BlockData[],
): string[] => {
  const rowsById = new Map(rowsBeforeDelete.map(row => [row.id, row]))
  const childrenByParent = buildChildrenByParent(rowsBeforeDelete)
  const stackIds: string[] = []
  let removedChildId = row.id
  let container = parent

  while (container && isPanelStackRow(container)) {
    const remainingChildren = (childrenByParent.get(container.id) ?? [])
      .filter(child => child.id !== removedChildId)
    if (remainingChildren.length > 0) break

    stackIds.push(container.id)
    removedChildId = container.id
    container = container.parentId ? rowsById.get(container.parentId) ?? null : null
  }

  return stackIds
}

const flattenLayoutSlots = (slots: readonly LayoutSlot[]): string[] =>
  slots.flatMap(slot => slot.kind === 'leaf' ? [slot.blockId] : flattenLayoutSlots(slot.children))

const sameLayoutSlots = (left: readonly LayoutSlot[], right: readonly LayoutSlot[]): boolean =>
  left.length === right.length && left.every((slot, index) => {
    const other = right[index]
    if (!other || slot.kind !== other.kind) return false
    if (slot.kind === 'leaf' && other.kind === 'leaf') return slot.blockId === other.blockId
    if (slot.kind === 'stack' && other.kind === 'stack') return sameLayoutSlots(slot.children, other.children)
    return false
  })

export const layoutSlotsFromRows = (
  rootId: string,
  rows: readonly BlockData[],
): LayoutSlot[] => {
  const childrenByParent = buildChildrenByParent(rows)

  const visit = (row: BlockData): LayoutSlot | null => {
    if (isPanelStackRow(row)) {
      return {
        kind: 'stack',
        children: (childrenByParent.get(row.id) ?? [])
          .map(visit)
          .filter((slot): slot is LayoutSlot => Boolean(slot)),
      }
    }
    const blockId = panelBlockId(row)
    return blockId ? {kind: 'leaf', blockId} : null
  }

  return (childrenByParent.get(rootId) ?? [])
    .map(visit)
    .filter((slot): slot is LayoutSlot => Boolean(slot))
}

export const layoutBlockIdsFromRows = (rootId: string, rows: readonly BlockData[]): string[] =>
  flattenLayoutSlots(layoutSlotsFromRows(rootId, rows))

const loadSubtreeRowsInTx = async (
  tx: Tx,
  root: BlockData,
): Promise<BlockData[]> => {
  const rows: BlockData[] = [root]
  const visit = async (parentId: string): Promise<void> => {
    const children = await tx.childrenOf(parentId, root.workspaceId)
    for (const child of children) {
      rows.push(child)
      await visit(child.id)
    }
  }
  await visit(root.id)
  return rows
}

const lcsMatches = (
  current: readonly PanelSlot[],
  targetBlockIds: readonly string[],
): Array<{currentIndex: number; targetIndex: number}> => {
  const table: number[][] = Array.from(
    {length: current.length + 1},
    () => Array.from({length: targetBlockIds.length + 1}, () => 0),
  )

  for (let i = current.length - 1; i >= 0; i--) {
    for (let j = targetBlockIds.length - 1; j >= 0; j--) {
      table[i][j] = current[i].blockId === targetBlockIds[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }

  const matches: Array<{currentIndex: number; targetIndex: number}> = []
  let i = 0
  let j = 0
  while (i < current.length && j < targetBlockIds.length) {
    if (current[i].blockId === targetBlockIds[j]) {
      matches.push({currentIndex: i, targetIndex: j})
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i++
    } else {
      j++
    }
  }
  return matches
}

const planReconciliation = (
  current: readonly PanelSlot[],
  targetBlockIds: readonly string[],
): ReconciliationPlan => {
  const rowsByTargetIndex = new Map<number, PanelSlot>()
  const matches = lcsMatches(current, targetBlockIds)
  const usedCurrent = new Set<number>()

  for (const match of matches) {
    rowsByTargetIndex.set(match.targetIndex, current[match.currentIndex])
    usedCurrent.add(match.currentIndex)
  }

  for (let targetIndex = 0; targetIndex < targetBlockIds.length; targetIndex++) {
    if (rowsByTargetIndex.has(targetIndex)) continue
    const exactIndex = current.findIndex((slot, currentIndex) =>
      !usedCurrent.has(currentIndex) && slot.blockId === targetBlockIds[targetIndex])
    if (exactIndex >= 0) {
      rowsByTargetIndex.set(targetIndex, current[exactIndex])
      usedCurrent.add(exactIndex)
    }
  }

  for (let targetIndex = 0; targetIndex < targetBlockIds.length; targetIndex++) {
    if (rowsByTargetIndex.has(targetIndex)) continue
    const reusableIndex = current.findIndex((_, currentIndex) => !usedCurrent.has(currentIndex))
    if (reusableIndex >= 0) {
      rowsByTargetIndex.set(targetIndex, current[reusableIndex])
      usedCurrent.add(reusableIndex)
    }
  }

  const rowsToDelete = current.filter((_, currentIndex) => !usedCurrent.has(currentIndex))
  return {rowsByTargetIndex, rowsToDelete}
}

export const createPanelRowInTx = async (
  repo: Repo,
  tx: Tx,
  args: {
    workspaceId: string
    parentId: string
    orderKey: string
    blockId: string
  },
): Promise<string> => {
  const id = await tx.create({
    workspaceId: args.workspaceId,
    parentId: args.parentId,
    orderKey: args.orderKey,
    content: args.blockId,
    properties: {
      [topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode(args.blockId),
      [focusedBlockLocationProp.name]: focusedBlockLocationProp.codec.encode({
        blockId: args.blockId,
        renderScopeId: outlineRenderScopeId(args.blockId),
      }),
      [scrollTopProp.name]: scrollTopProp.codec.encode(0),
    },
  })
  await repo.addTypeInTx(tx, id, PANEL_TYPE)
  return id
}

export const createPanelStackRowInTx = async (
  repo: Repo,
  tx: Tx,
  args: {
    workspaceId: string
    parentId: string
    orderKey: string
  },
): Promise<string> => {
  const id = await tx.create({
    workspaceId: args.workspaceId,
    parentId: args.parentId,
    orderKey: args.orderKey,
    content: 'sidebar-stack',
    properties: {},
  })
  await repo.addTypeInTx(tx, id, PANEL_STACK_TYPE)
  return id
}

export const insertPanelRow = async (
  repo: Repo,
  layoutSessionBlock: Block,
  blockId: string,
  options: {afterPanelId?: string} = {},
): Promise<string> =>
  repo.tx(async tx => {
    const parent = await tx.get(layoutSessionBlock.id)
    if (!parent) throw new Error(`insertPanelRow: layout session block ${layoutSessionBlock.id} not found`)

    const siblings = await tx.childrenOf(layoutSessionBlock.id, parent.workspaceId)
    const sourceIndex = options.afterPanelId
      ? siblings.findIndex(row => row.id === options.afterPanelId)
      : -1
    // Insert the new panel EXACTLY after the source panel (between it and its
    // next sibling), breaking a tie by re-keying the run when the source panel
    // shares an order_key with its next sibling (#198/#182). Non-tie inputs
    // reduce to the previous keyBetween bounds.
    const orderKey = sourceIndex >= 0
      ? (await keysImmediatelyAfter(tx, layoutSessionBlock.id, siblings, sourceIndex, 1))[0]
      : keyAtEnd(siblings.at(-1)?.orderKey ?? null)

    const panelId = await createPanelRowInTx(repo, tx, {
      workspaceId: parent.workspaceId,
      parentId: layoutSessionBlock.id,
      orderKey,
      blockId,
    })
    await tx.setProperty(layoutSessionBlock.id, activePanelIdProp, panelId)
    return panelId
  }, {scope: ChangeScope.UiState, description: 'insert panel row'})

const insertPanelAtStartOfStackInTx = async (
  repo: Repo,
  tx: Tx,
  args: {
    workspaceId: string
    stackId: string
    blockId: string
  },
): Promise<string> => {
  const children = await tx.childrenOf(args.stackId, args.workspaceId)
  const orderKey = keyBetween(null, children[0]?.orderKey ?? null)
  return createPanelRowInTx(repo, tx, {
    workspaceId: args.workspaceId,
    parentId: args.stackId,
    orderKey,
    blockId: args.blockId,
  })
}

export const insertSidebarStackedPanel = async (
  repo: Repo,
  layoutSessionBlock: Block,
  blockId: string,
  options: {sourcePanelId?: string} = {},
): Promise<string> =>
  repo.tx(async tx => {
    const parent = await tx.get(layoutSessionBlock.id)
    if (!parent) throw new Error(`insertSidebarStackedPanel: layout session block ${layoutSessionBlock.id} not found`)

    if (options.sourcePanelId) {
      const source = await tx.get(options.sourcePanelId)
      const sourceParent = source?.parentId ? await tx.get(source.parentId) : null
      if (source && sourceParent && isPanelStackRow(sourceParent)) {
        const panelId = await insertPanelAtStartOfStackInTx(repo, tx, {
          workspaceId: parent.workspaceId,
          stackId: sourceParent.id,
          blockId,
        })
        await tx.setProperty(layoutSessionBlock.id, activePanelIdProp, panelId)
        return panelId
      }

      if (source?.parentId === layoutSessionBlock.id) {
        const topLevelSiblings = await tx.childrenOf(layoutSessionBlock.id, parent.workspaceId)
        const sourceIndex = topLevelSiblings.findIndex(row => row.id === source.id)
        const rightSibling = sourceIndex >= 0 ? topLevelSiblings[sourceIndex + 1] : undefined
        if (rightSibling && isPanelStackRow(rightSibling)) {
          const panelId = await insertPanelAtStartOfStackInTx(repo, tx, {
            workspaceId: parent.workspaceId,
            stackId: rightSibling.id,
            blockId,
          })
          await tx.setProperty(layoutSessionBlock.id, activePanelIdProp, panelId)
          return panelId
        }

        const stackOrderKey = rightSibling
          ? rightSibling.orderKey
          : keyAtEnd(source.orderKey)
        const stackId = await createPanelStackRowInTx(repo, tx, {
          workspaceId: parent.workspaceId,
          parentId: layoutSessionBlock.id,
          orderKey: stackOrderKey,
        })
        if (rightSibling) {
          const [, rightOrderKey] = keysBetween(null, null, 2)
          await tx.move(rightSibling.id, {parentId: stackId, orderKey: rightOrderKey})
        }
        const panelId = await insertPanelAtStartOfStackInTx(repo, tx, {
          workspaceId: parent.workspaceId,
          stackId,
          blockId,
        })
        await tx.setProperty(layoutSessionBlock.id, activePanelIdProp, panelId)
        return panelId
      }
    }

    const siblings = await tx.childrenOf(layoutSessionBlock.id, parent.workspaceId)
    const previous = siblings.at(-1)
    const stackId = await createPanelStackRowInTx(repo, tx, {
      workspaceId: parent.workspaceId,
      parentId: layoutSessionBlock.id,
      orderKey: keyAtEnd(previous?.orderKey ?? null),
    })
    const panelId = await insertPanelAtStartOfStackInTx(repo, tx, {
      workspaceId: parent.workspaceId,
      stackId,
      blockId,
    })
    await tx.setProperty(layoutSessionBlock.id, activePanelIdProp, panelId)
    return panelId
  }, {scope: ChangeScope.UiState, description: 'insert sidebar stack panel'})

export const deletePanelRow = async (
  repo: Repo,
  panelId: string,
): Promise<void> => {
  panelHistory.clear(panelId)
  await repo.tx(async tx => {
    const row = await tx.get(panelId)
    if (!row) return
    const parent = row.parentId ? await tx.get(row.parentId) : null
    let layoutSession = parent
    while (layoutSession && isPanelStackRow(layoutSession)) {
      layoutSession = layoutSession.parentId ? await tx.get(layoutSession.parentId) : null
    }
    const rowsBeforeDelete = layoutSession
      ? await loadSubtreeRowsInTx(tx, layoutSession)
      : []
    const stackIdsToDelete = stackAncestorIdsEmptiedByClose(row, parent, rowsBeforeDelete)
    const deletingActivePanel = layoutSession?.properties[activePanelIdProp.name] === panelId
    const nextActivePanelId = deletingActivePanel
      ? nextActivePanelAfterClose(row, parent, rowsBeforeDelete)
      : undefined
    await tx.delete(panelId)
    for (const stackId of stackIdsToDelete) {
      await tx.delete(stackId)
    }
    if (deletingActivePanel && layoutSession) {
      await tx.setProperty(layoutSession.id, activePanelIdProp, nextActivePanelId)
    }
  }, {scope: ChangeScope.UiState, description: 'close panel'})
}

export const reconcilePanelRows = async (
  repo: Repo,
  layoutSessionBlock: Block,
  targetSlotsOrBlockIds: readonly (LayoutSlot | string)[],
): Promise<void> => {
  const targetSlots: LayoutSlot[] = targetSlotsOrBlockIds.map(slot =>
    typeof slot === 'string' ? {kind: 'leaf', blockId: slot} : slot,
  )
  const targetBlockIds = flattenLayoutSlots(targetSlots)

  await repo.tx(async tx => {
    const parent = await tx.get(layoutSessionBlock.id)
    if (!parent) throw new Error(`reconcilePanelRows: layout session block ${layoutSessionBlock.id} not found`)

    const currentRows = await loadSubtreeRowsInTx(tx, parent)
    const currentLayoutSlots = layoutSlotsFromRows(layoutSessionBlock.id, currentRows)
    if (sameLayoutSlots(currentLayoutSlots, targetSlots)) return

    const currentSlots = currentRows
      .filter(row => row.id !== layoutSessionBlock.id && !isPanelStackRow(row))
      .map(row => ({row, blockId: panelBlockId(row)}))
    const stackRowsToDelete = currentRows
      .filter(row => row.id !== layoutSessionBlock.id && isPanelStackRow(row))

    const {rowsByTargetIndex, rowsToDelete} = planReconciliation(currentSlots, targetBlockIds)

    for (const slot of rowsToDelete) {
      panelHistory.clear(slot.row.id)
      await tx.delete(slot.row.id)
    }

    let targetLeafIndex = 0
    const materializeSlots = async (slots: readonly LayoutSlot[], parentId: string): Promise<void> => {
      const orderKeys = keysBetween(null, null, slots.length)
      for (let index = 0; index < slots.length; index++) {
        const target = slots[index]
        const orderKey = orderKeys[index]
        if (target.kind === 'stack') {
          const stackId = await createPanelStackRowInTx(repo, tx, {
            workspaceId: parent.workspaceId,
            parentId,
            orderKey,
          })
          await materializeSlots(target.children, stackId)
          continue
        }

        const blockId = target.blockId
        const slot = rowsByTargetIndex.get(targetLeafIndex)
        targetLeafIndex++
        if (!slot) {
          await createPanelRowInTx(repo, tx, {
            workspaceId: parent.workspaceId,
            parentId,
            orderKey,
            blockId,
          })
          continue
        }

        if (slot.row.orderKey !== orderKey || slot.row.parentId !== parentId) {
          await tx.move(slot.row.id, {parentId, orderKey})
        }
        if (slot.blockId !== blockId) {
          const restored = slot.blockId
            ? panelHistory.reconcileUrlNavigation(slot.row.id, {
              blockId: slot.blockId,
              state: panelHistory.snapshot(slot.row.id),
            }, blockId)
            : null
          panelHistory.enqueueRestore(slot.row.id, restored?.state)
          await writePanelContent(tx, slot.row.id, blockId, restored?.state)
        }
      }
    }

    await materializeSlots(targetSlots, layoutSessionBlock.id)

    for (const stackRow of stackRowsToDelete) {
      await tx.delete(stackRow.id)
    }
  }, {scope: ChangeScope.UiState, description: 'reconcile panel layout from URL'})
}

export const retargetPanelBlockIds = async (
  repo: Repo,
  layoutSessionBlock: Block,
  fromId: string,
  toId: string,
): Promise<void> => {
  if (fromId === toId) return

  await repo.tx(async tx => {
    const parent = await tx.get(layoutSessionBlock.id)
    if (!parent) {
      throw new Error(`retargetPanelBlockIds: layout session block ${layoutSessionBlock.id} not found`)
    }

    const currentRows = await loadSubtreeRowsInTx(tx, parent)
    const panelRows = currentRows
      .filter(row => row.id !== layoutSessionBlock.id && !isPanelStackRow(row))
      .filter(row => panelBlockId(row) === fromId)

    for (const row of panelRows) {
      const restored = panelHistory.reconcileUrlNavigation(row.id, {
        blockId: fromId,
        state: panelHistory.snapshot(row.id),
      }, toId)
      panelHistory.enqueueRestore(row.id, restored?.state)
      await writePanelContent(tx, row.id, toId, restored?.state)
    }
  }, {scope: ChangeScope.UiState, description: 'retarget merged panels'})
}

export interface ApplyCurrentLayoutUrlArgs {
  repo: Repo
  workspaceId: string
  layoutSessionBlock: Block
  hash?: string
  replaceHash?: (hash: string) => void
}

export const applyCurrentLayoutUrl = async ({
  repo,
  workspaceId,
  layoutSessionBlock,
  hash = typeof window === 'undefined' ? '' : window.location.hash,
  replaceHash,
}: ApplyCurrentLayoutUrlArgs): Promise<ApplyLayoutResult> => {
  const route = parseLayout(hash)
  if (route.workspaceId && route.workspaceId !== workspaceId) {
    return {kind: 'ignored'}
  }

  const currentRows = await layoutSessionBlock.repo.query.subtree({id: layoutSessionBlock.id}).load()
  const currentSlots = layoutSlotsFromRows(layoutSessionBlock.id, currentRows)

  if (route.slots.length === 0) {
    if (currentSlots.length > 0) {
      replaceHash?.(preserveHashQueryParams(buildLayoutFromSlots(workspaceId, currentSlots), hash))
      return {kind: 'normalized'}
    }
    return {kind: 'empty'}
  }

  if (sameLayoutSlots(currentSlots, route.slots)) {
    return {kind: 'noop'}
  }

  await reconcilePanelRows(repo, layoutSessionBlock, route.slots)
  return {kind: 'applied'}
}

export interface PanelLayoutProjectionOptions {
  repo: Repo
  workspaceId: string
  layoutSessionBlock: Block
  getHash?: () => string
  pushHash?: (hash: string) => void
  replaceHash?: (hash: string) => void
  subscribeToUrl?: (listener: () => void) => Unsubscribe
}

const defaultGetHash = (): string => window.location.hash
const defaultPushHash = (hash: string): void => {
  window.history.pushState(null, '', preserveHashQueryParams(hash, window.location.hash))
}
const defaultReplaceHash = (hash: string): void => {
  window.history.replaceState(null, '', preserveHashQueryParams(hash, window.location.hash))
}
const defaultSubscribeToUrl = (listener: () => void): Unsubscribe => {
  window.addEventListener('hashchange', listener)
  window.addEventListener('popstate', listener)
  return () => {
    window.removeEventListener('hashchange', listener)
    window.removeEventListener('popstate', listener)
  }
}

export class PanelLayoutProjection {
  private readonly repo: Repo
  private readonly workspaceId: string
  private readonly layoutSessionBlock: Block
  private readonly getHash: () => string
  private readonly pushHash: (hash: string) => void
  private readonly replaceHash: (hash: string) => void
  private readonly subscribeToUrl: (listener: () => void) => Unsubscribe
  private readonly listeners = new CallbackSet<[]>('PanelLayoutProjection')
  private unsubscribeRows: Unsubscribe | null = null
  private unsubscribeUrl: Unsubscribe | null = null
  private inboundQueue: Promise<void> = Promise.resolve()
  private lastSlots: LayoutSlot[] = []

  constructor(options: PanelLayoutProjectionOptions) {
    this.repo = options.repo
    this.workspaceId = options.workspaceId
    this.layoutSessionBlock = options.layoutSessionBlock
    this.getHash = options.getHash ?? defaultGetHash
    this.pushHash = options.pushHash ?? defaultPushHash
    this.replaceHash = options.replaceHash ?? defaultReplaceHash
    this.subscribeToUrl = options.subscribeToUrl ?? defaultSubscribeToUrl
  }

  async start(): Promise<void> {
    if (this.unsubscribeRows || this.unsubscribeUrl) return
    const rowsHandle = this.layoutSessionBlock.repo.query.subtree({id: this.layoutSessionBlock.id})
    const initialRows = await rowsHandle.load()
    this.lastSlots = layoutSlotsFromRows(this.layoutSessionBlock.id, initialRows)
    this.unsubscribeRows = rowsHandle.subscribe(rows => {
      this.handleRowsChanged(rows)
    })
    this.unsubscribeUrl = this.subscribeToUrl(() => {
      void this.applyCurrentUrl()
    })
  }

  dispose(): void {
    this.unsubscribeRows?.()
    this.unsubscribeRows = null
    this.unsubscribeUrl?.()
    this.unsubscribeUrl = null
    this.listeners.clear()
  }

  subscribe(listener: () => void): Unsubscribe {
    return this.listeners.add(listener)
  }

  applyCurrentUrl(): Promise<void> {
    this.inboundQueue = this.inboundQueue
      .catch(() => {})
      .then(async () => {
        const result = await applyCurrentLayoutUrl({
          repo: this.repo,
          workspaceId: this.workspaceId,
          layoutSessionBlock: this.layoutSessionBlock,
          hash: this.getHash(),
          replaceHash: hash => {
            this.replaceHash(hash)
            this.listeners.notify()
          },
        })
        if (result.kind === 'applied' || result.kind === 'normalized' || result.kind === 'ignored') {
          this.listeners.notify()
        }
      })
    return this.inboundQueue
  }

  private handleRowsChanged(rows: readonly BlockData[]): void {
    const slots = layoutSlotsFromRows(this.layoutSessionBlock.id, rows)
    if (sameLayoutSlots(this.lastSlots, slots)) return
    this.lastSlots = slots

    const nextHash = buildLayoutFromSlots(this.workspaceId, slots)
    if (this.getHash() === nextHash) return
    this.pushHash(nextHash)
    this.listeners.notify()
  }
}
