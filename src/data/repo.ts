import { v4 as uuidv4 } from 'uuid'
import { PowerSyncDatabase } from '@powersync/web'
import { Block } from '@/data/block'
import { BlockData, BlockProperties, User } from '@/types'
import { UndoRedoManager, UndoRedoOptions } from '@/data/undoRedo.ts'

export interface BlockRow {
  id: string
  content: string
  properties_json: string
  child_ids_json: string
  parent_id: string | null
  create_time: number
  update_time: number
  created_by_user_id: string
  updated_by_user_id: string
  references_json: string
}

const SELECT_BLOCK_COLUMNS = `
  id,
  content,
  properties_json,
  child_ids_json,
  parent_id,
  create_time,
  update_time,
  created_by_user_id,
  updated_by_user_id,
  references_json
`

const SELECT_BLOCK_SQL = `
  SELECT
    ${SELECT_BLOCK_COLUMNS}
  FROM blocks
  WHERE id = ?
`

const UPSERT_BLOCK_SQL = `
  INSERT INTO blocks (
    id,
    content,
    properties_json,
    child_ids_json,
    parent_id,
    create_time,
    update_time,
    created_by_user_id,
    updated_by_user_id,
    references_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    content = excluded.content,
    properties_json = excluded.properties_json,
    child_ids_json = excluded.child_ids_json,
    parent_id = excluded.parent_id,
    create_time = excluded.create_time,
    update_time = excluded.update_time,
    created_by_user_id = excluded.created_by_user_id,
    updated_by_user_id = excluded.updated_by_user_id,
    references_json = excluded.references_json
`

const safeJsonParse = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback

  try {
    return JSON.parse(value) as T
  } catch (error) {
    console.warn('Failed to parse stored block JSON', error)
    return fallback
  }
}

const cloneBlockData = (blockData: BlockData) => structuredClone(blockData)

const blockFingerprint = (blockData: BlockData | undefined) =>
  blockData ? JSON.stringify(blockData) : ''

export const parseBlockRow = (row: BlockRow): BlockData => ({
  id: row.id,
  content: row.content,
  properties: safeJsonParse<BlockProperties>(row.properties_json, {}),
  childIds: safeJsonParse<string[]>(row.child_ids_json, []),
  parentId: row.parent_id ?? undefined,
  createTime: row.create_time,
  updateTime: row.update_time,
  createdByUserId: row.created_by_user_id,
  updatedByUserId: row.updated_by_user_id,
  references: safeJsonParse<Array<{id: string, alias: string}>>(row.references_json, []),
})

const blockToRowParams = (blockData: BlockData) => [
  blockData.id,
  blockData.content,
  JSON.stringify(blockData.properties ?? {}),
  JSON.stringify(blockData.childIds ?? []),
  blockData.parentId ?? null,
  blockData.createTime,
  blockData.updateTime,
  blockData.createdByUserId,
  blockData.updatedByUserId,
  JSON.stringify(blockData.references ?? []),
]

const buildSelectBlocksByIdsSql = (count: number) => `
  SELECT
    ${SELECT_BLOCK_COLUMNS}
  FROM blocks
  WHERE id IN (${Array.from({length: count}, () => '?').join(', ')})
`

export class Repo {
  private readonly blockCache = new Map<string, Block>()
  private readonly snapshotCache = new Map<string, BlockData>()
  private readonly snapshotRevisions = new Map<string, number>()
  private readonly snapshotListeners = new Map<string, Set<() => void>>()
  private readonly dirtyBlockIds = new Set<string>()
  private readonly pendingLoads = new Map<string, Promise<BlockData | undefined>>()
  private writeQueue = Promise.resolve()

  constructor(
    readonly db: PowerSyncDatabase,
    readonly undoRedoManager: UndoRedoManager,
    readonly currentUser: User,
  ) {
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

    const row = await this.db.getOptional<{id: string}>(
      'SELECT id FROM blocks WHERE id = ? LIMIT 1',
      [id],
    )
    return Boolean(row)
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

    this.markBlockDirty(id)
    this.setCachedBlockData(snapshot)
    this.queueUpsert(snapshot)
    return this.find(id)
  }

  async loadBlockData(id: string) {
    const cached = this.snapshotCache.get(id)
    if (cached) return cached

    const pendingLoad = this.pendingLoads.get(id)
    if (pendingLoad) return pendingLoad

    const loadPromise = this.db.getOptional<BlockRow>(SELECT_BLOCK_SQL, [id])
      .then((row) => {
        if (!row) return undefined

        const snapshot = parseBlockRow(row)
        this.hydrateBlockData(snapshot)
        return this.snapshotCache.get(id)
      })
      .finally(() => {
        this.pendingLoads.delete(id)
      })

    this.pendingLoads.set(id, loadPromise)
    return loadPromise
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

    this.undoRedoManager.recordChange(id, current, next, options)
    this.markBlockDirty(id)
    this.setCachedBlockData(next)
    this.queueUpsert(next)
  }

  applySnapshots(changes: Array<{id: string, snapshot: BlockData | null}>) {
    for (const change of changes) {
      this.markBlockDirty(change.id)
      if (change.snapshot) {
        this.setCachedBlockData(change.snapshot)
        this.queueUpsert(change.snapshot)
      } else {
        this.deleteCachedBlockData(change.id)
        this.queueDelete(change.id)
      }
    }
  }

  async flush() {
    await this.writeQueue
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

  private queueUpsert(snapshot: BlockData) {
    const next = cloneBlockData(snapshot)
    this.writeQueue = this.writeQueue
      .then(async () => {
        await this.db.execute(UPSERT_BLOCK_SQL, blockToRowParams(next))
      })
      .catch((error) => {
        console.error(`Failed to persist block ${next.id}`, error)
      })
  }

  private queueDelete(id: string) {
    this.writeQueue = this.writeQueue
      .then(async () => {
        await this.db.execute('DELETE FROM blocks WHERE id = ?', [id])
      })
      .catch((error) => {
        console.error(`Failed to delete block ${id}`, error)
      })
  }

  private startReactiveBlockTracking() {
    try {
      this.db.onChange({
        onChange: async () => {
          const dirtyIds = Array.from(this.dirtyBlockIds)
          if (!dirtyIds.length) return

          const rows = await this.db.getAll<BlockRow>(
            buildSelectBlocksByIdsSql(dirtyIds.length),
            dirtyIds,
          )
          const rowsById = new Map(rows.map(row => [row.id, row]))

          for (const id of dirtyIds) {
            const row = rowsById.get(id)

            if (row) {
              this.hydrateBlockData(parseBlockRow(row))
            } else {
              this.dirtyBlockIds.delete(id)
              this.deleteCachedBlockData(id)
            }
          }
        },
        onError: (error) => {
          console.error('Failed to process reactive block change', error)
        },
      }, {
        tables: ['blocks'],
        throttleMs: 16,
      })
    } catch (error) {
      console.error('Failed to start reactive block tracking', error)
    }
  }
}
