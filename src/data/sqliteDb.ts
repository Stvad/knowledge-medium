import SQLiteESMFactory from '@journeyapps/wa-sqlite/dist/wa-sqlite.mjs'
import * as SQLite from '@journeyapps/wa-sqlite'
import { OPFSCoopSyncVFS } from '@journeyapps/wa-sqlite/src/examples/OPFSCoopSyncVFS.js'
import type {
  LocalDb,
  LocalDbChangeHandler,
  LocalDbChangeOptions,
} from '@/data/internals/commitPipeline'
import type { TxDb } from '@/data/internals/txEngine'

type SqliteValue = number | string | Uint8Array | number[] | bigint | null

type Listener = {
  handler: LocalDbChangeHandler
  options?: LocalDbChangeOptions
}

let sqliteApiPromise: Promise<{
  module: unknown
  sqlite3: SQLiteAPI
}> | null = null

const getSqliteApi = async () => {
  sqliteApiPromise ??= (async () => {
    const module = await SQLiteESMFactory()
    return {
      module,
      sqlite3: SQLite.Factory(module),
    }
  })()
  return sqliteApiPromise
}

const normalizeParam = (value: unknown): SqliteValue => {
  if (value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'string' ||
    typeof value === 'bigint' ||
    value instanceof Uint8Array
  ) {
    return value
  }
  if (Array.isArray(value) && value.every(item => typeof item === 'number')) {
    return value
  }
  throw new Error(`Unsupported SQLite parameter type: ${typeof value}`)
}

const rowFromStatement = <T,>(sqlite3: SQLiteAPI, stmt: number): T => {
  const columns = sqlite3.column_names(stmt)
  const values = sqlite3.row(stmt)
  return Object.fromEntries(columns.map((column: string, index: number) => [column, values[index]])) as T
}

export class BrowserSqliteDb implements LocalDb {
  private readonly sqlite3: SQLiteAPI
  private readonly db: number
  private readonly vfs: SQLiteVFS
  private readonly listeners = new Set<Listener>()
  private chain: Promise<void> = Promise.resolve()
  private closed = false

  constructor(sqlite3: SQLiteAPI, db: number, vfs: SQLiteVFS) {
    this.sqlite3 = sqlite3
    this.db = db
    this.vfs = vfs
  }

  static async open(filename: string): Promise<BrowserSqliteDb> {
    const {module, sqlite3} = await getSqliteApi()
    const vfs = await OPFSCoopSyncVFS.create('knowledge-medium-opfs', module)
    sqlite3.vfs_register(vfs, true)
    const db = await sqlite3.open_v2(filename, undefined, vfs.name)
    return new BrowserSqliteDb(sqlite3, db, vfs)
  }

  async writeTransaction<R>(fn: (tx: TxDb) => Promise<R>): Promise<R> {
    return this.enqueue(async () => {
      await this.rawExecute('BEGIN IMMEDIATE')
      try {
        const value = await fn(this.unlockedDb)
        await this.rawExecute('COMMIT')
        this.notify()
        return value
      } catch (error) {
        await this.rawExecute('ROLLBACK').catch(() => {})
        throw error
      }
    })
  }

  async getAll<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.enqueue(() => this.rawGetAll<T>(sql, params))
  }

  async getOptional<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    return this.enqueue(async () => {
      const rows = await this.rawGetAll<T>(sql, params)
      return rows[0] ?? null
    })
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T> {
    const row = await this.getOptional<T>(sql, params)
    if (row === null) {
      throw new Error(`SQLite query returned no rows: ${sql}`)
    }
    return row
  }

  async execute(sql: string, params: unknown[] = []): Promise<unknown> {
    return this.enqueue(async () => {
      await this.rawExecute(sql, params)
      this.notify()
    })
  }

  onChange(
    handler: LocalDbChangeHandler,
    options?: LocalDbChangeOptions,
  ): () => void {
    const listener = {handler, options}
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async close(): Promise<void> {
    await this.enqueue(async () => {
      if (this.closed) return
      this.closed = true
      await this.sqlite3.close(this.db)
      await this.vfs.close()
      this.listeners.clear()
    })
  }

  private readonly unlockedDb: TxDb = {
    execute: (sql: string, params?: unknown[]) => this.rawExecute(sql, params ?? []),
    getAll: <T,>(sql: string, params?: unknown[]) => this.rawGetAll<T>(sql, params ?? []),
    getOptional: async <T,>(sql: string, params?: unknown[]) => {
      const rows = await this.rawGetAll<T>(sql, params ?? [])
      return rows[0] ?? null
    },
    get: async <T,>(sql: string, params?: unknown[]) => {
      const rows = await this.rawGetAll<T>(sql, params ?? [])
      const row = rows[0]
      if (!row) throw new Error(`SQLite query returned no rows: ${sql}`)
      return row
    },
  }

  private async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async rawExecute(sql: string, params: unknown[] = []): Promise<void> {
    if (this.closed) throw new Error('SQLite database is closed')
    if (params.length === 0) {
      await this.sqlite3.exec(this.db, sql)
      return
    }
    for await (const stmt of this.sqlite3.statements(this.db, sql)) {
      this.sqlite3.bind_collection(stmt, params.map(normalizeParam))
      while (await this.sqlite3.step(stmt) === SQLite.SQLITE_ROW) {
        // Drain rows from statements executed through execute().
      }
    }
  }

  private async rawGetAll<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (this.closed) throw new Error('SQLite database is closed')
    const rows: T[] = []
    for await (const stmt of this.sqlite3.statements(this.db, sql)) {
      if (params.length > 0) {
        this.sqlite3.bind_collection(stmt, params.map(normalizeParam))
      }
      while (await this.sqlite3.step(stmt) === SQLite.SQLITE_ROW) {
        rows.push(rowFromStatement<T>(this.sqlite3, stmt))
      }
    }
    return rows
  }

  private notify(): void {
    for (const {handler} of this.listeners) {
      Promise.resolve(handler.onChange()).catch(error => {
        handler.onError?.(error)
      })
    }
  }
}
