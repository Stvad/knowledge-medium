import {
  WASQLiteOpenFactory,
  type AsyncDatabaseConnection,
  type ProxiedQueryResult,
  type BatchedUpdateNotification,
  type UpdateNotification,
} from '@powersync/web'
import type { LiveQueryHandle, StorageEngine, QueryResult } from './interfaces'
import type { BlockStore, PropertyStore, ReferenceStore, ChangeSession, BlockSnapshot, PropertyRecord, ReferenceRecord } from './interfaces'

type SqlParams = unknown[]

type TableChange = BatchedUpdateNotification | UpdateNotification

export interface SqliteStorageOptions {
  filename: string
  location?: string
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

class NotImplementedBlockStore implements BlockStore {
  async getBlock(): Promise<BlockSnapshot | null> {
    throw new Error('Sqlite block store not implemented yet')
  }

  async listChildren(): Promise<BlockSnapshot[]> {
    throw new Error('Sqlite block store not implemented yet')
  }

  async createBlock(): Promise<BlockSnapshot> {
    throw new Error('Sqlite block store not implemented yet')
  }

  async updateBlock(): Promise<void> {
    throw new Error('Sqlite block store not implemented yet')
  }

  async markDeleted(): Promise<void> {
    throw new Error('Sqlite block store not implemented yet')
  }
}

class NotImplementedPropertyStore implements PropertyStore {
  async list(): Promise<PropertyRecord[]> {
    throw new Error('Sqlite property store not implemented yet')
  }

  async upsert(): Promise<void> {
    throw new Error('Sqlite property store not implemented yet')
  }

  async remove(): Promise<void> {
    throw new Error('Sqlite property store not implemented yet')
  }
}

class NotImplementedReferenceStore implements ReferenceStore {
  async listBySource(): Promise<ReferenceRecord[]> {
    throw new Error('Sqlite reference store not implemented yet')
  }

  async replaceAll(): Promise<void> {
    throw new Error('Sqlite reference store not implemented yet')
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

export class SqliteStorageEngine implements StorageEngine {
  private connection: AsyncDatabaseConnection | null = null
  private options: SqliteStorageOptions
  private closeSubscription: (() => void) | null = null
  private liveQueries = new Set<SqliteLiveQueryHandle<any>>()

  readonly blocks: BlockStore
  readonly properties: PropertyStore
  readonly references: ReferenceStore

  constructor(options: SqliteStorageOptions) {
    this.options = options
    this.blocks = new NotImplementedBlockStore()
    this.properties = new NotImplementedPropertyStore()
    this.references = new NotImplementedReferenceStore()
  }

  async open(): Promise<void> {
    if (this.connection) return

    const openFactory = new WASQLiteOpenFactory({
      dbFilename: this.options.filename,
      dbLocation: this.options.location,
    })
    const connection = await openFactory.openConnection()
    await connection.init()
    const unsubscribe = await connection.registerOnTableChange((update) => {
      this.handleTableChange(update)
    })

    this.connection = connection
    this.closeSubscription = unsubscribe
  }

  async close(): Promise<void> {
    if (!this.connection) return

    if (this.closeSubscription) {
      await this.closeSubscription()
      this.closeSubscription = null
    }
    await this.connection.close()
    this.connection = null
    this.liveQueries.clear()
  }

  async withSession(workspaceId: string, fn: (session: ChangeSession) => Promise<void>): Promise<void> {
    await this.open()
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

  private async ensureConnection(): Promise<AsyncDatabaseConnection> {
    if (!this.connection) {
      throw new Error('SQLite connection not opened')
    }
    return this.connection
  }

  private async execute(sql: string, params: SqlParams = []): Promise<ProxiedQueryResult> {
    const conn = await this.ensureConnection()
    return await conn.execute(sql, params)
  }

  async query<T>(sql: string, params: SqlParams, mapper: (row: any) => T): Promise<QueryResult<T>> {
    const result = await this.execute(sql, params)
    const rows = (result.rows?._array ?? []).map(mapper)
    return {
      rows,
      updatedAt: Date.now(),
    }
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
