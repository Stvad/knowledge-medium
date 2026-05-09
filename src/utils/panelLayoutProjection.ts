import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import type { BlockData, Tx, Unsubscribe } from '@/data/api'
import { ChangeScope } from '@/data/api'
import { PANEL_TYPE } from '@/data/blockTypes'
import {
  focusedBlockIdProp,
  topLevelBlockIdProp,
} from '@/data/properties'
import { keyAtEnd, keyBetween, keysBetween } from '@/data/orderKey'
import { buildLayout, parseLayout } from '@/utils/routing'
import { panelHistory } from '@/utils/panelHistory'

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

export const panelBlockId = (row: BlockData): string | undefined => {
  const stored = row.properties[topLevelBlockIdProp.name]
  if (stored === undefined) return undefined
  return topLevelBlockIdProp.codec.decode(stored)
}

export const panelBlockIds = (rows: readonly BlockData[]): string[] =>
  rows.map(panelBlockId).filter((id): id is string => Boolean(id))

const sameBlockIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index])

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
      [focusedBlockIdProp.name]: focusedBlockIdProp.codec.encode(args.blockId),
    },
  })
  await repo.addTypeInTx(tx, id, PANEL_TYPE)
  return id
}

export const insertPanelRow = async (
  repo: Repo,
  perTabBlock: Block,
  blockId: string,
  options: {afterPanelId?: string} = {},
): Promise<string> =>
  repo.tx(async tx => {
    const parent = await tx.get(perTabBlock.id)
    if (!parent) throw new Error(`insertPanelRow: per-tab block ${perTabBlock.id} not found`)

    const siblings = await tx.childrenOf(perTabBlock.id, parent.workspaceId)
    const sourceIndex = options.afterPanelId
      ? siblings.findIndex(row => row.id === options.afterPanelId)
      : -1
    const previous = sourceIndex >= 0 ? siblings[sourceIndex] : siblings.at(-1)
    const next = sourceIndex >= 0 ? siblings[sourceIndex + 1] : undefined
    const orderKey = sourceIndex >= 0
      ? keyBetween(previous?.orderKey ?? null, next?.orderKey ?? null)
      : keyAtEnd(previous?.orderKey ?? null)

    return createPanelRowInTx(repo, tx, {
      workspaceId: parent.workspaceId,
      parentId: perTabBlock.id,
      orderKey,
      blockId,
    })
  }, {scope: ChangeScope.UiState, description: 'insert panel row'})

export const reconcilePanelRows = async (
  repo: Repo,
  perTabBlock: Block,
  targetBlockIds: readonly string[],
): Promise<void> => {
  await repo.tx(async tx => {
    const parent = await tx.get(perTabBlock.id)
    if (!parent) throw new Error(`reconcilePanelRows: per-tab block ${perTabBlock.id} not found`)

    const currentRows = await tx.childrenOf(perTabBlock.id, parent.workspaceId)
    const currentSlots = currentRows.map(row => ({row, blockId: panelBlockId(row)}))
    if (sameBlockIds(panelBlockIds(currentRows), targetBlockIds)) return

    const {rowsByTargetIndex, rowsToDelete} = planReconciliation(currentSlots, targetBlockIds)
    const orderKeys = keysBetween(null, null, targetBlockIds.length)

    for (const slot of rowsToDelete) {
      panelHistory.clear(slot.row.id)
      await tx.delete(slot.row.id)
    }

    for (let index = 0; index < targetBlockIds.length; index++) {
      const blockId = targetBlockIds[index]
      const orderKey = orderKeys[index]
      const slot = rowsByTargetIndex.get(index)
      if (!slot) {
        await createPanelRowInTx(repo, tx, {
          workspaceId: parent.workspaceId,
          parentId: perTabBlock.id,
          orderKey,
          blockId,
        })
        continue
      }

      if (slot.row.orderKey !== orderKey || slot.row.parentId !== perTabBlock.id) {
        await tx.move(slot.row.id, {parentId: perTabBlock.id, orderKey})
      }
      if (slot.blockId !== blockId) {
        const restored = slot.blockId
          ? panelHistory.reconcileUrlNavigation(slot.row.id, {
            blockId: slot.blockId,
            state: panelHistory.snapshot(slot.row.id),
          }, blockId)
          : null
        panelHistory.enqueueRestore(slot.row.id, restored?.state)
        await tx.setProperty(slot.row.id, topLevelBlockIdProp, blockId)
        await tx.setProperty(slot.row.id, focusedBlockIdProp, restored?.state?.focusedBlockId ?? blockId)
      }
    }
  }, {scope: ChangeScope.UiState, description: 'reconcile panel layout from URL'})
}

export interface ApplyCurrentLayoutUrlArgs {
  repo: Repo
  workspaceId: string
  perTabBlock: Block
  hash?: string
  replaceHash?: (hash: string) => void
}

export const applyCurrentLayoutUrl = async ({
  repo,
  workspaceId,
  perTabBlock,
  hash = typeof window === 'undefined' ? '' : window.location.hash,
  replaceHash,
}: ApplyCurrentLayoutUrlArgs): Promise<ApplyLayoutResult> => {
  const route = parseLayout(hash)
  if (route.workspaceId && route.workspaceId !== workspaceId) {
    return {kind: 'ignored'}
  }

  const currentRows = await perTabBlock.children.load()
  const currentBlockIds = panelBlockIds(currentRows)

  if (route.blockIds.length === 0) {
    if (currentBlockIds.length > 0) {
      replaceHash?.(buildLayout(workspaceId, currentBlockIds))
      return {kind: 'normalized'}
    }
    return {kind: 'empty'}
  }

  if (sameBlockIds(currentBlockIds, route.blockIds)) {
    return {kind: 'noop'}
  }

  await reconcilePanelRows(repo, perTabBlock, route.blockIds)
  return {kind: 'applied'}
}

export interface PanelLayoutProjectionOptions {
  repo: Repo
  workspaceId: string
  perTabBlock: Block
  getHash?: () => string
  pushHash?: (hash: string) => void
  replaceHash?: (hash: string) => void
  subscribeToUrl?: (listener: () => void) => Unsubscribe
}

const defaultGetHash = (): string => window.location.hash
const defaultPushHash = (hash: string): void => {
  window.history.pushState(null, '', hash)
}
const defaultReplaceHash = (hash: string): void => {
  window.history.replaceState(null, '', hash)
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
  private readonly perTabBlock: Block
  private readonly getHash: () => string
  private readonly pushHash: (hash: string) => void
  private readonly replaceHash: (hash: string) => void
  private readonly subscribeToUrl: (listener: () => void) => Unsubscribe
  private readonly listeners = new Set<() => void>()
  private unsubscribeRows: Unsubscribe | null = null
  private unsubscribeUrl: Unsubscribe | null = null
  private inboundQueue: Promise<void> = Promise.resolve()
  private lastBlockIds: string[] = []

  constructor(options: PanelLayoutProjectionOptions) {
    this.repo = options.repo
    this.workspaceId = options.workspaceId
    this.perTabBlock = options.perTabBlock
    this.getHash = options.getHash ?? defaultGetHash
    this.pushHash = options.pushHash ?? defaultPushHash
    this.replaceHash = options.replaceHash ?? defaultReplaceHash
    this.subscribeToUrl = options.subscribeToUrl ?? defaultSubscribeToUrl
  }

  async start(): Promise<void> {
    if (this.unsubscribeRows || this.unsubscribeUrl) return
    const rowsHandle = this.perTabBlock.children
    const initialRows = await rowsHandle.load()
    this.lastBlockIds = panelBlockIds(initialRows)
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
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  applyCurrentUrl(): Promise<void> {
    this.inboundQueue = this.inboundQueue
      .catch(() => {})
      .then(async () => {
        const result = await applyCurrentLayoutUrl({
          repo: this.repo,
          workspaceId: this.workspaceId,
          perTabBlock: this.perTabBlock,
          hash: this.getHash(),
          replaceHash: hash => {
            this.replaceHash(hash)
            this.notify()
          },
        })
        if (result.kind === 'applied' || result.kind === 'normalized') {
          this.notify()
        }
      })
    return this.inboundQueue
  }

  private handleRowsChanged(rows: readonly BlockData[]): void {
    const blockIds = panelBlockIds(rows)
    if (sameBlockIds(this.lastBlockIds, blockIds)) return
    this.lastBlockIds = blockIds

    const nextHash = buildLayout(this.workspaceId, blockIds)
    if (this.getHash() === nextHash) return
    this.pushHash(nextHash)
    this.notify()
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
