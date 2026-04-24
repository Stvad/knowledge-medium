import { v4 as uuidv4 } from 'uuid'
import { PowerSyncDatabase } from '@powersync/web'
import { Block } from '@/data/block'
import type { BlockData, User } from '@/types'
import { UndoRedoManager, UndoRedoOptions } from '@/data/undoRedo.ts'
import { BlockStorage } from '@/data/blockStorage'
import type { WriteEventContext } from '@/data/blockStorage'

export type { BlockRow } from '@/data/blockSchema'
export { parseBlockRow } from '@/data/blockSchema'

const cloneBlockData = (blockData: BlockData) => structuredClone(blockData)

const blockFingerprint = (blockData: BlockData | undefined) =>
  blockData ? JSON.stringify(blockData) : ''

export class Repo {
  static nextInstanceId = 1

  private readonly storage: BlockStorage
  private readonly blockCache = new Map<string, Block>()
  private readonly snapshotCache = new Map<string, BlockData>()
  private readonly snapshotRevisions = new Map<string, number>()
  private readonly snapshotListeners = new Map<string, Set<() => void>>()
  private readonly dirtyBlockIds = new Set<string>()
  private readonly pendingLoads = new Map<string, Promise<BlockData | undefined>>()
  private lastProcessedBlockEventSeq = 0
  readonly instanceId = Repo.nextInstanceId++

  constructor(
    readonly db: PowerSyncDatabase,
    readonly undoRedoManager: UndoRedoManager,
    readonly currentUser: User,
  ) {
    this.storage = new BlockStorage(db)

    this.undoRedoManager.setApplier((changes) => {
      this.applySnapshots(changes)
    })

    void this.startReactiveBlockTracking()
  }

  find(id: string): Block {
    if (!id) throw new Error('Invalid block id')

    const cachedBlock = this.blockCache.get(id)
    if (cachedBlock) {
      return cachedBlock
    }

    const block = new Block(this, this.undoRedoManager, id, this.currentUser)
    this.blockCache.set(id, block)
    return block
  }

  async exists(id: string) {
    if (this.snapshotCache.has(id)) return true
    return this.storage.existsBlock(id)
  }

  async findFirstRootBlockId() {
    return this.storage.findFirstRootId()
  }

  create(data: Partial<BlockData>): Block {
    const id = uuidv4()
    const createTime = data.createTime ?? Date.now()
    const snapshot: BlockData = {
      id,
      content: data.content ?? '',
      properties: structuredClone(data.properties ?? {}),
      childIds: [...(data.childIds ?? [])],
      createTime,
      updateTime: data.updateTime ?? createTime,
      createdByUserId: data.createdByUserId ?? this.currentUser.id,
      updatedByUserId: data.updatedByUserId ?? this.currentUser.id,
      references: structuredClone(data.references ?? []),
      ...(data.parentId ? {parentId: data.parentId} : {}),
    }

    const eventContext: WriteEventContext = {
      actorUserId: snapshot.updatedByUserId,
      source: 'local',
      txId: this.undoRedoManager.getCurrentTransactionId() ?? uuidv4(),
    }

    this.markBlockDirty(id)
    this.setCachedBlockData(snapshot)
    this.storage.enqueueUpsert(snapshot, eventContext)
    return this.find(id)
  }

  async loadBlockData(id: string) {
    const cached = this.snapshotCache.get(id)
    if (cached) return cached

    const pendingLoad = this.pendingLoads.get(id)
    if (pendingLoad) return pendingLoad

    const loadPromise = this.storage.loadBlock(id)
      .then((snapshot) => {
        if (!snapshot) return undefined

        this.hydrateBlockData(snapshot)
        return this.snapshotCache.get(id)
      })
      .finally(() => {
        this.pendingLoads.delete(id)
      })

    this.pendingLoads.set(id, loadPromise)
    return loadPromise
  }

  async getSubtreeBlockData(
    rootId: string,
    options: {includeRoot?: boolean} = {},
  ) {
    const includeRoot = options.includeRoot ?? false
    await this.flush()

    const snapshots = await this.storage.loadSubtree(rootId, includeRoot)
    return this.hydrateSnapshots(snapshots)
  }

  async getSubtreeBlocks(
    rootId: string,
    options: {includeRoot?: boolean} = {},
  ) {
    const snapshots = await this.getSubtreeBlockData(rootId, options)
    return snapshots.map(snapshot => this.find(snapshot.id))
  }

  async getBlockDataAt(id: string, timestamp: number) {
    return this.storage.getBlockStateAt(id, timestamp)
  }

  async getSubtreeBlockDataAt(
    rootId: string,
    timestamp: number,
    options: {includeRoot?: boolean} = {},
  ) {
    const includeRoot = options.includeRoot ?? false
    const snapshots = await this.storage.getAllBlockStatesAt(timestamp)

    const snapshotsById = new Map(snapshots.map(snapshot => [snapshot.id, snapshot]))
    const rootSnapshot = snapshotsById.get(rootId)

    if (!rootSnapshot) return []

    const pendingIds = includeRoot ? [rootId] : [...rootSnapshot.childIds]
    const result: BlockData[] = []
    const visited = new Set<string>()

    while (pendingIds.length) {
      const currentId = pendingIds.shift()!
      if (visited.has(currentId)) continue
      visited.add(currentId)

      const snapshot = snapshotsById.get(currentId)
      if (!snapshot) continue

      result.push(cloneBlockData(snapshot))
      pendingIds.unshift(...snapshot.childIds)
    }

    return result
  }

  async findBlocksByTypeInSubtree(rootId: string, type: string) {
    await this.flush()

    const snapshots = await this.storage.findBlocksByTypeInSubtree(rootId, type)
    return this.hydrateSnapshots(snapshots)
  }

  async getAliasesInSubtree(rootId: string, filter: string = '') {
    await this.flush()
    return this.storage.getAliasesInSubtree(rootId, filter)
  }

  async findBlockByAliasInSubtree(rootId: string, alias: string) {
    if (!alias) return null

    await this.flush()

    const snapshot = await this.storage.findBlockByAliasInSubtree(rootId, alias)
    if (!snapshot) return null

    this.hydrateBlockData(snapshot)
    return this.find(snapshot.id)
  }

  async findFirstChildByContent(parentId: string, content: string) {
    await this.flush()

    const snapshot = await this.storage.findFirstChildByContent(parentId, content)
    if (!snapshot) return null

    this.hydrateBlockData(snapshot)
    return this.find(snapshot.id)
  }

  getCachedBlockData(id: string) {
    return this.snapshotCache.get(id)
  }

  requireCachedBlockData(id: string) {
    const snapshot = this.snapshotCache.get(id)
    if (!snapshot) {
      throw new Error(`Block is not loaded yet: ${id}`)
    }
    return snapshot
  }

  subscribeToBlock(id: string, listener: () => void) {
    let listeners = this.snapshotListeners.get(id)
    if (!listeners) {
      listeners = new Set()
      this.snapshotListeners.set(id, listeners)
    }
    listeners.add(listener)

    return () => {
      listeners?.delete(listener)
      if (listeners?.size === 0) {
        this.snapshotListeners.delete(id)
      }
    }
  }

  getBlockRevision(id: string) {
    return this.snapshotRevisions.get(id) ?? 0
  }

  isBlockDirty(id: string) {
    return this.dirtyBlockIds.has(id)
  }

  hydrateBlockData(snapshot: BlockData) {
    const existing = this.snapshotCache.get(snapshot.id)

    if (this.dirtyBlockIds.has(snapshot.id)) {
      if (existing && blockFingerprint(existing) !== blockFingerprint(snapshot)) {
        return
      }
      this.dirtyBlockIds.delete(snapshot.id)
    }

    this.setCachedBlockData(snapshot)
  }

  applyBlockChange(
    id: string,
    callback: (doc: BlockData) => void,
    options: UndoRedoOptions<BlockData> = {},
  ) {
    const current = cloneBlockData(this.requireCachedBlockData(id))
    const next = cloneBlockData(current)

    callback(next)
    next.id = id

    if (!options.skipMetadataUpdate) {
      next.updateTime = Date.now()
      next.updatedByUserId = this.currentUser.id
    }

    const eventContext: WriteEventContext = {
      actorUserId: next.updatedByUserId,
      source: 'local',
      txId: this.undoRedoManager.getCurrentTransactionId() ?? uuidv4(),
    }

    this.undoRedoManager.recordChange(id, current, next, options)
    this.markBlockDirty(id)
    this.setCachedBlockData(next)
    this.storage.enqueueUpsert(next, eventContext)
  }

  applySnapshots(changes: Array<{id: string, snapshot: BlockData | null}>) {
    const txId = uuidv4()

    for (const change of changes) {
      const eventContext: WriteEventContext = {
        actorUserId: change.snapshot?.updatedByUserId ?? this.currentUser.id,
        source: 'local',
        txId,
      }

      this.markBlockDirty(change.id)
      if (change.snapshot) {
        this.setCachedBlockData(change.snapshot)
        this.storage.enqueueUpsert(change.snapshot, eventContext)
      } else {
        this.deleteCachedBlockData(change.id)
        this.storage.enqueueDelete(change.id, eventContext)
      }
    }
  }

  async flush() {
    await this.storage.flush()
  }

  private setCachedBlockData(snapshot: BlockData) {
    const next = cloneBlockData(snapshot)
    const existing = this.snapshotCache.get(snapshot.id)

    if (existing && blockFingerprint(existing) === blockFingerprint(next)) {
      return
    }

    this.snapshotCache.set(snapshot.id, next)
    this.snapshotRevisions.set(snapshot.id, this.getBlockRevision(snapshot.id) + 1)
    this.blockCache.set(snapshot.id, this.blockCache.get(snapshot.id) ?? new Block(this, this.undoRedoManager, snapshot.id, this.currentUser))
    this.snapshotListeners.get(snapshot.id)?.forEach(listener => listener())
  }

  private deleteCachedBlockData(id: string) {
    const hadSnapshot = this.snapshotCache.delete(id)
    if (!hadSnapshot) return

    this.snapshotRevisions.set(id, this.getBlockRevision(id) + 1)
    this.snapshotListeners.get(id)?.forEach(listener => listener())
  }

  private markBlockDirty(id: string) {
    this.dirtyBlockIds.add(id)
  }

  private hydrateSnapshots(snapshots: BlockData[]) {
    return snapshots.map(snapshot => {
      this.hydrateBlockData(snapshot)
      return this.requireCachedBlockData(snapshot.id)
    })
  }

  private async refreshTrackedBlocksFromEventLog() {
    const events = await this.storage.getEventsAfter(this.lastProcessedBlockEventSeq)
    if (!events.length) return

    this.lastProcessedBlockEventSeq = events[events.length - 1].seq

    const trackedIds = new Set([
      ...this.snapshotListeners.keys(),
      ...this.dirtyBlockIds,
    ])
    if (!trackedIds.size) return

    const changedIds = Array.from(new Set(
      events
        .map(event => event.blockId)
        .filter(blockId => trackedIds.has(blockId)),
    ))
    if (!changedIds.length) return

    const snapshotsById = await this.storage.loadBlocksByIds(changedIds)

    for (const id of changedIds) {
      const snapshot = snapshotsById.get(id)

      if (snapshot) {
        this.hydrateBlockData(snapshot)
      } else {
        if (this.dirtyBlockIds.has(id) && this.snapshotCache.has(id)) {
          continue
        }

        this.dirtyBlockIds.delete(id)
        this.deleteCachedBlockData(id)
      }
    }
  }

  private async startReactiveBlockTracking() {
    try {
      this.lastProcessedBlockEventSeq = await this.storage.getMaxEventSeq()

      this.storage.trackBlockEvents({
        onChange: async () => {
          await this.refreshTrackedBlocksFromEventLog()
        },
        onError: (error) => {
          console.error('Failed to process reactive block change', error)
        },
      })

      await this.refreshTrackedBlocksFromEventLog()
    } catch (error) {
      console.error('Failed to start reactive block tracking', error)
    }
  }
}
