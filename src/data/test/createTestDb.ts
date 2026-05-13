/**
 * Real SQLite test harness for the data-layer redesign.
 *
 * Spins up a node:sqlite database with the same async interface as the
 * browser wa-sqlite adapter. Tests for `Repo` / `Tx` / tree CTEs run against
 * this — same schema, same triggers and side indexes, and the same
 * rollback-on-throw `writeTransaction` contract production relies on.
 */

import { createHash } from 'node:crypto'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL,
  CREATE_BLOCKS_TABLE_SQL,
  CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL,
} from '@/data/blockSchema'
import {
  CLIENT_SCHEMA_STATEMENTS,
  backfillBlockAliasesIfEmpty,
  backfillBlockTypesIfEmpty,
} from '@/data/internals/clientSchema'
import type {
  LocalDb,
  LocalDbChangeHandler,
  LocalDbChangeOptions,
} from '@/data/internals/commitPipeline'
import type { TxDb } from '@/data/internals/txEngine'
import {
  applyLocalSchemaContributions,
  resolveLocalSchemaContributions,
} from '@/data/localSchema.ts'
import { staticDataExtensions } from '@/extensions/staticDataExtensions.ts'

export interface TestDb {
  db: LocalDb
  cleanup: () => Promise<void>
}

const localSchemaContributions = resolveLocalSchemaContributions(staticDataExtensions)

type Listener = {
  handler: LocalDbChangeHandler
  options?: LocalDbChangeOptions
}

const normalizeParam = (value: unknown): SQLInputValue => {
  if (value === undefined || value === null) return null
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    value instanceof Uint8Array
  ) {
    return value
  }
  if (typeof value === 'boolean') return value ? 1 : 0
  throw new Error(`Unsupported SQLite parameter type: ${typeof value}`)
}

const normalizeParams = (params: unknown[]): SQLInputValue[] =>
  params.map(normalizeParam)

class NodeSqliteDb implements LocalDb {
  private readonly db: DatabaseSync
  private readonly listeners = new Set<Listener>()
  private chain: Promise<void> = Promise.resolve()
  private closed = false

  constructor(filename: string) {
    this.db = new DatabaseSync(filename)
  }

  async writeTransaction<R>(fn: (tx: TxDb) => Promise<R>): Promise<R> {
    return this.enqueue(async () => {
      this.ensureOpen()
      this.db.prepare('BEGIN IMMEDIATE').run()
      try {
        const result = await fn(this.txDb)
        this.db.prepare('COMMIT').run()
        this.notify()
        return result
      } catch (error) {
        this.db.prepare('ROLLBACK').run()
        throw error
      }
    })
  }

  async getAll<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.enqueue(async () => {
      this.ensureOpen()
      return this.db.prepare(sql).all(...normalizeParams(params)) as T[]
    })
  }

  async getOptional<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    return this.enqueue(async () => {
      this.ensureOpen()
      return (this.db.prepare(sql).get(...normalizeParams(params)) as T | undefined) ?? null
    })
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T> {
    const row = await this.getOptional<T>(sql, params)
    if (row === null) throw new Error(`SQLite query returned no rows: ${sql}`)
    return row
  }

  async execute(sql: string, params: unknown[] = []): Promise<unknown> {
    return this.enqueue(async () => {
      this.ensureOpen()
      if (params.length === 0) {
        this.db.exec(sql)
      } else {
        this.db.prepare(sql).run(...normalizeParams(params))
      }
      this.notify()
      return undefined
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
      this.listeners.clear()
      this.db.close()
    })
  }

  private readonly txDb: TxDb = {
    execute: async (sql, params = []) => {
      if (params.length === 0) {
        this.db.exec(sql)
      } else {
      this.db.prepare(sql).run(...normalizeParams(params))
      }
    },
    getAll: async <T,>(sql: string, params: unknown[] = []) =>
      this.db.prepare(sql).all(...normalizeParams(params)) as T[],
    getOptional: async <T,>(sql: string, params: unknown[] = []) =>
      (this.db.prepare(sql).get(...normalizeParams(params)) as T | undefined) ?? null,
    get: async <T,>(sql: string, params: unknown[] = []) => {
      const row = this.db.prepare(sql).get(...normalizeParams(params)) as T | undefined
      if (!row) throw new Error(`SQLite query returned no rows: ${sql}`)
      return row
    },
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('SQLite database is closed')
  }

  private async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private notify(): void {
    for (const {handler} of this.listeners) {
      Promise.resolve(handler.onChange()).catch(error => {
        handler.onError?.(error)
      })
    }
  }
}

const initializeTestDb = async (dbFile: string): Promise<NodeSqliteDb> => {
  const db = new NodeSqliteDb(dbFile)
  await db.execute(CREATE_BLOCKS_TABLE_SQL)
  await db.execute(CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL)
  await db.execute(CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL)
  for (const stmt of CLIENT_SCHEMA_STATEMENTS) {
    await db.execute(stmt)
  }

  const backfillDb = {
    execute: (sql: string) => db.execute(sql),
    getOptional: async <T,>(sql: string) => {
      const row = await db.getOptional<T>(sql)
      return row ?? null
    },
  }
  await backfillBlockAliasesIfEmpty(backfillDb)
  await backfillBlockTypesIfEmpty(backfillDb)
  await applyLocalSchemaContributions(
    backfillDb,
    localSchemaContributions,
  )

  return db
}

let templateDbDirPromise: Promise<string> | null = null
const TEMPLATE_READY_FILE = '.ready'

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

const getTemplateFingerprint = (): string => {
  const hash = createHash('sha256')
  hash.update(process.cwd())
  hash.update('\0')
  hash.update(CREATE_BLOCKS_TABLE_SQL)
  hash.update('\0')
  hash.update(CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL)
  hash.update('\0')
  hash.update(CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL)
  hash.update('\0')
  hash.update(CLIENT_SCHEMA_STATEMENTS.join('\0'))
  hash.update('\0')
  hash.update(JSON.stringify(localSchemaContributions.map(contribution => ({
    statements: contribution.statements ?? [],
    triggerNames: contribution.triggerNames ?? [],
  }))))
  return hash.digest('hex').slice(0, 20)
}

const waitForTemplateReadyOrLockRelease = async (
  templateDir: string,
  lockDir: string,
): Promise<boolean> => {
  const readyFile = join(templateDir, TEMPLATE_READY_FILE)
  const startedAt = Date.now()
  while (!existsSync(readyFile)) {
    if (!existsSync(lockDir)) return false
    if (Date.now() - startedAt > 15_000) {
      throw new Error(`[createTestDb] timed out waiting for template DB at ${templateDir}`)
    }
    await sleep(10)
  }
  return true
}

const ensureTemplateDbDir = async (): Promise<string> => {
  templateDbDirPromise ??= (async () => {
    const cacheDir = join(tmpdir(), 'electric-test-template-cache')
    mkdirSync(cacheDir, {recursive: true})
    const templateDir = join(cacheDir, getTemplateFingerprint())
    const readyFile = join(templateDir, TEMPLATE_READY_FILE)
    if (existsSync(readyFile)) return templateDir

    const lockDir = `${templateDir}.lock`
    for (;;) {
      try {
        mkdirSync(lockDir)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (await waitForTemplateReadyOrLockRelease(templateDir, lockDir)) return templateDir
      }
    }

    const dbDir = mkdtempSync(join(cacheDir, 'building-'))
    const dbFile = join(dbDir, 'test.db')
    let db: NodeSqliteDb | null = null
    try {
      rmSync(templateDir, {recursive: true, force: true})
      db = await initializeTestDb(dbFile)
      await db.close()
      writeFileSync(join(dbDir, TEMPLATE_READY_FILE), '')
      renameSync(dbDir, templateDir)
      return templateDir
    } catch (error) {
      if (db) await db.close().catch(() => {})
      rmSync(dbDir, {recursive: true, force: true})
      throw error
    } finally {
      rmSync(lockDir, {recursive: true, force: true})
    }
  })()
  return templateDbDirPromise
}

const copyTemplateDb = (templateDir: string, dbDir: string): void => {
  for (const entry of readdirSync(templateDir)) {
    if (entry === TEMPLATE_READY_FILE) continue
    cpSync(join(templateDir, entry), join(dbDir, entry), {recursive: true, force: true})
  }
}

/** Open an in-tmpdir SQLite database with the production blocks table + the
 *  v2 client schema applied. */
export const createTestDb = async (): Promise<TestDb> => {
  const templateDir = await ensureTemplateDbDir()
  const dbDir = mkdtempSync(join(tmpdir(), 'electric-test-'))
  copyTemplateDb(templateDir, dbDir)
  const db = new NodeSqliteDb(join(dbDir, 'test.db'))

  return {
    db,
    cleanup: async () => {
      await db.close()
      rmSync(dbDir, {recursive: true, force: true})
    },
  }
}
