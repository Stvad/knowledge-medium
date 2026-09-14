/**
 * A fake database with the SAME LAYERS production has: a connection pool, the
 * library's own `DBAdapterDefaultMixin` over it, our occupancy instrumentation,
 * and a `PowerSyncDatabase`-shaped surface that delegates to the adapter the
 * way `AbstractPowerSyncDatabase` does.
 *
 * The layering is the point. Occupancy is counted at the adapter, so a fake
 * that answered `getAll` directly would never occupy the pool — every read
 * would classify as having had the database to itself and every assertion about
 * contention would pass with the instrumentation deleted. Building on the real
 * mixin also means a PowerSync upgrade that reroutes a method away from the
 * locks shows up here rather than as a silent under-count.
 */
import {
  DBAdapterDefaultMixin,
  type DBAdapter,
  type LockContext,
  type Transaction,
} from '@powersync/common'
import { instrumentAdapter } from '@/data/internals/poolInstrumentation.js'
import { DbContention } from '@/data/internals/timingMetrics.js'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface FakeAdapter {
  adapter: DBAdapter
  /** Which lock each call arrived through, in order — how a test says "this
   *  method did reach a connection, and by which door". */
  locks: string[]
  /** Every statement run through a lock context, as `<lock>:<method>:<sql>`. */
  sql: string[]
}

/** Every statement sleeps 1ms so overlap is observable without fake timers. */
const lockContext = (sql: string[], lock: string): LockContext => {
  const run = async <T>(method: string, statement: string, result: T): Promise<T> => {
    sql.push(`${lock}:${method}:${statement}`)
    await sleep(1)
    return result
  }
  return {
    execute: (s: string) => run('execute', s, {rowsAffected: 0}),
    executeRaw: (s: string) => run('executeRaw', s, [] as unknown[][]),
    executeBatch: (s: string) => run('executeBatch', s, {rowsAffected: 0}),
    getAll: <T>(s: string) => run('getAll', s, [{sql: s}] as unknown as T[]),
    getOptional: <T>(s: string) => run('getOptional', s, {sql: s} as unknown as T),
    get: <T>(s: string) => run('get', s, {sql: s} as unknown as T),
  }
}

/** An uninstrumented adapter over a fake connection pool. */
export const makeFakeAdapter = (): FakeAdapter => {
  const locks: string[] = []
  const sql: string[] = []
  // Reached through `this`, deliberately: the real pool finds its connections
  // on its own instance, so a wrapper that invoked these as bare references
  // would break in production while a closure-based fake stayed green.
  class Pool {
    name = 'fake.db'
    readonly locks = locks
    readonly sql = sql
    close() {}
    async refreshSchema() {}
    registerListener() { return () => {} }
    async readLock<T>(fn: (tx: LockContext) => Promise<T>): Promise<T> {
      this.locks.push('read')
      return fn(lockContext(this.sql, 'read'))
    }
    async writeLock<T>(fn: (tx: LockContext) => Promise<T>): Promise<T> {
      this.locks.push('write')
      return fn(lockContext(this.sql, 'write'))
    }
  }
  const Adapter = DBAdapterDefaultMixin(Pool)
  return {adapter: new Adapter() as unknown as DBAdapter, locks, sql}
}

/** The status surface `watchSyncOccupancy` reads, shaped as PowerSync's. */
export interface FakeSyncChannel {
  currentStatus?: unknown
  registerListener?: (l: {statusChanged?: (s: unknown) => void}) => () => void
}

export interface FakeStack extends FakeAdapter {
  /** `PowerSyncDatabase`-shaped, for `wrapDbWithMetrics`. */
  db: Record<string, unknown>
  /** Fed by the instrumented adapter. Pass to `new DbMetrics(pool)`. */
  pool: DbContention
  /** Push a `dataFlowStatus` transition at whatever registered a listener. */
  setSyncStatus: (flow: {downloading?: boolean; uploading?: boolean}) => void
}

/**
 * The whole stack. `syncing` seeds the status a listener sees when it attaches,
 * matching a database already mid-sync when the Repo is built; omit it for a
 * database with a status channel that has reported nothing yet, and pass
 * `withSyncChannel: false` for one that has no channel at all (a local-only
 * session, where zero sync intervals means something different).
 */
export const makeFakeStack = (opts: {
  syncing?: {downloading?: boolean; uploading?: boolean}
  withSyncChannel?: boolean
} = {}): FakeStack => {
  const pool = new DbContention()
  const fake = makeFakeAdapter()
  const adapter = instrumentAdapter(fake.adapter, pool)

  // Delegating exactly as `AbstractPowerSyncDatabase` does — every method to
  // `this.database.<same method>` — so the call reaches a connection by the
  // same route it does in production.
  const db: Record<string, unknown> = {
    getAll: <T>(sql: string, params?: unknown[]) => adapter.getAll<T>(sql, params as never),
    getOptional: <T>(sql: string, params?: unknown[]) => adapter.getOptional<T>(sql, params as never),
    get: <T>(sql: string, params?: unknown[]) => adapter.get<T>(sql, params as never),
    execute: (sql: string, params?: unknown[]) => adapter.execute(sql, params as never),
    writeTransaction: <R>(fn: (tx: Transaction) => Promise<R>, options?: unknown) =>
      adapter.writeTransaction(fn, options as never),
    writeLock: <R>(fn: (tx: LockContext) => Promise<R>, options?: unknown) =>
      adapter.writeLock(fn, options as never),
    readLock: <R>(fn: (tx: LockContext) => Promise<R>, options?: unknown) =>
      adapter.readLock(fn, options as never),
  }

  let notify: ((s: unknown) => void) | undefined
  if (opts.withSyncChannel !== false) {
    const channel = db as FakeSyncChannel
    channel.currentStatus = opts.syncing ? {dataFlowStatus: opts.syncing} : undefined
    channel.registerListener = (l) => {
      notify = l.statusChanged
      return () => {}
    }
  }

  return {
    ...fake,
    adapter,
    db,
    pool,
    setSyncStatus: (flow) => notify?.({dataFlowStatus: flow}),
  }
}
