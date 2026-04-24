import { v4 as uuidv4 } from 'uuid'
import { PowerSyncDatabase } from '@powersync/web'
import { Block } from '@/data/block'
import type { BlockData, User } from '@/types'
import { UndoRedoManager, UndoRedoOptions } from '@/data/undoRedo.ts'
import {
  SELECT_BLOCK_COLUMNS_SQL,
  UPSERT_BLOCK_SQL,
  blockToRowParams,
  buildQualifiedBlockColumnsSql,
  parseBlockRow,
  parseBlockSnapshotJson,
} from '@/data/blockStorage'
import type { BlockRow } from '@/data/blockStorage'

export type { BlockRow } from '@/data/blockStorage'
export { parseBlockRow } from '@/data/blockStorage'

interface BlockEventChangeRow {
  seq: number
  blockId: string
}

interface BlockEventStateRow {
  afterJson: string | null
}

interface WriteEventContext {
  actorUserId?: string
  source: 'local' | 'system'
  txId: string
}

const SELECT_BLOCK_SQL = `
  SELECT
    ${SELECT_BLOCK_COLUMNS_SQL}
  FROM blocks
  WHERE id = ?
`

const SELECT_BLOCK_EVENTS_AFTER_SQL = `
  SELECT
    seq,
    block_id AS blockId
  FROM block_events
  WHERE seq > ?
  ORDER BY seq ASC
`

const SELECT_MAX_BLOCK_EVENT_SEQ_SQL = `
  SELECT
    COALESCE(MAX(seq), 0) AS seq
  FROM block_events
`

const SELECT_BLOCK_STATE_AT_SQL = `
  SELECT
    after_json AS afterJson
  FROM block_events
  WHERE block_id = ?
    AND event_time <= ?
  ORDER BY seq DESC
  LIMIT 1
`

const SELECT_ALL_BLOCK_STATES_AT_SQL = `
  WITH latest AS (
    SELECT
      block_id,
      MAX(seq) AS seq
    FROM block_events
    WHERE event_time <= ?
    GROUP BY block_id
  )
  SELECT
    block_events.after_json AS afterJson
  FROM latest
  JOIN block_events ON block_events.seq = latest.seq
  WHERE block_events.after_json IS NOT NULL
`

const cloneBlockData = (blockData: BlockData) => structuredClone(blockData)

const blockFingerprint = (blockData: BlockData | undefined) =>
  blockData ? JSON.stringify(blockData) : ''

const buildSelectBlocksByIdsSql = (count: number) => `
  SELECT
    ${SELECT_BLOCK_COLUMNS_SQL}
  FROM blocks
  WHERE id IN (${Array.from({length: count}, () => '?').join(', ')})
`

const SUBTREE_CTE_SQL = `
  WITH RECURSIVE subtree(id, sort_key, visited_path) AS (
    SELECT
      id,
      '' AS sort_key,
      ',' || id || ',' AS visited_path
    FROM blocks
    WHERE id = ?

    UNION ALL

    SELECT
      child.id,
      subtree.sort_key || printf('%08d.', CAST(child_order.key AS INTEGER)) AS sort_key,
      subtree.visited_path || child.id || ','
    FROM subtree
    JOIN blocks AS parent ON parent.id = subtree.id
    JOIN json_each(parent.child_ids_json) AS child_order
    JOIN blocks AS child ON child.id = child_order.value
    WHERE instr(subtree.visited_path, ',' || child.id || ',') = 0
  )
`

const buildSelectSubtreeBlocksSql = (includeRoot: boolean) => `
  ${SUBTREE_CTE_SQL}
  SELECT
    ${buildQualifiedBlockColumnsSql('blocks')}
  FROM blocks
  JOIN subtree ON subtree.id = blocks.id
  ${includeRoot ? '' : 'WHERE blocks.id != ?'}
  ORDER BY subtree.sort_key
`

const SELECT_ALIASES_IN_SUBTREE_SQL = `
  ${SUBTREE_CTE_SQL}
  SELECT
    alias.value AS alias,
    MIN(subtree.sort_key) AS first_sort_key
  FROM blocks
  JOIN subtree ON subtree.id = blocks.id
  JOIN json_each(blocks.properties_json, '$.alias.value') AS alias
  WHERE (? = '' OR LOWER(alias.value) LIKE '%' || LOWER(?) || '%')
  GROUP BY alias.value
  ORDER BY first_sort_key, alias.value
`

const SELECT_BLOCK_BY_ALIAS_IN_SUBTREE_SQL = `
  ${SUBTREE_CTE_SQL}
  SELECT
    ${buildQualifiedBlockColumnsSql('blocks')}
  FROM blocks
  JOIN subtree ON subtree.id = blocks.id
  JOIN json_each(blocks.properties_json, '$.alias.value') AS alias
  WHERE alias.value = ?
  ORDER BY subtree.sort_key
  LIMIT 1
`

const SELECT_BLOCKS_BY_TYPE_IN_SUBTREE_SQL = `
  ${SUBTREE_CTE_SQL}
  SELECT
    ${buildQualifiedBlockColumnsSql('blocks')}
  FROM blocks
  JOIN subtree ON subtree.id = blocks.id
  WHERE blocks.id != ?
    AND json_extract(blocks.properties_json, '$.type.value') = ?
  ORDER BY subtree.sort_key
`

const SELECT_FIRST_CHILD_BY_CONTENT_SQL = `
  SELECT
    ${buildQualifiedBlockColumnsSql('child')}
  FROM blocks AS parent
  JOIN json_each(parent.child_ids_json) AS child_order
  JOIN blocks AS child ON child.id = child_order.value
  WHERE parent.id = ?
    AND child.content = ?
  ORDER BY CAST(child_order.key AS INTEGER)
  LIMIT 1
`

export class Repo {
  static nextInstanceId = 1

  private readonly blockCache = new Map<string, Block>()
  private readonly snapshotCache = new Map<string, BlockData>()
  private readonly snapshotRevisions = new Map<string, number>()
  private readonly snapshotListeners = new Map<string, Set<() => void>>()
  private readonly dirtyBlockIds = new Set<string>()
  private readonly pendingLoads = new Map<string, Promise<BlockData | undefined>>()
  private lastProcessedBlockEventSeq = 0
  private writeQueue = Promise.resolve()
  readonly instanceId = Repo.nextInstanceId++

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

  async findFirstRootBlockId() {
    const row = await this.db.getOptional<{id: string}>(
      `
        SELECT id
        FROM blocks
        WHERE parent_id IS NULL
        ORDER BY create_time ASC, id ASC
        LIMIT 1
      `,
    )

    return row?.id
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
    this.queueUpsert(snapshot, eventContext)
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

  async getSubtreeBlockData(
    rootId: string,
    options: {includeRoot?: boolean} = {},
  ) {
    const includeRoot = options.includeRoot ?? false
    await this.flush()

    const rows = await this.db.getAll<BlockRow>(
      buildSelectSubtreeBlocksSql(includeRoot),
      includeRoot ? [rootId] : [rootId, rootId],
    )
    return this.hydrateRows(rows)
  }

  async getSubtreeBlocks(
    rootId: string,
    options: {includeRoot?: boolean} = {},
  ) {
    const snapshots = await this.getSubtreeBlockData(rootId, options)
    return snapshots.map(snapshot => this.find(snapshot.id))
  }

  async getBlockDataAt(id: string, timestamp: number) {
    const row = await this.db.getOptional<BlockEventStateRow>(
      SELECT_BLOCK_STATE_AT_SQL,
      [id, timestamp],
    )
    return parseBlockSnapshotJson(row?.afterJson)
  }

  async getSubtreeBlockDataAt(
    rootId: string,
    timestamp: number,
    options: {includeRoot?: boolean} = {},
  ) {
    const includeRoot = options.includeRoot ?? false
    const rows = await this.db.getAll<BlockEventStateRow>(
      SELECT_ALL_BLOCK_STATES_AT_SQL,
      [timestamp],
    )

    const snapshots = rows
      .map(row => parseBlockSnapshotJson(row.afterJson))
      .filter((snapshot): snapshot is BlockData => Boolean(snapshot))
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

    const rows = await this.db.getAll<BlockRow>(
      SELECT_BLOCKS_BY_TYPE_IN_SUBTREE_SQL,
      [rootId, rootId, type],
    )
    return this.hydrateRows(rows)
  }

  async getAliasesInSubtree(rootId: string, filter: string = '') {
    await this.flush()

    const rows = await this.db.getAll<{alias: string}>(
      SELECT_ALIASES_IN_SUBTREE_SQL,
      [rootId, filter, filter],
    )
    return rows.map(row => row.alias)
  }

  async findBlockByAliasInSubtree(rootId: string, alias: string) {
    if (!alias) return null

    await this.flush()

    const row = await this.db.getOptional<BlockRow>(
      SELECT_BLOCK_BY_ALIAS_IN_SUBTREE_SQL,
      [rootId, alias],
    )
    if (!row) return null

    this.hydrateRow(row)
    return this.find(row.id)
  }

  async findFirstChildByContent(parentId: string, content: string) {
    await this.flush()

    const row = await this.db.getOptional<BlockRow>(
      SELECT_FIRST_CHILD_BY_CONTENT_SQL,
      [parentId, content],
    )
    if (!row) return null

    this.hydrateRow(row)
    return this.find(row.id)
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
    this.queueUpsert(next, eventContext)
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
        this.queueUpsert(change.snapshot, eventContext)
      } else {
        this.deleteCachedBlockData(change.id)
        this.queueDelete(change.id, eventContext)
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

  private hydrateRows(rows: BlockRow[]) {
    return rows.map(row => this.hydrateRow(row))
  }

  private hydrateRow(row: BlockRow) {
    const snapshot = parseBlockRow(row)
    this.hydrateBlockData(snapshot)
    return this.requireCachedBlockData(row.id)
  }

  private queueUpsert(snapshot: BlockData, eventContext: WriteEventContext) {
    const next = cloneBlockData(snapshot)
    this.writeQueue = this.writeQueue
      .then(async () => {
        await this.executeWithEventContext(eventContext, (tx) =>
          tx.execute(UPSERT_BLOCK_SQL, blockToRowParams(next)),
        )
      })
      .catch((error) => {
        console.error(`Failed to persist block ${next.id}`, error)
      })
  }

  private queueDelete(id: string, eventContext: WriteEventContext) {
    this.writeQueue = this.writeQueue
      .then(async () => {
        await this.executeWithEventContext(eventContext, (tx) =>
          tx.execute('DELETE FROM blocks WHERE id = ?', [id]),
        )
      })
      .catch((error) => {
        console.error(`Failed to delete block ${id}`, error)
      })
  }

  private async executeWithEventContext(
    eventContext: WriteEventContext,
    callback: (tx: {execute: (sql: string, params?: unknown[]) => Promise<unknown>}) => Promise<unknown>,
  ) {
    await this.db.writeLock(async (tx) => {
      await tx.execute('DELETE FROM block_event_context WHERE id = 1')
      await tx.execute(
        `
          INSERT INTO block_event_context (id, tx_id, source, actor_user_id)
          VALUES (1, ?, ?, ?)
        `,
        [eventContext.txId, eventContext.source, eventContext.actorUserId ?? null],
      )

      try {
        await callback(tx)
      } finally {
        await tx.execute('DELETE FROM block_event_context WHERE id = 1')
      }
    })
  }

  private async getLatestBlockEventSeq() {
    const row = await this.db.get<{seq: number}>(SELECT_MAX_BLOCK_EVENT_SEQ_SQL)
    return row.seq
  }

  private async refreshTrackedBlocksFromEventLog() {
    const events = await this.db.getAll<BlockEventChangeRow>(
      SELECT_BLOCK_EVENTS_AFTER_SQL,
      [this.lastProcessedBlockEventSeq],
    )
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

    const rows = await this.db.getAll<BlockRow>(
      buildSelectBlocksByIdsSql(changedIds.length),
      changedIds,
    )
    const rowsById = new Map(rows.map(row => [row.id, row]))

    for (const id of changedIds) {
      const row = rowsById.get(id)

      if (row) {
        this.hydrateBlockData(parseBlockRow(row))
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
      this.lastProcessedBlockEventSeq = await this.getLatestBlockEventSeq()

      this.db.onChange({
        onChange: async () => {
          await this.refreshTrackedBlocksFromEventLog()
        },
        onError: (error) => {
          console.error('Failed to process reactive block change', error)
        },
      }, {
        tables: ['block_events'],
        throttleMs: 16,
      })

      await this.refreshTrackedBlocksFromEventLog()
    } catch (error) {
      console.error('Failed to start reactive block tracking', error)
    }
  }
}
