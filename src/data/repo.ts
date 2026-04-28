import { v4 as uuidv4 } from 'uuid'
import { PowerSyncDatabase } from '@powersync/web'
import { Block } from '@/data/block'
import type { BlockData, User } from '@/types'
import { UndoRedoManager, UndoRedoOptions } from '@/data/undoRedo.ts'
import { BlockStorage } from '@/data/blockStorage'
import type { WriteEventContext } from '@/data/blockStorage'
import { BlockCache } from '@/data/blockCache'
import { uiChangeScope } from '@/data/properties.ts'

export type { BlockRow } from '@/data/blockSchema'
export { parseBlockRow } from '@/data/blockSchema'

const cloneBlockData = (blockData: BlockData) => structuredClone(blockData)

export class Repo {
  static nextInstanceId = 1

  private readonly storage: BlockStorage
  private readonly cache = new BlockCache()
  private readonly blockCache = new Map<string, Block>()
  private lastProcessedBlockEventSeq = 0
  private _activeWorkspaceId: string | null = null
  private _isReadOnly = false
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

  get activeWorkspaceId(): string | null {
    return this._activeWorkspaceId
  }

  setActiveWorkspaceId(workspaceId: string | null): void {
    this._activeWorkspaceId = workspaceId
  }

  get isReadOnly(): boolean {
    return this._isReadOnly
  }

  // Toggle when the active workspace's role for the current user is 'viewer'.
  // While true, only writes scoped to uiChangeScope are accepted; they're
  // routed to the ephemeral source so the powersync_crud trigger skips them
  // (see repoInstance.ts) — they live in local SQLite for the session and
  // disappear on reload because they never enter ps_oplog. Other-scope writes
  // throw to surface UI gating bugs loudly.
  setReadOnly(readOnly: boolean): void {
    this._isReadOnly = readOnly
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
    if (this.cache.hasSnapshot(id)) return true
    return this.storage.existsBlock(id)
  }

  async findFirstRootBlockId(workspaceId: string) {
    return this.storage.findFirstRootId(workspaceId)
  }

  create(data: Partial<BlockData>, options: {scope?: string} = {}): Block {
    const id = data.id ?? uuidv4()
    const createTime = data.createTime ?? Date.now()
    const workspaceId = data.workspaceId ?? this._activeWorkspaceId
    if (!workspaceId) {
      throw new Error(
        'Cannot create block: provide workspaceId or call repo.setActiveWorkspaceId() first',
      )
    }

    if (this._isReadOnly && options.scope !== uiChangeScope) {
      // Surface as a warning rather than crashing — the line between UI and
      // content writes isn't always crisp (e.g. typeProp / load-time props
      // are shared between panel infra and content), so a missing scope on a
      // non-malicious caller shouldn't take down the app. The write still
      // gets routed to ephemeral source below, so it never escapes locally.
      console.warn(
        `[readonly] create with non-ui scope '${options.scope ?? 'default'}' — routing to ephemeral. Tag the call site with uiChangeScope if it's UI state.`,
      )
    }

    const snapshot: BlockData = {
      id,
      workspaceId,
      content: data.content ?? '',
      properties: structuredClone(data.properties ?? {}),
      childIds: [...(data.childIds ?? [])],
      createTime,
      updateTime: data.updateTime ?? createTime,
      createdByUserId: data.createdByUserId ?? this.currentUser.id,
      updatedByUserId: data.updatedByUserId ?? this.currentUser.id,
      references: structuredClone(data.references ?? []),
      deleted: data.deleted ?? false,
      ...(data.parentId ? {parentId: data.parentId} : {}),
    }

    const eventContext: WriteEventContext = {
      actorUserId: snapshot.updatedByUserId,
      source: this._isReadOnly ? 'local-ephemeral' : 'local',
      txId: this.undoRedoManager.getCurrentTransactionId() ?? uuidv4(),
    }

    this.cache.markDirty(id)
    this.cache.setSnapshot(snapshot)
    this.storage.enqueueUpsert(snapshot, eventContext)
    return this.find(id)
  }

  async loadBlockData(id: string) {
    const cached = this.cache.getSnapshot(id)
    if (cached) return cached

    return this.cache.dedupLoad(id, async () => {
      const snapshot = await this.storage.loadBlock(id)
      if (!snapshot) return undefined
      this.cache.hydrate(snapshot)
      return this.cache.getSnapshot(id)
    })
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

  async findBacklinks(workspaceId: string, targetId: string) {
    if (!targetId) return []

    await this.flush()

    const snapshots = await this.storage.findBacklinks(workspaceId, targetId)
    return this.hydrateSnapshots(snapshots).map(snapshot => this.find(snapshot.id))
  }

  async findBlocksByType(workspaceId: string, type: string) {
    await this.flush()

    const snapshots = await this.storage.findBlocksByType(workspaceId, type)
    return this.hydrateSnapshots(snapshots)
  }

  async getAliasesInWorkspace(workspaceId: string, filter: string = '') {
    await this.flush()
    return this.storage.getAliasesInWorkspace(workspaceId, filter)
  }

  async findBlockByAliasInWorkspace(workspaceId: string, alias: string) {
    if (!alias) return null

    await this.flush()

    const snapshot = await this.storage.findBlockByAliasInWorkspace(workspaceId, alias)
    if (!snapshot) return null

    this.cache.hydrate(snapshot)
    return this.find(snapshot.id)
  }

  async searchBlocksByContent(workspaceId: string, query: string, limit: number = 50) {
    if (!query) return []

    await this.flush()

    const snapshots = await this.storage.searchBlocksByContent(workspaceId, query, limit)
    return this.hydrateSnapshots(snapshots).map(snapshot => this.find(snapshot.id))
  }

  async findAliasMatchesInWorkspace(workspaceId: string, filter: string, limit: number = 50) {
    await this.flush()
    return this.storage.findAliasMatchesInWorkspace(workspaceId, filter, limit)
  }

  async findFirstChildByContent(parentId: string, content: string) {
    await this.flush()

    const snapshot = await this.storage.findFirstChildByContent(parentId, content)
    if (!snapshot) return null

    this.cache.hydrate(snapshot)
    return this.find(snapshot.id)
  }

  getCachedBlockData(id: string) {
    return this.cache.getSnapshot(id)
  }

  requireCachedBlockData(id: string) {
    return this.cache.requireSnapshot(id)
  }

  subscribeToBlock(id: string, listener: () => void) {
    return this.cache.subscribe(id, listener)
  }

  hydrateBlockData(snapshot: BlockData) {
    this.cache.hydrate(snapshot)
  }

  applyBlockChange(
    id: string,
    callback: (doc: BlockData) => void,
    options: UndoRedoOptions<BlockData> = {},
  ) {
    if (this._isReadOnly && options.scope !== uiChangeScope) {
      // See create() — warn but don't throw. The write still goes ephemeral
      // (via the source flag below + skipUndo) so nothing escapes locally.
      console.warn(
        `[readonly] applyBlockChange with non-ui scope '${options.scope ?? 'default'}' — routing to ephemeral. Tag the call site with uiChangeScope if it's UI state.`,
      )
    }

    const current = this.cache.requireSnapshot(id)
    const next = structuredClone(current)

    callback(next)
    next.id = id

    // workspace_id is immutable on the server (blocks_prevent_workspace_change_trg).
    // Defensively reject local mutations that would change it so the PowerSync
    // upload queue doesn't get stuck retrying a doomed PATCH.
    if (next.workspaceId !== current.workspaceId) {
      throw new Error(
        `Cannot change workspaceId of an existing block (${current.workspaceId} -> ${next.workspaceId})`,
      )
    }

    if (!options.skipMetadataUpdate) {
      next.updateTime = Date.now()
      next.updatedByUserId = this.currentUser.id
    }

    const eventContext: WriteEventContext = {
      actorUserId: next.updatedByUserId,
      source: this._isReadOnly ? 'local-ephemeral' : 'local',
      txId: this.undoRedoManager.getCurrentTransactionId() ?? uuidv4(),
    }

    // Skip undo for ephemeral writes. The undo path would replay through
    // applySnapshots with source='local', re-entering the upload queue and
    // defeating the gate.
    const recordOptions = this._isReadOnly ? {...options, skipUndo: true} : options
    this.undoRedoManager.recordChange(id, current, next, recordOptions)
    this.cache.markDirty(id)
    this.cache.setSnapshot(next)
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

      this.cache.markDirty(change.id)
      if (change.snapshot) {
        this.cache.setSnapshot(change.snapshot)
        this.storage.enqueueUpsert(change.snapshot, eventContext)
      } else {
        this.cache.deleteSnapshot(change.id)
        this.storage.enqueueDelete(change.id, eventContext)
      }
    }
  }

  async flush() {
    await this.storage.flush()
  }

  private hydrateSnapshots(snapshots: BlockData[]) {
    return snapshots.map(snapshot => {
      this.cache.hydrate(snapshot)
      return this.cache.requireSnapshot(snapshot.id)
    })
  }

  private async refreshTrackedBlocksFromEventLog() {
    const events = await this.storage.getEventsAfter(this.lastProcessedBlockEventSeq)
    if (!events.length) return

    this.lastProcessedBlockEventSeq = events[events.length - 1].seq

    const trackedIds = this.cache.trackedIds()
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
        this.cache.hydrate(snapshot)
      } else {
        if (this.cache.isDirty(id) && this.cache.hasSnapshot(id)) {
          continue
        }

        this.cache.clearDirty(id)
        this.cache.deleteSnapshot(id)
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
