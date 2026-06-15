/**
 * Idle-deferred, marker-gated maintenance jobs for the data layer.
 *
 * `Repo` runs three one-time-per-workspace maintenance passes off the
 * cold-start critical path — ref-typed-property reprojection, workspace
 * backfills, and the reconcile rescan. Each one hand-rolled the same two
 * mechanisms: a `requestIdleCallback`-with-2s-timeout scheduler tracking
 * its in-flight promises in a pending set (so tests can drain it), and a
 * lazy in-memory mirror of its completion markers in `client_schema_state`.
 *
 * This module owns both mechanisms once:
 *   - `PendingIdleJobs` — `scheduleIdle` (the shared util) + a pending-set
 *     drain barrier. One instance per job kind so each `await*` test helper
 *     drains only its own work.
 *   - `MarkerStore` — the lazy prefixed-key set: load once, then `has` /
 *     `set` / `clear` in memory + write-through to `client_schema_state`.
 */

import { scheduleIdle } from '@/utils/scheduleIdle'

/** Minimal `client_schema_state` access surface — the `PowerSyncDb`
 *  read/write calls `MarkerStore` needs, structurally typed so the store
 *  is unit-testable without a full Repo / PowerSync. */
export interface MarkerDb {
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>
  execute(sql: string, params?: unknown[]): Promise<unknown>
}

/** Tracks idle-deferred jobs so deterministic tests can wait for them.
 *  `schedule` defers `task` to the next idle frame (browser) or task tick
 *  (Node/jsdom, where fake timers advance it); the task's promise is added
 *  to the pending set when the idle callback fires and removed on settle.
 *  `drain` awaits everything whose timer has already fired — it does NOT
 *  advance timers, so fake-timer callers must bump the clock first. */
export class PendingIdleJobs {
  private readonly pending = new Set<Promise<void>>()

  /** Defer `task` to idle. Fire-and-forget: the caller's path is not
   *  blocked. The promise enters the pending set only once the idle
   *  callback runs (mirroring the historical hand-rolled behavior). */
  schedule(task: () => Promise<void>): void {
    scheduleIdle(() => {
      const p = task().finally(() => { this.pending.delete(p) })
      this.pending.add(p)
    })
  }

  /** Await every job whose deferral timer has already fired. Loops so a
   *  job that settles while we await an earlier one is still drained;
   *  terminates because these jobs never schedule further jobs. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending])
    }
  }

  get size(): number {
    return this.pending.size
  }
}

/** Lazy in-memory mirror of a prefixed family of completion markers in
 *  `client_schema_state` (e.g. all `reproject_ref:%` rows). One SQL
 *  round-trip per lifetime on first access; afterwards `has` is a pure
 *  Set lookup and `set` / `clear` write through to the table while
 *  keeping the mirror coherent. Entries are stored as the key *suffix*
 *  (everything after `prefix`); callers build the suffix (the markers are
 *  per-workspace, so it's typically `<workspaceId>:<name>`). */
export class MarkerStore {
  private cache: Set<string> | null = null

  constructor(
    private readonly db: MarkerDb,
    private readonly prefix: string,
    /** `SELECT key FROM client_schema_state WHERE key LIKE '<prefix>%'`. */
    private readonly selectSql: string,
    /** `INSERT OR REPLACE INTO client_schema_state (key, …) VALUES (?, …)`
     *  — the `?` is the full (prefixed) key. */
    private readonly recordSql: string,
    /** `DELETE FROM client_schema_state WHERE key = ?`. Omit for marker
     *  families that are only ever added (e.g. workspace backfills). */
    private readonly clearSql?: string,
  ) {}

  /** Load the marker set on first call, then keep it in-memory. Legacy
   *  keys that don't share the current suffix shape load as inert entries
   *  that never match a current lookup — the caller simply re-runs once. */
  async load(): Promise<Set<string>> {
    if (this.cache !== null) return this.cache
    const rows = await this.db.getAll<{key: string}>(this.selectSql)
    const set = new Set<string>()
    for (const r of rows) set.add(r.key.slice(this.prefix.length))
    this.cache = set
    return set
  }

  async has(suffix: string): Promise<boolean> {
    return (await this.load()).has(suffix)
  }

  async set(suffix: string): Promise<void> {
    await this.db.execute(this.recordSql, [`${this.prefix}${suffix}`])
    this.cache?.add(suffix)
  }

  async clear(suffix: string): Promise<void> {
    if (!this.clearSql) {
      throw new Error('[MarkerStore] clear() called on a store without clearSql')
    }
    await this.db.execute(this.clearSql, [`${this.prefix}${suffix}`])
    this.cache?.delete(suffix)
  }

  /** Drop the in-memory mirror so the next access re-reads from the
   *  table. Used by tests / migrations that mutate the table out-of-band. */
  reset(): void {
    this.cache = null
  }
}
