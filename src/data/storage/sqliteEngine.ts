import {
  WASQLiteOpenFactory,
  type AsyncDatabaseConnection,
  type ProxiedQueryResult,
  type BatchedUpdateNotification,
  type UpdateNotification,
} from '@powersync/web'
import { runMigrations } from './migrations'
import type {
  BlockStore,
  PropertyStore,
  ReferenceStore,
  ChangeSession,
  BlockSnapshot,
  PropertyRecord,
  ReferenceRecord,
  BlockIdentifier,
  LiveQueryHandle,
  StorageEngine,
  QueryResult,
} from './interfaces'
import type { BlockData } from '@/types'

type SqlParams = unknown[]
type TableChange = BatchedUpdateNotification | UpdateNotification

const ORDER_PAD = 16
const ORDER_START = 1n

interface SqliteExecutor {
  run(sql: string, params?: SqlParams): Promise<ProxiedQueryResult>
  query<T>(sql: string, params: SqlParams, mapper: (row: any) => T): Promise<QueryResult<T>>
  ensureWorkspace(workspaceId: string): Promise<void>
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `blk_${Math.random().toString(36).slice(2, 12)}`
}

function encodeOrderKey(value: bigint): string {
  const str = value.toString()
  return str.padStart(ORDER_PAD, '0')
}

function decodeOrderKey(value: string): bigint {
  try {
    return BigInt(value)
  } catch {
    return ORDER_START
  }
}

function mapBlockRow(row: any): BlockSnapshot {
  return {
    workspaceId: row.workspace_id as string,
    blockId: row.id as string,
    parentId: row.parent_id ?? null,
    orderKey: row.order_key as string,
    content: row.content as string,
    createTime: Number(row.create_time),
    updateTime: Number(row.update_time),
    createdByUserId: row.created_by_user_id as string,
    updatedByUserId: row.updated_by_user_id as string,
    isDeleted: Number(row.is_deleted) === 1,
  }
}

function mapPropertyRow(row: any): PropertyRecord {
  return {
    workspaceId: row.workspace_id as string,
    blockId: row.block_id as string,
    name: row.name as string,
    type: row.type as PropertyRecord['type'],
    valueJson: row.value_json ?? null,
    changeScope: row.change_scope ?? null,
  }
}

function mapReferenceRow(row: any): ReferenceRecord {
  return {
    workspaceId: row.workspace_id as string,
    blockId: row.block_id as string,
    targetWorkspaceId: row.target_workspace_id as string,
    targetId: row.target_id as string,
    refType: row.ref_type as string,
    origin: row.origin as ReferenceRecord['origin'],
    alias: row.alias ?? null,
    spanStart: row.span_start ?? null,
    spanEnd: row.span_end ?? null,
    sourcePropertyName: row.source_property_name ?? null,
    sourcePropertyPath: row.source_property_path ?? '',
    ordinal: row.ordinal ?? null,
    metaJson: row.meta_json ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

class SqliteBlockStore implements BlockStore {
  constructor(private readonly exec: SqliteExecutor) {}

  async getBlock(identifier: BlockIdentifier): Promise<BlockSnapshot | null> {
    const result = await this.exec.query<BlockSnapshot>(
      `SELECT *
       FROM blocks
       WHERE workspace_id = ? AND id = ?
       LIMIT 1`,
      [identifier.workspaceId, identifier.blockId],
      mapBlockRow
    )
    return result.rows[0] ?? null
  }

  async listChildren(parent: BlockIdentifier | { workspaceId: string; parentId: string | null }): Promise<BlockSnapshot[]> {
    const workspaceId = 'blockId' in parent ? parent.workspaceId : parent.workspaceId
    const parentId = 'blockId' in parent ? parent.blockId : parent.parentId ?? null
    const params: SqlParams = parentId === null ? [workspaceId] : [workspaceId, parentId]
    const result = await this.exec.query<BlockSnapshot>(
      parentId === null
        ? `SELECT *
           FROM blocks
           WHERE workspace_id = ?
             AND parent_id IS NULL
             AND is_deleted = 0
           ORDER BY order_key`
        : `SELECT *
           FROM blocks
           WHERE workspace_id = ?
             AND parent_id = ?
             AND is_deleted = 0
           ORDER BY order_key`,
      params,
      mapBlockRow
    )
    return result.rows
  }

  async createBlock(
    data: Partial<BlockData> & { workspaceId: string; parentId?: string | null; orderKey?: string }
  ): Promise<BlockSnapshot> {
    const workspaceId = data.workspaceId
    await this.exec.ensureWorkspace(workspaceId)

    const id = data.id ?? generateId()
    const parentId = data.parentId ?? null
    const createTime = data.createTime ?? Date.now()
    const updateTime = data.updateTime ?? createTime
    const createdBy = data.createdByUserId ?? 'system'
    const updatedBy = data.updatedByUserId ?? createdBy
    const content = data.content ?? ''
    const orderKey = data.orderKey ?? (await this.nextOrderKey(workspaceId, parentId))

    await this.exec.run(
      `INSERT INTO blocks (
        workspace_id, id, parent_id, order_key, content,
        create_time, update_time, created_by_user_id, updated_by_user_id, is_deleted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [workspaceId, id, parentId, orderKey, content, createTime, updateTime, createdBy, updatedBy]
    )

    const snapshot = await this.getBlock({ workspaceId, blockId: id })
    if (!snapshot) {
      throw new Error(`Failed to load block after insert (${workspaceId}/${id})`)
    }
    return snapshot
  }

  async updateBlock(identifier: BlockIdentifier, patch: Partial<Omit<BlockSnapshot, keyof BlockIdentifier>>): Promise<void> {
    const assignments: string[] = []
    const params: SqlParams = []

    const setField = (column: string, value: unknown) => {
      assignments.push(`${column} = ?`)
      params.push(value)
    }

    if (patch.parentId !== undefined) setField('parent_id', patch.parentId)
    if (patch.orderKey !== undefined) setField('order_key', patch.orderKey)
    if (patch.content !== undefined) setField('content', patch.content)
    if (patch.createTime !== undefined) setField('create_time', patch.createTime)
    if (patch.updateTime !== undefined) setField('update_time', patch.updateTime)
    if (patch.createdByUserId !== undefined) setField('created_by_user_id', patch.createdByUserId)
    if (patch.updatedByUserId !== undefined) setField('updated_by_user_id', patch.updatedByUserId)
    if (patch.isDeleted !== undefined) setField('is_deleted', patch.isDeleted ? 1 : 0)

    if (!assignments.length) return

    params.push(identifier.workspaceId, identifier.blockId)
    await this.exec.run(
      `UPDATE blocks
       SET ${assignments.join(', ')}
       WHERE workspace_id = ? AND id = ?`,
      params
    )
  }

  async markDeleted(identifier: BlockIdentifier): Promise<void> {
    await this.updateBlock(identifier, {
      isDeleted: true,
      updateTime: Date.now(),
    })
  }

  private async nextOrderKey(workspaceId: string, parentId: string | null): Promise<string> {
    const params: SqlParams = parentId === null ? [workspaceId] : [workspaceId, parentId]
    const latest = await this.exec.query<string>(
      parentId === null
        ? `SELECT order_key
           FROM blocks
           WHERE workspace_id = ?
             AND parent_id IS NULL
           ORDER BY order_key DESC
           LIMIT 1`
        : `SELECT order_key
           FROM blocks
           WHERE workspace_id = ?
             AND parent_id = ?
           ORDER BY order_key DESC
           LIMIT 1`,
      params,
      (row) => row.order_key as string
    )
    const lastKey = latest.rows[0]
    if (!lastKey) return encodeOrderKey(ORDER_START)
    const nextValue = decodeOrderKey(lastKey) + 1n
    return encodeOrderKey(nextValue)
  }
}

class SqlitePropertyStore implements PropertyStore {
  constructor(private readonly exec: SqliteExecutor) {}

  async list(block: BlockIdentifier): Promise<PropertyRecord[]> {
    const result = await this.exec.query<PropertyRecord>(
      `SELECT *
       FROM block_properties
       WHERE workspace_id = ? AND block_id = ?
       ORDER BY name`,
      [block.workspaceId, block.blockId],
      mapPropertyRow
    )
    return result.rows
  }

  async upsert(record: PropertyRecord): Promise<void> {
    await this.exec.ensureWorkspace(record.workspaceId)
    await this.exec.run(
      `INSERT INTO block_properties (
        workspace_id, block_id, name, type, value_json, change_scope
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, block_id, name)
      DO UPDATE SET
        type = excluded.type,
        value_json = excluded.value_json,
        change_scope = excluded.change_scope`,
      [
        record.workspaceId,
        record.blockId,
        record.name,
        record.type,
        record.valueJson,
        record.changeScope,
      ]
    )
  }

  async remove(block: BlockIdentifier, name: string): Promise<void> {
    await this.exec.run(
      `DELETE FROM block_properties
       WHERE workspace_id = ? AND block_id = ? AND name = ?`,
      [block.workspaceId, block.blockId, name]
    )
  }
}

class SqliteReferenceStore implements ReferenceStore {
  constructor(private readonly exec: SqliteExecutor) {}

  async listBySource(block: BlockIdentifier): Promise<ReferenceRecord[]> {
    const result = await this.exec.query<ReferenceRecord>(
      `SELECT *
       FROM block_refs
       WHERE workspace_id = ? AND block_id = ?
       ORDER BY ref_type, source_property_path, target_id`,
      [block.workspaceId, block.blockId],
      mapReferenceRow
    )
    return result.rows
  }

  async replaceAll(block: BlockIdentifier, records: ReferenceRecord[]): Promise<void> {
    await this.exec.run(
      `DELETE FROM block_refs
       WHERE workspace_id = ? AND block_id = ?`,
      [block.workspaceId, block.blockId]
    )

    if (!records.length) return

    for (const record of records) {
      await this.exec.run(
        `INSERT INTO block_refs (
          workspace_id,
          block_id,
          target_workspace_id,
          target_id,
          ref_type,
          origin,
          alias,
          span_start,
          span_end,
          source_property_name,
          source_property_path,
          ordinal,
          meta_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.workspaceId,
          record.blockId,
          record.targetWorkspaceId,
          record.targetId,
          record.refType,
          record.origin,
          record.alias ?? null,
          record.spanStart ?? null,
          record.spanEnd ?? null,
          record.sourcePropertyName ?? null,
          record.sourcePropertyPath ?? '',
          record.ordinal ?? null,
          record.metaJson ?? null,
          record.createdAt ?? null,
          record.updatedAt ?? null,
        ]
      )
    }
  }
}

class SqliteChangeSession implements ChangeSession {
  constructor(readonly workspaceId: string) {}

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    return await fn()
  }

  enqueueUndo(): void {
    // Undo stack will be wired after block mutations are implemented.
  }
}

class SqliteLiveQueryHandle<T> implements LiveQueryHandle<T> {
  private listeners = new Set<() => void>()
  private lastResult: QueryResult<T> = { rows: [] }

  constructor(
    private readonly engine: SqliteStorageEngine,
    readonly sql: string,
    readonly params: SqlParams,
    readonly mapper: (row: any) => T
  ) {}

  current(): QueryResult<T> {
    return this.lastResult
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.listeners.clear()
    this.engine.unregisterLiveQuery(this)
  }

  async refresh(): Promise<void> {
    this.lastResult = await this.engine.query<T>(this.sql, this.params, this.mapper)
  }

  notify(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }
}

export interface SqliteStorageOptions {
  filename: string
  location?: string
}

export class SqliteStorageEngine implements StorageEngine, SqliteExecutor {
  private connection: AsyncDatabaseConnection | null = null
  private closeSubscription: (() => void) | null = null
  private liveQueries = new Set<SqliteLiveQueryHandle<any>>()
  private openPromise: Promise<void> | null = null

  readonly blocks: BlockStore
  readonly properties: PropertyStore
  readonly references: ReferenceStore

  constructor(private readonly options: SqliteStorageOptions) {
    this.blocks = new SqliteBlockStore(this)
    this.properties = new SqlitePropertyStore(this)
    this.references = new SqliteReferenceStore(this)
  }

  async open(): Promise<void> {
    if (this.connection) return
    if (this.openPromise) {
      await this.openPromise
      return
    }

    this.openPromise = (async () => {
      const openFactory = new WASQLiteOpenFactory({
        dbFilename: this.options.filename,
        dbLocation: this.options.location,
        flags: {
          useWebWorker: false,
          enableMultiTabs: false,
        },
      })
      const connection = await openFactory.openConnection()
      await connection.init()
      await runMigrations(connection)

      const unsubscribe = await connection.registerOnTableChange((update) => {
        this.handleTableChange(update)
      })

      this.connection = connection
      this.closeSubscription = unsubscribe
    })()

    try {
      await this.openPromise
    } finally {
      this.openPromise = null
    }
  }

  async close(): Promise<void> {
    if (!this.connection) return

    if (this.closeSubscription) {
      await this.closeSubscription()
      this.closeSubscription = null
    }
    await this.connection.close()
    this.connection = null
    this.openPromise = null
    this.liveQueries.clear()
  }

  async withSession(workspaceId: string, fn: (session: ChangeSession) => Promise<void>): Promise<void> {
    await this.open()
    await this.ensureWorkspace(workspaceId)
    const session = new SqliteChangeSession(workspaceId)
    await fn(session)
  }

  async liveQuery<T>(sql: string, params: SqlParams, mapper: (row: any) => T): Promise<LiveQueryHandle<T>> {
    await this.open()
    const handle = new SqliteLiveQueryHandle<T>(this, sql, params, mapper)
    this.liveQueries.add(handle)
    await handle.refresh()
    return handle
  }

  unregisterLiveQuery(handle: SqliteLiveQueryHandle<any>): void {
    this.liveQueries.delete(handle)
  }

  async run(sql: string, params: SqlParams = []): Promise<ProxiedQueryResult> {
    const conn = await this.ensureConnection()
    return await conn.execute(sql, params)
  }

  async query<T>(sql: string, params: SqlParams, mapper: (row: any) => T): Promise<QueryResult<T>> {
    const conn = await this.ensureConnection()
    const result = await conn.execute(sql, params)
    const rows = (result.rows?._array ?? []).map(mapper)
    return {
      rows,
      updatedAt: Date.now(),
    }
  }

  async ensureWorkspace(workspaceId: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    await this.run(
      `INSERT OR IGNORE INTO workspaces (id, name, metadata_json, created_at, updated_at)
       VALUES (?, NULL, NULL, ?, ?)`,
      [workspaceId, now, now]
    )
  }

  async transaction<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    await this.open()
    await this.ensureWorkspace(workspaceId)
    const conn = await this.ensureConnection()
    await conn.execute('BEGIN')
    try {
      const result = await fn()
      await conn.execute('COMMIT')
      return result
    } catch (error) {
      await conn.execute('ROLLBACK')
      throw error
    }
  }

  private async ensureConnection(): Promise<AsyncDatabaseConnection> {
    if (!this.connection) {
      await this.open()
    }
    if (!this.connection) throw new Error('SQLite connection not opened')
    return this.connection
  }

  private handleTableChange(update: TableChange): void {
    const tables = this.extractTables(update)
    if (!tables.length) return
    for (const handle of this.liveQueries) {
      void handle.refresh().then(() => {
        handle.notify()
      })
    }
  }

  private extractTables(update: TableChange): string[] {
    if ('tables' in update) {
      return update.tables
    }
    if ('table' in update) {
      return [update.table]
    }
    return []
  }
}
